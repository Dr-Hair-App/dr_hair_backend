import { randomUUID } from 'node:crypto';
import { getMediaBucket } from '../../../shared/storage/runtime.js';
import { createPrivateDownloadUrl, detectImageMime, hasSafeImageDimensions, R2MediaStorage } from './R2MediaStorage.js';

const mimeByFormat = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif' };
const formatFor = (type) => Object.entries(mimeByFormat).find(([, mime]) => mime === type)?.[0] || 'bin';

export class R2ImageStorage {
  async hasOwnedProfileImage(publicId, userId) {
    const key = String(publicId || '');
    const ownedPrefixes = [
      `drhair/images/profiles/user-${Number(userId)}.`,
      `drhair/images/user-${Number(userId)}/profile/`,
    ];
    if (!ownedPrefixes.some((prefix) => key.startsWith(prefix))) return false;
    const asset = await getMediaBucket()?.head(key);
    return Boolean(asset
      && asset.customMetadata?.ownerId === String(userId)
      && asset.customMetadata?.purpose === 'profile'
      && asset.customMetadata?.visibility === 'public');
  }

  async uploadImage(buffer, subfolder, publicId, { deliveryType = 'public', contentType = 'image/jpeg' } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('An image buffer is required for R2 upload.');
    const bucket = getMediaBucket();
    if (!bucket) throw new Error('R2 MEDIA_BUCKET is not configured.');
    const folder = String(subfolder || 'images').replace(/[^a-zA-Z0-9/_-]/g, '').replace(/^\/+|\/+$/g, '');
    const normalizedContentType = contentType === 'image/jpg' ? 'image/jpeg' : contentType;
    if (!Object.values(mimeByFormat).includes(normalizedContentType)) throw new Error('Unsupported R2 image content type.');
    if (detectImageMime(buffer.subarray(0, 32)) !== normalizedContentType) {
      throw new Error('The image file contents do not match the selected file type.');
    }
    if (!hasSafeImageDimensions(normalizedContentType, buffer.subarray(0, 65536))) {
      throw new Error('The image dimensions could not be verified or exceed the 40 megapixel upload limit.');
    }
    const format = formatFor(normalizedContentType);
    const key = String(publicId || '').startsWith('drhair/') ? publicId : `drhair/images/${folder}/${publicId ? `${publicId}.${format}` : `${randomUUID()}.${format}`}`;
    const purpose = key.includes('/assessment/') ? 'assessment' : key.includes('/progress/') ? 'progress' : key.includes('/profile') ? 'profile' : 'generated';
    const visibility = deliveryType === 'private' || deliveryType === 'authenticated' ? 'private' : 'public';
    await bucket.put(key, buffer, { httpMetadata: { contentType: normalizedContentType, cacheControl: visibility === 'private' ? 'private, no-store' : 'public, max-age=86400' }, customMetadata: { purpose, ownerId: key.match(/user-(\d+)/)?.[1] || '', visibility } });
    const secureUrl = visibility === 'private' ? createPrivateDownloadUrl(key, format) : new R2MediaStorage().createPublicUrl(key);
    return { publicId: key, secureUrl, storageUrl: key, deliveryType, format };
  }

  async deleteImage(publicId) {
    if (typeof publicId !== 'string' || !publicId.trim()) throw new Error('An R2 object key is required for deletion.');
    const bucket = getMediaBucket();
    if (!bucket) throw new Error('R2 MEDIA_BUCKET is not configured.');
    await bucket.delete(publicId);
    return { result: 'ok' };
  }

  createPrivateDownloadUrl(publicId, format, options = {}) { return createPrivateDownloadUrl(publicId, format, options); }

  async getAuthenticatedImage(publicId) {
    const object = await getMediaBucket()?.get(publicId);
    if (!object || object.customMetadata?.visibility !== 'private' || !['assessment', 'progress'].includes(object.customMetadata?.purpose)) {
      throw Object.assign(new Error('Private R2 image was not found.'), { status: 404 });
    }
    const format = object.httpMetadata?.contentType ? formatFor(object.httpMetadata.contentType) : String(publicId).split('.').pop().toLowerCase();
    return { public_id: publicId, asset_id: publicId, type: 'authenticated', bytes: object.size, format, secure_url: createPrivateDownloadUrl(publicId, format), resource_type: 'image' };
  }

  async downloadAuthenticatedImage(publicId, format, { maxBytes = 2 * 1024 * 1024 } = {}) {
    const object = await getMediaBucket()?.get(publicId);
    if (!object || object.customMetadata?.visibility !== 'private') throw new Error('Private image was not found.');
    if (object.size <= 0 || object.size > maxBytes) throw new Error('Private image is empty or exceeds the AI analysis size limit.');
    const mimeType = mimeByFormat[String(format).toLowerCase()];
    if (!mimeType || object.httpMetadata?.contentType !== mimeType) throw new Error('Private image format is not supported for AI analysis.');
    const data = Buffer.from(await object.arrayBuffer());
    if (data.length > maxBytes) throw new Error('Private image exceeds the AI analysis size limit.');
    return { data: data.toString('base64'), mimeType };
  }
}
