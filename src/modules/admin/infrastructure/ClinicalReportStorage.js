import { randomUUID } from 'node:crypto';
import { BadRequestError } from '../../../shared/errors/index.js';
import { getMediaBucket } from '../../../shared/storage/runtime.js';
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
      stored_bytes: file.storedBytes,
      compressed: false,
      sha256: file.sha256,
      scanning_status: file.scanningStatus || 'not_scanned',
    };
  }
  if (!Buffer.isBuffer(file?.buffer) || !format || !validateReportSignature(file.mimetype, file.buffer)) {
    throw new BadRequestError('A supported, signature-verified report file is required.');
  }
  const bucket = getMediaBucket();
  if (!bucket) throw new Error('R2 MEDIA_BUCKET is not configured.');
  // Only plain text can benefit from gzip; already compressed documents and
  // images stay in their exact original bytes.
  const stored = await compressLosslessly(file.buffer, compress && file.mimetype === 'text/plain');
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
  const bucket = getMediaBucket();
  if (!bucket) throw new Error('R2 MEDIA_BUCKET is not configured.');
  await bucket.delete(key);
}
