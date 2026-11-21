import { randomUUID, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { BadRequestError, NotFoundError, PayloadTooLargeError } from '../../../shared/errors/index.js';
import { config } from '../../../config/env.js';
import { getBucketsForKey, getImageOptimizationBinding, getUploadBucket } from '../../../shared/storage/runtime.js';

const mediaPurposes = new Set(['general', 'profile', 'assessment', 'progress', 'content', 'product']);
const extFor = (mime) => ({ 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v', 'application/pdf': 'pdf' })[mime] || 'bin';
const objectKey = (key) => String(key || '').replace(/^\/+/, '').replace(/\\/g, '/');
const mimeFor = (format) => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v' })[String(format || '').toLowerCase()] || 'application/octet-stream';

export function detectImageMime(prefix) {
  const bytes = Buffer.from(prefix || []);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  const signature = bytes.subarray(0, 6).toString('ascii');
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brands = bytes.subarray(8, Math.min(bytes.length, 32)).toString('ascii');
    if (/avif|avis/.test(brands)) return 'image/avif';
    if (/heic|heix|hevc|hevx/.test(brands)) return 'image/heic';
    if (/heif|mif1|msf1/.test(brands)) return 'image/heif';
  }
  return null;
}

const isSafeImageSize = (width, height, maxPixels) => Number.isInteger(width) && Number.isInteger(height) &&
  width > 0 && height > 0 && width <= 20_000 && height <= 20_000 && width * height <= maxPixels;

/** Reads dimensions from bounded image headers without decoding image pixels. */
export function readImageDimensions(mimeType, prefix) {
  const bytes = Buffer.from(prefix || []);
  let width;
  let height;
  if (mimeType === 'image/png' && bytes.length >= 24 && bytes.subarray(12, 16).toString() === 'IHDR') {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (mimeType === 'image/gif' && bytes.length >= 10) {
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
  } else if (mimeType === 'image/jpeg' && bytes.length >= 4) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (segmentLength < 7) return false;
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += segmentLength;
    }
  } else if (mimeType === 'image/webp' && bytes.length >= 30 && bytes.subarray(0, 4).toString() === 'RIFF') {
    const chunkType = bytes.subarray(12, 16).toString();
    if (chunkType === 'VP8X' && bytes.length >= 30) {
      width = 1 + bytes.readUIntLE(24, 3);
      height = 1 + bytes.readUIntLE(27, 3);
    } else if (chunkType === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (chunkType === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
    }
  } else if (['image/avif', 'image/heic', 'image/heif'].includes(mimeType)) {
    // ISO-BMFF image properties contain `ispe`, then version/flags + dimensions.
    for (let offset = 4; offset + 16 <= bytes.length; offset += 1) {
      if (bytes.subarray(offset, offset + 4).toString() === 'ispe') {
        width = bytes.readUInt32BE(offset + 8);
        height = bytes.readUInt32BE(offset + 12);
        break;
      }
    }
  }
  return Number.isInteger(width) && Number.isInteger(height) ? { width, height } : null;
}

export function hasSafeImageDimensions(mimeType, prefix, { maxPixels = 40_000_000 } = {}) {
  const dimensions = readImageDimensions(mimeType, prefix);
  return Boolean(dimensions && isSafeImageSize(dimensions.width, dimensions.height, maxPixels));
}

const normalizedImageMime = (mime) => mime === 'image/jpg' ? 'image/jpeg' : mime;

/** One backend-only image path. Lossless WebP is kept only when it is smaller;
 * no binding, unsupported input, transform error, or larger output preserves
 * the original bytes. Cloudflare Images accepts up to 20 MB per input. */
export async function optimizeImageForStorage(buffer, mimeType, binding = getImageOptimizationBinding(), { preserveSource = false } = {}) {
  const original = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const normalizedMime = normalizedImageMime(mimeType);
  if (preserveSource || !binding || typeof binding.input !== 'function' || original.length === 0 || original.length > 20 * 1024 * 1024
    || !['image/jpeg', 'image/png', 'image/webp'].includes(normalizedMime)) {
    return { buffer: original, contentType: normalizedMime, format: extFor(normalizedMime), compressed: false, originalBytes: original.length, processingStatus: 'original_preserved' };
  }
  try {
    const output = await binding.input(original)
      .output({ format: 'image/webp', quality: 100 })
      .then((result) => result.response());
    if (!output?.ok) throw new Error('Image transform returned a non-success response.');
    const candidate = Buffer.from(await output.arrayBuffer());
    if (!candidate.length || candidate.length >= original.length || detectImageMime(candidate.subarray(0, 32)) !== 'image/webp') {
      return { buffer: original, contentType: normalizedMime, format: extFor(normalizedMime), compressed: false, originalBytes: original.length, processingStatus: 'original_preserved' };
    }
    return { buffer: candidate, contentType: 'image/webp', format: 'webp', compressed: true, originalBytes: original.length, processingStatus: 'lossless_webp' };
  } catch {
    return { buffer: original, contentType: normalizedMime, format: extFor(normalizedMime), compressed: false, originalBytes: original.length, processingStatus: 'original_preserved' };
  }
}

export async function compressLosslessly(buffer, enabled = true) {
  if (!enabled || typeof CompressionStream !== 'function' || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { buffer, compressed: false, originalBytes: buffer?.length || 0 };
  }
  const compressed = Buffer.from(await new Response(
    new Blob([buffer]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer());
  if (compressed.length >= buffer.length) {
    return { buffer, compressed: false, originalBytes: buffer.length };
  }
  return { buffer: compressed, compressed: true, originalBytes: buffer.length };
}

function sign(key, expiresAt, attachment) {
  const payload = `${objectKey(key)}:${expiresAt}:${attachment ? 1 : 0}`;
  return createHmac('sha256', config.jwt.secret).update(payload).digest('base64url');
}

export function verifyPrivateMediaSignature(key, expiresAt, attachment, signature) {
  if (!/^\d+$/.test(String(expiresAt)) || Number(expiresAt) < Math.floor(Date.now() / 1000) || Number(expiresAt) > Math.floor(Date.now() / 1000) + 3600) return false;
  const expected = Buffer.from(sign(key, Number(expiresAt), attachment));
  const supplied = Buffer.from(String(signature || ''));
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export class R2MediaStorage {
  async deleteOwnedOrphan({ publicId, resourceType, ownerId, isAdmin }) {
    const key = objectKey(publicId);
    if (resourceType !== 'image' || !key || key.length > 400 || key.includes('..')) throw new BadRequestError('Provide a valid R2 image key. Video uploads are not supported.');
    const allowedPrefixes = isAdmin
      ? ['drhair/images/admin/general/', 'drhair/images/admin/content/', 'drhair/images/admin/product/']
      : [
        `drhair/images/user-${Number(ownerId)}/general/`,
        `drhair/images/user-${Number(ownerId)}/profile/`,
        `drhair/images/profiles/user-${Number(ownerId)}.`,
      ];
    if (!allowedPrefixes.some((prefix) => key.startsWith(prefix))) throw new BadRequestError('Only your unattached media can be deleted here.');
    const buckets = getBucketsForKey(key);
    if (buckets.length === 0) throw new Error(isAdmin ? 'R2 ADMIN_MEDIA_BUCKET is not configured.' : 'R2 USER_MEDIA_BUCKET is not configured.');
    let bucket = null;
    let asset = null;
    for (const candidate of buckets) {
      asset = await candidate.head(key);
      if (asset) { bucket = candidate; break; }
    }
    if (!asset) throw new NotFoundError('Uploaded media was not found.');
    if (!isAdmin && (asset.customMetadata?.ownerId !== String(ownerId)
      || !['general', 'profile'].includes(asset.customMetadata?.purpose))) {
      throw new BadRequestError('Only your unattached media can be deleted here.');
    }
    await bucket.delete(key);
  }

  _handleFile(req, file, callback) {
    const resourceType = 'image';
    const purposeHeader = req.headers['x-media-purpose'];
    const purpose = typeof purposeHeader === 'string' ? purposeHeader.trim().toLowerCase() : 'general';
    if (!mediaPurposes.has(purpose)) return callback(new BadRequestError('X-Media-Purpose must be general, profile, assessment, progress, content, or product.'));
    if ((purpose === 'profile' || purpose === 'progress' || purpose === 'assessment') && resourceType !== 'image') return callback(new BadRequestError(`${purpose} media must be an image.`));
    const isAdmin = ['admin', 'super_admin'].includes(req.user?.role);
    const bucket = getUploadBucket({ isAdmin });
    if (!bucket) return callback(new Error(isAdmin ? 'R2 ADMIN_MEDIA_BUCKET is not configured.' : 'R2 USER_MEDIA_BUCKET is not configured.'));
    const owner = isAdmin ? 'admin' : `user-${Number(req.user?.id)}`;
    let keyBase = `drhair/images/${owner}/${purpose}/${randomUUID()}.${extFor(file.mimetype)}`;
    let contentType = normalizedImageMime(file.mimetype);
    const visibility = ['assessment', 'progress'].includes(purpose) ? 'private' : 'public';
    const maxBytes = config.upload.maxFileSize;
    const partSize = 5 * 1024 * 1024;
    const chunks = [];
    const optimizationChunks = [];
    const imageBinding = getImageOptimizationBinding();
    let canOptimize = Boolean(imageBinding) && !['assessment', 'progress'].includes(purpose);
    const uploadedParts = [];
    const hash = createHash('sha256');
    const prefixChunks = [];
    let prefixBytes = 0;
    let bytes = 0;
    let currentPartBytes = 0;
    let multipartUpload = null;
    let partNumber = 1;
    let completed = false;
    let storedBytes = 0;
    let storedCompressed = false;
    let processingStatus = 'original_preserved';
    const finish = (error, info) => {
      if (completed) return;
      completed = true;
      callback(error, info);
    };

    (async () => {
      try {
        for await (const chunk of file.stream) {
          bytes += chunk.length;
          if (canOptimize) {
            if (bytes <= 20 * 1024 * 1024) optimizationChunks.push(Buffer.from(chunk));
            else { optimizationChunks.length = 0; canOptimize = false; }
          }
          req._drHairUploadedFileBytes = (req._drHairUploadedFileBytes || 0) + chunk.length;
          if (req._drHairUploadedFileBytes > config.upload.maxRequestSize) {
            throw new PayloadTooLargeError('The complete upload must be smaller than 90 MiB. Reduce the number or size of photos and try again.');
          }
          if (bytes > maxBytes) throw new PayloadTooLargeError('Media file exceeds the configured upload size limit.');
          hash.update(chunk);
          if (prefixBytes < 65536) {
            const prefixChunk = Buffer.from(chunk.subarray(0, 65536 - prefixBytes));
            prefixChunks.push(prefixChunk);
            prefixBytes += prefixChunk.length;
          }

          let offset = 0;
          while (offset < chunk.length) {
            const take = Math.min(partSize - currentPartBytes, chunk.length - offset);
            chunks.push(Buffer.from(chunk.subarray(offset, offset + take)));
            currentPartBytes += take;
            offset += take;

            if (currentPartBytes === partSize) {
              if (!multipartUpload) {
                multipartUpload = await bucket.createMultipartUpload(keyBase, {
                  httpMetadata: {
                    contentType,
                    cacheControl: visibility === 'private' ? 'private, no-store' : 'public, max-age=86400',
                  },
                  customMetadata: {
                    purpose,
                    ownerId: String(req.user?.id || ''),
                    resourceType,
                    visibility,
                    processingStatus: 'original_preserved',
                  },
                });
              }
              const part = await multipartUpload.uploadPart(partNumber++, Buffer.concat(chunks, currentPartBytes));
              uploadedParts.push(part);
              chunks.length = 0;
              currentPartBytes = 0;
            }
          }
        }
        if (file.stream.truncated) throw new PayloadTooLargeError('Media file exceeds the configured upload size limit.');
        const prefix = Buffer.concat(prefixChunks, prefixBytes);
        const detectedMime = detectImageMime(prefix);
        if (!detectedMime || detectedMime !== normalizedImageMime(file.mimetype)) {
          throw new BadRequestError('The image file contents do not match the selected file type.');
        }
        const dimensions = readImageDimensions(detectedMime, prefix);
        const isHairAssessmentOriginal = req.route?.path === '/submit_form' &&
          /^photo_(front|top|left|right|back)$/.test(file.fieldname || '');
        const dimensionLimit = isHairAssessmentOriginal ? 100_000_000 : 40_000_000;
        if (!dimensions || !isSafeImageSize(dimensions.width, dimensions.height, dimensionLimit)) {
          const megapixelLimit = dimensionLimit / 1_000_000;
          throw new BadRequestError(`The image dimensions could not be verified or exceed 20,000 pixels per side and ${megapixelLimit} megapixels. Please choose a standard image file.`);
        }
        if (bytes === 0) throw new BadRequestError('The uploaded image is empty.');

        const finalPart = Buffer.concat(chunks, currentPartBytes);
        const checksum = hash.digest('hex');
        let stored = canOptimize
          ? await optimizeImageForStorage(Buffer.concat(optimizationChunks, bytes), contentType, imageBinding, { preserveSource: ['assessment', 'progress'].includes(purpose) })
          : { buffer: finalPart, contentType, compressed: false, originalBytes: bytes, processingStatus: 'original_preserved' };
        if (stored.compressed && multipartUpload) {
          await multipartUpload.abort();
          multipartUpload = null;
          uploadedParts.length = 0;
          chunks.length = 0;
        }
        if (stored.compressed) {
          keyBase = keyBase.replace(/\.[^.]+$/, '.webp');
          contentType = stored.contentType;
        }
        storedBytes = stored.buffer.length;
        storedCompressed = stored.compressed;
        processingStatus = stored.processingStatus;

        if (multipartUpload) {
          if (finalPart.length > 0) uploadedParts.push(await multipartUpload.uploadPart(partNumber, finalPart));
          await multipartUpload.complete(uploadedParts);
        } else {
          await bucket.put(keyBase, stored.buffer, {
            httpMetadata: {
              contentType: stored.contentType,
              cacheControl: visibility === 'private' ? 'private, no-store' : 'public, max-age=86400',
            },
            customMetadata: {
              purpose,
              ownerId: String(req.user?.id || ''),
              resourceType,
              visibility,
              originalBytes: String(stored.originalBytes),
              sha256: checksum,
              processingStatus: stored.processingStatus,
              compressed: String(stored.compressed),
            },
          });
        }
        finish(null, {
          key: keyBase,
          publicId: keyBase,
          secureUrl: this.createPublicUrl(keyBase),
          storageUrl: keyBase,
          purpose,
          deliveryType: visibility,
          resourceType,
          format: extFor(contentType),
          mimetype: contentType,
          originalName: String(file.originalname || 'upload').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 180),
          bytes: multipartUpload ? bytes : storedBytes,
          originalBytes: bytes,
          compressed: storedCompressed,
          sha256: checksum,
          width: dimensions.width,
          height: dimensions.height,
          processingStatus,
        });
      } catch (error) {
        if (multipartUpload) await multipartUpload.abort().catch(() => null);
        finish(error);
      }
    })();
  }

  _removeFile(req, file, callback) {
    if (!file.key) return callback(null);
    const buckets = getBucketsForKey(file.key);
    if (!buckets.length) return callback(null);
    const cleanup = async () => {
      for (const bucket of buckets) {
        if (typeof bucket.head === 'function' && !(await bucket.head(file.key))) continue;
        await bucket.delete(file.key);
        return;
      }
    };
    cleanup().then(() => callback(null), callback);
  }

  createPublicUrl(key) { return `${config.baseUrl.replace(/\/$/, '')}/api/v1/media/assets/${objectKey(key).split('/').map(encodeURIComponent).join('/')}`; }

  async serveAsset(req, res, next) {
    try {
      const key = objectKey(req.params.objectKey);
      if (!key || key.includes('..') || key.length > 400) throw new BadRequestError('Invalid media key.');
      let object = null;
      for (const bucket of getBucketsForKey(key)) {
        object = await bucket.get(key);
        if (object) break;
      }
      if (!object) throw new NotFoundError('Media was not found.');
      const attachment = req.query.attachment === '1';
      if (object.customMetadata?.visibility !== 'public' && !verifyPrivateMediaSignature(key, req.query.exp, attachment, req.query.sig)) throw new NotFoundError('Media was not found.');
      const etag = object.httpEtag || `"${object.etag || object.size}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', object.customMetadata?.visibility === 'public' ? 'public, max-age=86400' : 'private, no-store');
      const clientEtag = req.headers['if-none-match'];
      if (clientEtag && etag) {
        const targetEtag = etag.replace(/^W\//, '').trim();
        const isMatch = clientEtag.split(',').some((token) => {
          const clean = token.trim();
          return clean === '*' || clean === etag || clean.replace(/^W\//, '') === targetEtag;
        });
        if (isMatch) {
          return res.status(304).end();
        }
      }
      res.setHeader('Content-Type', object.httpMetadata?.contentType || mimeFor(key.split('.').pop()));
      const compressed = object.customMetadata?.compression === 'gzip';
      if (!compressed) res.setHeader('Content-Length', String(object.size));
      if (attachment) res.setHeader('Content-Disposition', `attachment; filename="${key.split('/').pop().replace(/\.gz$/i, '').replace(/["\\\r\n]/g, '')}"`);
      const body = compressed ? object.body.pipeThrough(new DecompressionStream('gzip')) : object.body;
      Readable.fromWeb(body).pipe(res);
    } catch (error) { next(error); }
  }
}

export function createPrivateDownloadUrl(key, format, { expiresInSeconds = 300, attachment = false } = {}) {
  const cleanKey = objectKey(key);
  if (!cleanKey || !format) throw new Error('An R2 object key and file format are required.');
  const expiresAt = Math.floor(Date.now() / 1000) + Math.min(Math.max(Number(expiresInSeconds) || 300, 1), 3600);
  const signature = sign(cleanKey, expiresAt, attachment);
  const path = cleanKey.split('/').map(encodeURIComponent).join('/');
  return `${config.baseUrl.replace(/\/$/, '')}/api/v1/media/assets/${path}?exp=${expiresAt}&sig=${encodeURIComponent(signature)}&attachment=${attachment ? 1 : 0}`;
}
