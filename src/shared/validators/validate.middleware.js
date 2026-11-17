import { sendError } from '../utils/response.js';

/**
 * Express middleware to validate request parts against Zod schemas.
 * Sanitizes and attaches parsed outputs to req.body, req.query, or req.params.
 *
 * @param {{ body?: import('zod').ZodSchema, query?: import('zod').ZodSchema, params?: import('zod').ZodSchema }} schemas
 */
export const validate = (schemas = {}) => async (req, res, next) => {
  try {
    if (schemas.params) {
      req.params = await schemas.params.parseAsync(req.params);
    }
    if (schemas.query) {
      req.query = await schemas.query.parseAsync(req.query);
    }
    if (schemas.body) {
      req.body = await schemas.body.parseAsync(req.body);
    }
    return next();
  } catch (error) {
    if (error && Array.isArray(error.issues)) {
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
    return next(error);
  }
};
