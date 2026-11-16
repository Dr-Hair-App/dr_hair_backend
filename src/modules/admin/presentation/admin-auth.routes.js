import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { sendError } from '../../../shared/utils/response.js';
import { createHash } from 'node:crypto';
import { createRateLimitStore } from '../../../shared/middlewares/rate-limit-store.js';

export const createAdminAuthRouter = ({ adminAuthController }) => {
  const router = Router();
  router.post(
    '/login',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 5,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      store: createRateLimitStore('admin-login-ip'),
      passOnStoreError: true,
      keyGenerator: (req) => {
        const ip = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || (typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0]?.trim() : null) || req.ip || '127.0.0.1';
        return createHash('sha256').update(String(ip)).digest('hex');
      },
      handler: (_req, res) => sendError(res, { message: 'Too many admin login attempts. Try again later.', statusCode: 429 }),
    }),
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      store: createRateLimitStore('admin-login-id'),
      passOnStoreError: true,
      keyGenerator: (req) => {
        const email = String(req.body?.email || '').trim().toLowerCase() || 'unknown';
        return createHash('sha256').update(email).digest('hex');
      },
      handler: (_req, res) => sendError(res, { message: 'Too many login attempts for this admin ID. Try again later.', statusCode: 429 }),
    }),
    adminAuthController.login,
  );
  return router;
};
