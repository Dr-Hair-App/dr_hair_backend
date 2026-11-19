import multer from 'multer';
import { BadRequestError } from '../../../shared/errors/index.js';
import { config } from '../../../config/env.js';
import { R2MediaStorage } from '../../media/infrastructure/R2MediaStorage.js';

const allowedImageMimeTypes = new Set(config.upload.allowedMimeTypes);
const productImageUpload = multer({
  storage: new R2MediaStorage(),
  limits: {
    fileSize: config.upload.maxFileSize,
    files: 10,
    fields: config.upload.maxFieldsPerRequest,
    fieldSize: config.upload.maxFieldSize,
    parts: config.upload.maxPartsPerRequest,
  },
  fileFilter(_req, file, callback) {
    if (!allowedImageMimeTypes.has(file.mimetype)) {
      callback(new BadRequestError('Upload a JPEG, PNG, WebP, GIF, AVIF, HEIC, or HEIF product image.'));
      return;
    }
    callback(null, true);
  },
});

export const uploadProductImages = (req, res, next) => {
  // Product images are public catalog assets and must live under the product
  // ownership prefix so update/delete cleanup cannot touch unrelated media.
  req.headers['x-media-purpose'] = 'product';
  productImageUpload.fields([{ name: 'files', maxCount: 10 }])(req, res, next);
};
