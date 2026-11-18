import multer from 'multer';
import { config } from '../../config/env.js';
import { BadRequestError, PayloadTooLargeError } from '../errors/index.js';
import { R2MediaStorage } from '../../modules/media/infrastructure/R2MediaStorage.js';

export const enforceUploadRequestSize = (req, res, next) => {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > config.upload.maxRequestSize) {
    return next(new PayloadTooLargeError('The complete upload must be smaller than 90 MiB. Reduce the number or size of photos and try again.'));
  }
  next();
};

const fileFilter = (req, file, cb) => {
  if (config.upload.allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new BadRequestError('Unsupported image format. Allowed: JPEG, PNG, WebP, GIF, AVIF, HEIC, or HEIF.'));
  }
};

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.upload.maxFileSize,
    fields: config.upload.maxFieldsPerRequest,
    fieldSize: config.upload.maxFieldSize,
    parts: config.upload.maxPartsPerRequest,
  },
  fileFilter,
});

export const uploadProfile = memoryUpload;
export const uploadScalpPhotos = memoryUpload;

// Hair-test submission uploads straight to R2 while Multer consumes the
// request, keeping image bytes out of Worker memory. The separate detector
// route continues using memoryUpload because its model needs a small buffer.
const streamingScalpUpload = multer({
  storage: new R2MediaStorage(),
  limits: {
    fileSize: config.upload.maxFileSize,
    files: config.upload.maxFilesPerRequest,
    fields: config.upload.maxFieldsPerRequest,
    fieldSize: config.upload.maxFieldSize,
    parts: config.upload.maxPartsPerRequest,
  },
  fileFilter,
});

export const uploadScalpPhotosToR2 = streamingScalpUpload;

// Generic multipart form data parser without files (for text-only FormData).
export const parseFormData = multer().none();
