import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { BadRequestError, NotFoundError, PayloadTooLargeError } from '../../../shared/errors/index.js';
import { config } from '../../../config/env.js';
import { getMediaBucket } from '../../../shared/storage/runtime.js';

const mediaPurposes = new Set(['general', 'profile', 'assessment', 'progress', 'content', 'product']);
const extFor = (mime) => ({ 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v', 'application/pdf': 'pdf' })[mime] || 'bin';
const objectKey = (key) => String(key || '').replace(/^\/+/, '').replace(/\\/g, '/');
const mimeFor = (format) => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v' })[String(format || '').toLowerCase()] || 'application/octet-stream';

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
      ? ['drhair/images/admin/general/', 'drhair/images/admin/product/']
      : [`drhair/images/user-${Number(ownerId)}/general/`];
    if (!allowedPrefixes.some((prefix) => key.startsWith(prefix))) throw new BadRequestError('Only your unattached media can be deleted here.');
    const bucket = getMediaBucket();
    if (!bucket) throw new Error('R2 MEDIA_BUCKET is not configured.');
    const asset = await bucket.head(key);
    if (!asset) throw new NotFoundError('Uploaded media was not found.');
    await bucket.delete(key);
  }

  _handleFile(req, file, callback) {
    const bucket = getMediaBucket();
    if (!bucket) return callback(new Error('R2 MEDIA_BUCKET is not configured.'));
    const resourceType = 'image';
    const purposeHeader = req.headers['x-media-purpose'];
    const purpose = typeof purposeHeader === 'string' ? purposeHeader.trim().toLowerCase() : 'general';
    if (!mediaPurposes.has(purpose)) return callback(new BadRequestError('X-Media-Purpose must be general, profile, assessment, progress, content, or product.'));
    if ((purpose === 'profile' || purpose === 'progress' || purpose === 'assessment') && resourceType !== 'image') return callback(new BadRequestError(`${purpose} media must be an image.`));
    const isAdmin = ['admin', 'super_admin'].includes(req.user?.role);
    const owner = isAdmin ? 'admin' : `user-${Number(req.user?.id)}`;
    const keyBase = `drhair/images/${owner}/${purpose}/${randomUUID()}.${extFor(file.mimetype)}`;
    const maxBytes = config.upload.maxFileSize;
    const shouldCompress = req.headers['x-media-compression'] === 'lossless';
    const chunks = [];
    let bytes = 0;
    let completed = false;
    const finish = (error, info) => {
      if (completed) return;
      completed = true;
      callback(error, info);
    };

    (async () => {
      try {
        for await (const chunk of file.stream) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw new PayloadTooLargeError('Media file exceeds the configured upload size limit.');
          chunks.push(Buffer.from(chunk));
        }
        if (file.stream.truncated) throw new PayloadTooLargeError('Media file exceeds the configured upload size limit.');
        const original = Buffer.concat(chunks, bytes);
        const stored = await compressLosslessly(original, shouldCompress);
        const key = `${keyBase}${stored.compressed ? '.gz' : ''}`;
        const visibility = ['assessment', 'progress'].includes(purpose) ? 'private' : 'public';
        await bucket.put(key, stored.buffer, {
          httpMetadata: {
            contentType: file.mimetype,
            cacheControl: visibility === 'private' ? 'private, no-store' : 'public, max-age=86400',
          },
          customMetadata: {
            purpose,
            ownerId: String(req.user?.id || ''),
            resourceType,
            visibility,
            compression: stored.compressed ? 'gzip' : 'none',
            originalBytes: String(stored.originalBytes),
          },
        });
        finish(null, {
          key,
          publicId: key,
          secureUrl: this.createPublicUrl(key),
          storageUrl: key,
          purpose,
          deliveryType: visibility,
          resourceType,
          format: extFor(file.mimetype),
          mimetype: file.mimetype,
          bytes: stored.buffer.length,
          originalBytes: stored.originalBytes,
          compressed: stored.compressed,
        });
      } catch (error) {
        finish(error);
      }
    })();
  }

  _removeFile(_req, file, callback) {
    const bucket = getMediaBucket();
    if (!bucket || !file.key) return callback(null);
    bucket.delete(file.key).then(() => callback(null), callback);
  }

  createPublicUrl(key) { return `${config.baseUrl.replace(/\/$/, '')}/api/v1/media/assets/${objectKey(key).split('/').map(encodeURIComponent).join('/')}`; }

  async serveAsset(req, res, next) {
    try {
      const key = objectKey(req.params.objectKey);
      if (!key || key.includes('..') || key.length > 400) throw new BadRequestError('Invalid media key.');
      const bucket = getMediaBucket();
      const object = await bucket?.get(key);
      if (!object) throw new NotFoundError('Media was not found.');
      const attachment = req.query.attachment === '1';
      if (object.customMetadata?.visibility !== 'public' && !verifyPrivateMediaSignature(key, req.query.exp, attachment, req.query.sig)) throw new NotFoundError('Media was not found.');
      res.setHeader('Content-Type', object.httpMetadata?.contentType || mimeFor(key.split('.').pop()));
      const compressed = object.customMetadata?.compression === 'gzip';
      if (!compressed) res.setHeader('Content-Length', String(object.size));
      res.setHeader('Cache-Control', object.customMetadata?.visibility === 'public' ? 'public, max-age=86400' : 'private, no-store');
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
