import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authenticateToken } from '../../../shared/middlewares/auth.middleware.js';
import { requireRegisteredUser } from '../../../shared/middlewares/registered-user.middleware.js';
import { createRateLimitStore } from '../../../shared/middlewares/rate-limit-store.js';

export const createMediaRouter = ({ mediaController }) => {
  const router = Router();
  const mediaOperationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: createRateLimitStore('media-upload-ip'),
    passOnStoreError: true,
  });
  const mediaAccountOperationLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: createRateLimitStore('media-upload-account'),
    passOnStoreError: true,
    keyGenerator: (req) => String(req.user?.id || 'unknown'),
  });
  router.get('/assets/:objectKey(*)', mediaController.serveAsset);
  router.delete(
    '/',
    authenticateToken,
    (req, res, next) => {
      if (req.user?.role === 'super_admin' || req.user?.role === 'admin') {
        return next();
      }
      return requireRegisteredUser(req, res, () => {
        mediaOperationLimiter(req, res, () => {
          mediaAccountOperationLimiter(req, res, next);
        });
      });
    },
    mediaController.remove,
  );
  return router;
};
