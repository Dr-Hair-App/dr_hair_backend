import { randomUUID } from 'node:crypto';
import { getMediaBucket } from '../../../shared/storage/runtime.js';
import { createPrivateDownloadUrl } from '../../media/infrastructure/R2MediaStorage.js';

const formats = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export async function uploadClinicalReport(file, userId) {
  if (!Buffer.isBuffer(file?.buffer) || !formats[file.mimetype]) throw new TypeError('A supported report file is required.');
  const bucket = getMediaBucket();
  if (!bucket) throw new Error('R2 MEDIA_BUCKET is not configured.');
  const id = randomUUID();
  const key = `drhair/private-reports/user-${Number(userId)}/${id}.${formats[file.mimetype]}`;
  await bucket.put(key, file.buffer, { httpMetadata: { contentType: file.mimetype, cacheControl: 'private, no-store' }, customMetadata: { purpose: 'clinical-report', ownerId: String(userId), visibility: 'private' } });
  return { id, public_id: key, asset_id: key };
}

export function createClinicalReportDownloadUrl(key, format, { attachment = true } = {}) {
  return createPrivateDownloadUrl(key, format, { expiresInSeconds: 60, attachment });
}

export async function deleteClinicalReport(key) {
  const bucket = getMediaBucket();
  if (!bucket) throw new Error('R2 MEDIA_BUCKET is not configured.');
  await bucket.delete(key);
}
