import { BadRequestError } from '../errors/index.js';
import { getBucketsForKey } from '../storage/runtime.js';
import { uploadProfilePhotoToR2, uploadScalpPhotosToR2 } from './upload.middleware.js';

const isMultipart = (req) => String(req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data;');

export const uploadProfilePhotoForUpdate = (req, res, next) => {
  if (!isMultipart(req)) return next();
  req.headers['x-media-purpose'] = 'profile';
  uploadProfilePhotoToR2(req, res, next);
};

export const parseProfileUpdateMultipart = (req, res, next) => {
  if (!isMultipart(req)) return next();
  try {
    const payload = typeof req.body?.payload === 'string'
      ? JSON.parse(req.body.payload)
      : { ...(req.body || {}) };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestError('The multipart payload must be a JSON object.');
    }
    delete payload.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestError('The multipart payload must be a JSON object.');
    }
    if (req.file && Object.hasOwn(payload, 'profile_url')) {
      throw new BadRequestError('Send either a profile image or profile_url, not both.');
    }
    req.body = {
      ...payload,
      ...(req.file ? { profile_url: req.file.secureUrl } : {}),
    };
    next();
  } catch (error) {
    next(error);
  }
};

export const uploadProgressPhotos = (req, res, next) => {
  if (!isMultipart(req)) return next();
  req.headers['x-media-purpose'] = 'progress';
  const upload = uploadScalpPhotosToR2.fields([
    { name: 'photo_front', maxCount: 1 },
    { name: 'photo_top', maxCount: 1 },
    { name: 'photo_back', maxCount: 1 },
  ]);
  upload(req, res, next);
};

export const parseProgressCheckInMultipart = (req, res, next) => {
  if (!isMultipart(req)) return next();
  try {
    if (typeof req.body?.payload !== 'string') throw new BadRequestError('A JSON payload field is required for multipart progress check-ins.');
    const payload = JSON.parse(req.body.payload);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestError('The multipart payload must be a JSON object.');
    }
    const files = Object.values(req.files || {}).flat();
    const photos = files.map((file) => ({
      angle: String(file.fieldname || '').replace(/^photo_/, ''),
      public_id: file.key,
      url: file.secureUrl,
      file_name: file.originalName || file.originalname || '',
      mime_type: file.mimetype,
      bytes: file.bytes,
    }));
    if (photos.length < 1 || photos.length > 3) {
      throw new BadRequestError('Attach one to three progress photos using photo_front, photo_top, or photo_back.');
    }
    req._directProgressAssets = new Map(files.map((file) => [file.key, {
      type: 'authenticated',
      public_id: file.key,
      secure_url: file.secureUrl,
      format: file.format,
      bytes: file.bytes,
    }]));
    req.body = { ...payload, photos };
    next();
  } catch (error) {
    next(error);
  }
};

const uploadedFiles = (req) => [
  ...(req.file ? [req.file] : []),
  ...Object.values(req.files || {}).flat(),
];

export const cleanupPatientUploadedMedia = async (req) => {
  const cleaned = req._patientMediaCleanedKeys || new Set();
  await Promise.all(uploadedFiles(req).map(async (file) => {
    if (!file.key) return;
    if (cleaned.has(file.key)) return;
    for (const bucket of getBucketsForKey(file.key)) {
      try {
        if (typeof bucket.head === 'function' && !(await bucket.head(file.key))) continue;
        await bucket.delete(file.key);
        return;
      } catch {
        // Preserve the request error if best-effort object cleanup fails.
      }
    }
  }));
};

export const cleanupPatientUploadOnError = async (error, req, res, next) => {
  await cleanupPatientUploadedMedia(req);
  next(error);
};
