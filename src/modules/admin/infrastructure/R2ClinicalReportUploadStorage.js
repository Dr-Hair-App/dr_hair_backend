import { createHash, randomUUID } from 'node:crypto';
import { BadRequestError, PayloadTooLargeError } from '../../../shared/errors/index.js';
import { config } from '../../../config/env.js';
import { getMediaBucket } from '../../../shared/storage/runtime.js';
import { detectImageMime, hasSafeImageDimensions } from '../../media/infrastructure/R2MediaStorage.js';

const reportFormats = new Map([
  ['application/pdf', 'pdf'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.ms-powerpoint', 'ppt'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['text/plain', 'txt'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
  ['image/heic', 'heic'],
  ['image/heif', 'heif'],
]);

const oleSignature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const zipSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const zipEndSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

function zipCentralNames(tail, totalSize) {
  const index = tail.lastIndexOf(zipEndSignature);
  if (index < 0 || index + 22 > tail.length || index + 22 + tail.readUInt16LE(index + 20) !== tail.length) return null;
  const directorySize = tail.readUInt32LE(index + 12);
  const directoryOffset = tail.readUInt32LE(index + 16);
  const tailStart = totalSize - tail.length;
  const localDirectoryOffset = directoryOffset - tailStart;
  // Standard Office ZIPs have a compact central directory at EOF. Refuse ZIP64
  // or unusually large central directories instead of buffering an unbounded file.
  if (directorySize > 1024 * 1024 || localDirectoryOffset < 0 || localDirectoryOffset + directorySize > index) return null;
  const names = new Set();
  let cursor = localDirectoryOffset;
  const directoryEnd = cursor + directorySize;
  while (cursor + 46 <= directoryEnd && tail.readUInt32LE(cursor) === 0x02014b50) {
    const nameLength = tail.readUInt16LE(cursor + 28);
    const extraLength = tail.readUInt16LE(cursor + 30);
    const commentLength = tail.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (!nameLength || next > directoryEnd) return null;
    names.add(tail.subarray(nameStart, nameStart + nameLength).toString('utf8'));
    cursor = next;
  }
  return cursor === directoryEnd ? names : null;
}

export function validateReportSignature(mimeType, prefix, textIsValid = true, tail = prefix, totalSize = tail.length) {
  if (mimeType === 'application/pdf') return prefix.subarray(0, 5).toString() === '%PDF-';
  if (['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'].includes(mimeType)) {
    return prefix.subarray(0, 8).equals(oleSignature);
  }
  if (mimeType.startsWith('application/vnd.openxmlformats-officedocument.')) {
    if (!prefix.subarray(0, 4).equals(zipSignature)) return false;
    const names = zipCentralNames(tail, totalSize);
    if (!names?.has('[Content_Types].xml')) return false;
    if (mimeType.includes('wordprocessingml')) return names.has('word/document.xml');
    if (mimeType.includes('spreadsheetml')) return names.has('xl/workbook.xml');
    if (mimeType.includes('presentationml')) return names.has('ppt/presentation.xml');
    return false;
  }
  if (mimeType === 'text/plain') return textIsValid && !prefix.includes(0);
  if (mimeType.startsWith('image/')) {
    const actualMime = detectImageMime(prefix);
    return actualMime === (mimeType === 'image/jpg' ? 'image/jpeg' : mimeType) &&
      hasSafeImageDimensions(actualMime, prefix);
  }
  return false;
}

function safeOwnerId(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new BadRequestError('A valid patient is required for report upload.');
  return String(parsed);
}

export class R2ClinicalReportUploadStorage {
  _handleFile(req, file, callback) {
    const bucket = getMediaBucket();
    if (!bucket) return callback(new Error('R2 MEDIA_BUCKET is not configured.'));
    const ownerId = safeOwnerId(req.params?.userId);
    const format = reportFormats.get(file.mimetype);
    if (!format) return callback(new BadRequestError('Upload a supported PDF, Office document, text file, or image report.'));

    const id = randomUUID();
    const key = `drhair/private-reports/user-${ownerId}/${id}.${format}`;
    const limit = config.upload.maxFileSize;
    const partSize = 5 * 1024 * 1024;
    const prefixChunks = [];
    let tail = Buffer.alloc(0);
    const bufferedChunks = [];
    const parts = [];
    const hash = createHash('sha256');
    const textDecoder = file.mimetype === 'text/plain' ? new TextDecoder('utf-8', { fatal: true }) : null;
    let multipart = null;
    let size = 0;
    let currentPartSize = 0;
    let partNumber = 1;
    let textIsValid = true;
  let complete = false;
    const finish = (error, info) => {
      if (complete) return;
      complete = true;
      callback(error, info);
    };

    (async () => {
      try {
        for await (const chunk of file.stream) {
          size += chunk.length;
          if (size > limit) throw new PayloadTooLargeError('Report file exceeds the 25 MiB upload limit.');
          hash.update(chunk);
          tail = Buffer.concat([tail, chunk]);
          if (tail.length > 256 * 1024) tail = tail.subarray(tail.length - (256 * 1024));
          if (textDecoder && chunk.includes(0)) textIsValid = false;
          if (Buffer.concat(prefixChunks).length < 65536) {
            prefixChunks.push(Buffer.from(chunk.subarray(0, 65536)));
          }
          if (textDecoder) {
            try { textDecoder.decode(chunk, { stream: true }); } catch { textIsValid = false; }
          }

          let offset = 0;
          while (offset < chunk.length) {
            const take = Math.min(partSize - currentPartSize, chunk.length - offset);
            bufferedChunks.push(Buffer.from(chunk.subarray(offset, offset + take)));
            currentPartSize += take;
            offset += take;
            if (currentPartSize === partSize) {
              if (!multipart) {
                multipart = await bucket.createMultipartUpload(key, {
                  httpMetadata: { contentType: file.mimetype, cacheControl: 'private, no-store' },
                  customMetadata: {
                    purpose: 'clinical-report', ownerId, visibility: 'private',
                    scanningStatus: 'not_scanned', compression: 'none',
                  },
                });
              }
              parts.push(await multipart.uploadPart(partNumber, Buffer.concat(bufferedChunks, currentPartSize)));
              partNumber += 1;
              bufferedChunks.length = 0;
              currentPartSize = 0;
            }
          }
        }
        if (file.stream.truncated) throw new PayloadTooLargeError('Report file exceeds the 25 MiB upload limit.');
        if (textDecoder) {
          try { textDecoder.decode(); } catch { textIsValid = false; }
        }
        const prefix = Buffer.concat(prefixChunks);
        if (!size || !validateReportSignature(file.mimetype, prefix, textIsValid, tail, size)) {
          throw new BadRequestError('The report file contents do not match the selected document or image format.');
        }

        const checksum = hash.digest('hex');
        if (multipart) {
          const finalPart = Buffer.concat(bufferedChunks, currentPartSize);
          if (finalPart.length) parts.push(await multipart.uploadPart(partNumber, finalPart));
          await multipart.complete(parts);
        } else {
          const data = Buffer.concat(bufferedChunks, currentPartSize);
          await bucket.put(key, data, {
            httpMetadata: { contentType: file.mimetype, cacheControl: 'private, no-store' },
            customMetadata: {
              purpose: 'clinical-report', ownerId, visibility: 'private',
              originalBytes: String(size), sha256: checksum,
              scanningStatus: 'not_scanned', compression: 'none',
            },
          });
        }

        finish(null, {
          id, key, publicId: key, public_id: key,
          originalname: String(file.originalname || 'report').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 180),
          mimetype: file.mimetype, size, bytes: size, storedBytes: size,
          sha256: checksum, format, scanningStatus: 'not_scanned',
          compressed: false,
        });
      } catch (error) {
        if (multipart) await multipart.abort().catch(() => null);
        finish(error);
      }
    })();
  }

  _removeFile(_req, file, callback) {
    const bucket = getMediaBucket();
    if (!bucket || !file.key) return callback(null);
    bucket.delete(file.key).then(() => callback(null), callback);
  }
}

export const supportedClinicalReportMimeTypes = new Set(reportFormats.keys());
export const clinicalReportFormat = (mimeType) => reportFormats.get(mimeType) || null;
