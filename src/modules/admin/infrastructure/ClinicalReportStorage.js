import { randomUUID } from 'node:crypto';
import { BadRequestError } from '../../../shared/errors/index.js';
import { getMediaBucket, getBucketsForKey } from '../../../shared/storage/runtime.js';
import { compressLosslessly, createPrivateDownloadUrl } from '../../media/infrastructure/R2MediaStorage.js';
import { clinicalReportFormat, validateReportSignature } from './R2ClinicalReportUploadStorage.js';

export async function uploadClinicalReport(file, userId, { compress = true } = {}) {
  const format = clinicalReportFormat(file?.mimetype);
  const ownerPrefix = `drhair/private-reports/user-${Number(userId)}/`;
  if (file?.key && file.key.startsWith(ownerPrefix) && file.format === format) {
    return {
      id: file.id,
      public_id: file.key,
      asset_id: file.key,
      bytes: file.bytes,
      stored_bytes: file.storedBytes ?? file.bytes,
      compressed: file.compressed === true,
      sha256: file.sha256,
      scanning_status: file.scanningStatus || 'not_scanned',
    };
  }
  if (!Buffer.isBuffer(file?.buffer) || !format || !validateReportSignature(file.mimetype, file.buffer)) {
    throw new BadRequestError('A supported, signature-verified report file is required.');
  }
  const bucket = getMediaBucket();
  if (!bucket) throw new Error('R2 USER_MEDIA_BUCKET is not configured.');
  // Losslessly compress text, PDF, and Office documents when gzip yields a smaller payload.
  // Images and already-compressed formats are preserved byte-for-byte.
  const isCompressible = typeof file.mimetype === 'string' && (
    file.mimetype === 'text/plain' ||
    file.mimetype === 'application/pdf' ||
    file.mimetype.startsWith('application/vnd.openxmlformats-officedocument.') ||
    file.mimetype === 'application/msword' ||
    file.mimetype === 'application/vnd.ms-excel'
  );
  const stored = await compressLosslessly(file.buffer, compress && isCompressible);
  const id = file.id || randomUUID();
  const key = `drhair/private-reports/user-${Number(userId)}/${id}.${format}${stored.compressed ? '.gz' : ''}`;
  await bucket.put(key, stored.buffer, {
    httpMetadata: { contentType: file.mimetype, cacheControl: 'private, no-store' },
    customMetadata: {
      purpose: 'clinical-report',
      ownerId: String(userId),
      visibility: 'private',
      compression: stored.compressed ? 'gzip' : 'none',
      originalBytes: String(stored.originalBytes),
      scanningStatus: 'not_scanned',
    },
  });
  return {
    id,
    public_id: key,
    asset_id: key,
    bytes: stored.originalBytes,
    stored_bytes: stored.buffer.length,
    compressed: stored.compressed,
    scanning_status: 'not_scanned',
  };
}

export function createClinicalReportDownloadUrl(key, format, { attachment = true } = {}) {
  return createPrivateDownloadUrl(key, format, { expiresInSeconds: 60, attachment });
}

export async function deleteClinicalReport(key) {
  const buckets = getBucketsForKey(key);
  if (!buckets.length) throw new Error('R2 USER_MEDIA_BUCKET is not configured.');
  for (const bucket of buckets) {
    if (typeof bucket.head === 'function' && !(await bucket.head(key))) continue;
    await bucket.delete(key);
    return;
  }
  await buckets[0].delete(key);
}
