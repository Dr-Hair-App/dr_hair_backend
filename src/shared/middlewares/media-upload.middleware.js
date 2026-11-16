import multer from 'multer';
import { BadRequestError } from '../errors/index.js';
import { R2MediaStorage } from '../../modules/media/infrastructure/R2MediaStorage.js';
import { config } from '../../config/env.js';

const allowedMediaMimeTypes = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
]);

const mediaUpload = multer({
  storage: new R2MediaStorage(),
  limits: { fileSize: config.upload.maxFileSize, files: 5 },
  fileFilter(_req, file, callback) {
    if (!allowedMediaMimeTypes.has(file.mimetype)) {
      callback(new BadRequestError('Unsupported media type. Upload a JPEG, PNG, WebP, GIF, or AVIF image. Video uploads are disabled; use a YouTube link.'));
      return;
    }
    callback(null, true);
  },
});

export const uploadMediaFiles = mediaUpload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'files', maxCount: 5 },
]);
