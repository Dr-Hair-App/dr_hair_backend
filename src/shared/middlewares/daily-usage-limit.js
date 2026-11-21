import { createHash } from 'node:crypto';
import { getWorkerBindings } from '../database/runtime.js';
import { sendError } from '../utils/response.js';

const POLICY_CACHE_TTL_MS = 30_000;
const POLICY_CACHE_MAX_ENTRIES = 1_000;
const policyCache = new Map();

const subjectHash = (subject) => createHash('sha256').update(String(subject)).digest('hex').slice(0, 32);

const parseLimit = (value, fallback) => {
  if (value == null) return fallback;
  const raw = typeof value === 'number' ? value : Number(value?.daily_limit ?? value?.limit ?? value);
  return Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.min(10000, Math.floor(raw))) : fallback;
};

const resolveLimit = async (kv, feature, userHash, fallback) => {
  if (!kv || typeof kv.get !== 'function') return fallback;
  const cacheKey = `${feature}:${userHash}`;
  const cached = policyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let limit = fallback;
  try {
    const userPolicy = userHash ? await kv.get(`usage-policy:v1:${feature}:user:${userHash}`, { type: 'json' }) : null;
    const defaultPolicy = userPolicy == null
      ? await kv.get(`usage-policy:v1:${feature}:default`, { type: 'json' })
      : null;
    limit = parseLimit(userPolicy ?? defaultPolicy, fallback);
  } catch {
    // A policy KV outage falls back to the conservative code default.
  }
  if (policyCache.size >= POLICY_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [key, entry] of policyCache) {
      if (entry.expiresAt <= now) policyCache.delete(key);
      if (policyCache.size < POLICY_CACHE_MAX_ENTRIES) break;
    }
    if (policyCache.size >= POLICY_CACHE_MAX_ENTRIES) {
      policyCache.delete(policyCache.keys().next().value);
    }
  }
  policyCache.set(cacheKey, { value: limit, expiresAt: Date.now() + POLICY_CACHE_TTL_MS });
  return limit;
};

const indiaQuotaWindow = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  const year = Number(part('year'));
  const month = Number(part('month'));
  const day = Number(part('day'));
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const resetAt = new Date(Date.UTC(year, month - 1, day + 1) - (5.5 * 60 * 60 * 1000)).toISOString();
  return { date, resetAt };
};

/** Enforces a strong per-subject daily quota via a sharded Durable Object.
 * KV holds editable policy only; it is not used as a read/modify/write counter. */
export const dailyUsageLimit = ({ feature, defaultLimit, subject, allowAnonymous = false }) => async (req, res, next) => {
  try {
    const rawSubject = String(subject(req) ?? '').trim();
    if (!rawSubject) {
      if (allowAnonymous) return next();
      return sendError(res, { message: 'A user identity is required for this action.', code: 'AUTH_REQUIRED', statusCode: 401 });
    }
    const bindings = getWorkerBindings() || {};
    const namespace = bindings.DAILY_USAGE_QUOTA;
    if (!namespace || typeof namespace.getByName !== 'function') {
      if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
        return sendError(res, { message: 'Usage protection is temporarily unavailable.', code: 'USAGE_LIMIT_UNAVAILABLE', statusCode: 503 });
      }
      return next();
    }

    const userHash = subjectHash(rawSubject);
    const limit = await resolveLimit(bindings.PUBLIC_CONFIG_KV, feature, userHash, defaultLimit);
    const object = namespace.getByName(`${feature}:${userHash}`);
    const { date, resetAt } = indiaQuotaWindow();
    const result = await object.consume(date, limit, resetAt);
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil((Date.parse(result.resetAt) - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return sendError(res, {
        message: 'You have reached today’s usage limit. Please try again tomorrow.',
        code: 'DAILY_LIMIT_EXCEEDED',
        statusCode: 429,
        details: { limit: result.limit, remaining: 0, reset_at: result.resetAt },
      });
    }
    res.setHeader('X-Daily-Limit', String(result.limit));
    res.setHeader('X-Daily-Remaining', String(result.remaining));
    return next();
  } catch (error) {
    return next(error);
  }
};
