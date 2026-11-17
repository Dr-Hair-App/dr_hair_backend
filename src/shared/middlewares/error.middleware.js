import { AppError } from '../errors/index.js';
import { logger } from '../utils/logger.js';
import { sendError } from '../utils/response.js';
import { config } from '../../config/env.js';

export const errorHandler = (err, req, res, next) => {
  logger.error(`${req.method} ${req.url} [${req.id || 'no-request-id'}] - Error: ${err.message}`, err.stack);

  if (err instanceof AppError) {
    const statusCode = Number(err.statusCode) || 500;
    if (statusCode >= 500) {
      return sendError(res, {
        message: config.env === 'production' ? 'Internal Server Error' : err.message,
        code: 'INTERNAL_ERROR',
        statusCode,
        meta: { request_id: req.id || null },
      });
    }
    return sendError(res, {
      message: err.message,
      code: err.code || 'INTERNAL_ERROR',
      statusCode,
      details: err.details,
    });
  }

  // Multer error handling
  if (err.name === 'MulterError') {
    return sendError(res, {
      message: `File upload error: ${err.message}`,
      code: err.code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR',
      statusCode: err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
    });
  }

  // Unhandled error in development vs production
  const message = config.env === 'production'
    ? 'Internal Server Error' 
    : err.message || 'An unexpected error occurred';

  return sendError(res, {
    message,
    statusCode: 500,
    meta: { request_id: req.id || null },
  });
};

