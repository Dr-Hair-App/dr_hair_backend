import { BadRequestError } from '../errors/index.js';
import { getBucketsForKey } from '../storage/runtime.js';
import { sendError } from '../utils/response.js';
import { uploadMediaFiles } from './media-upload.middleware.js';

const isMultipart = (req) => String(req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data;');

export const uploadAdminContentMedia = (req, res, next) => {
  if (!isMultipart(req)) return next();
  // Admin content images have their own R2 key prefix and purpose metadata.
  req.headers['x-media-purpose'] = 'content';
  uploadMediaFiles(req, res, next);
};

const uploadedAssets = (req, previousAssets = {}) => {
  const files = req.files?.files || [];
  if (!files.length) return null;
  const assets = files.map((file) => ({
    url: file.secureUrl,
    publicId: file.key,
    format: file.format,
    bytes: file.bytes,
    originalBytes: file.originalBytes,
    compressed: file.compressed === true,
    processingStatus: file.processingStatus || 'original_preserved',
  }));
  if (assets.some((asset) => !asset.url || !asset.publicId)) {
    throw new BadRequestError('The media service returned incomplete upload metadata.');
  }
  const original = assets[0];
  const selected = assets.slice(1).find((asset) => asset.format === 'webp') || assets[1] || original;
  return {
    imageUrl: selected.url,
    mediaAssets: {
      originalUrl: original.url,
      originalPublicId: original.publicId,
      variants: assets,
      processingStatus: String(selected.processingStatus || previousAssets?.processingStatus || 'original_preserved'),
    },
  };
};

export const parseAdminContentPayload = (kind) => (req, res, next) => {
  if (!isMultipart(req)) return next();
  try {
    if (typeof req.body?.payload !== 'string') throw new BadRequestError('A JSON payload field is required with multipart image uploads.');
    const payload = JSON.parse(req.body.payload);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestError('The multipart payload must be a JSON object.');
    }
    if ((req.files?.file || []).length > 0) {
      throw new BadRequestError('Attach content images as repeated files fields.');
    }
    req.body = payload;
    const uploaded = uploadedAssets(req, kind === 'content' ? payload.metadata?.mediaAssets : payload.media_assets);
    if (uploaded) {
      if (kind === 'content') {
        req.body.imageUrl = uploaded.imageUrl;
        req.body.metadata = { ...(payload.metadata || {}), mediaAssets: uploaded.mediaAssets };
      } else {
        req.body.avatar = uploaded.imageUrl;
        req.body.media_assets = uploaded.mediaAssets;
      }
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const cleanupUploadedAdminContentMedia = async (req) => {
  const files = req.files?.files || [];
  await Promise.all(files.map(async (file) => {
    if (!file.key) return;
    for (const bucket of getBucketsForKey(file.key)) {
      try {
        if (typeof bucket.head === 'function' && !(await bucket.head(file.key))) continue;
        await bucket.delete(file.key);
        return;
      } catch {
        // Cleanup is best effort; do not mask the request failure.
      }
    }
  }));
};

export const cleanupAdminContentUploadOnError = async (error, req, res, next) => {
  await cleanupUploadedAdminContentMedia(req);
  next(error);
};

export const validateAdminContentUpload = (schemas = {}) => async (req, res, next) => {
  try {
    if (schemas.params) req.params = await schemas.params.parseAsync(req.params);
    if (schemas.body) req.body = await schemas.body.parseAsync(req.body);
    next();
  } catch (error) {
    if (error && Array.isArray(error.issues)) {
      await cleanupUploadedAdminContentMedia(req);
      const details = error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      }));
      return sendError(res, {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: details[0]?.message || 'Validation failed.',
        details,
      });
    }
    next(error);
  }
};
