import multer from 'multer';
import { config } from '../../config/env.js';
import { BadRequestError } from '../errors/index.js';
import { R2ClinicalReportUploadStorage, supportedClinicalReportMimeTypes } from '../../modules/admin/infrastructure/R2ClinicalReportUploadStorage.js';

const reportUpload = multer({
  storage: new R2ClinicalReportUploadStorage(),
  limits: {
    fileSize: config.upload.maxFileSize,
    files: 1,
    fields: config.upload.maxFieldsPerRequest,
    fieldSize: config.upload.maxFieldSize,
    parts: config.upload.maxPartsPerRequest,
  },
  fileFilter(_req, file, callback) {
    if (!supportedClinicalReportMimeTypes.has(file.mimetype)) {
      callback(new BadRequestError('Upload a supported PDF, Office document, text file, or image report.'));
      return;
    }
    callback(null, true);
  },
});

export const uploadClinicalReportFile = reportUpload.single('file');
