import { isDatabaseConnected } from '../database/database.js';
import { getWorkerBindings } from '../database/runtime.js';
import { D1RateLimitStore } from './d1-rate-limit-store.js';
import { sendError } from '../utils/response.js';

export const createRateLimitStore = (namespace) => {
  try {
    return isDatabaseConnected() ? new D1RateLimitStore(namespace) : undefined;
  } catch {
    return undefined;
  }
};

/** Uses Cloudflare's fast, per-location rate limiter in Workers, with the
 * existing D1-backed limiter retained for local/non-Workers execution. */
export const cloudflareRateLimit = (bindingName, fallbackMiddleware, { key, message }) => (req, res, next) => {
  const limiter = getWorkerBindings()?.[bindingName];
  if (!limiter || typeof limiter.limit !== 'function') return fallbackMiddleware(req, res, next);
  Promise.resolve(limiter.limit({ key: String(key(req) || 'unknown') }))
    .then(({ success }) => {
      if (success) return next();
      res.setHeader('Retry-After', '60');
      return sendError(res, { message, code: 'RATE_LIMIT_EXCEEDED', statusCode: 429 });
    })
    .catch(() => fallbackMiddleware(req, res, next));
};
