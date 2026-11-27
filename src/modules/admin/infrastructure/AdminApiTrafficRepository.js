import crypto from 'node:crypto';
import { AdminApiTrafficModel } from '../../../shared/database/models.js';
import { isServerRequestId } from '../../../shared/middlewares/requestId.middleware.js';

const retentionMs = 30 * 24 * 60 * 60 * 1000;
const windowMs = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': retentionMs,
};
const statusRanges = {
  '2xx': [200, 300],
  '4xx': [400, 500],
  '5xx': [500, 600],
};
const safeSurfaces = new Set([
  '/api/v1/admin',
  '/api/v1/admin-auth',
  '/admin',
  '/Admin',
  'authenticated-admin',
  'patient-api',
]);

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Decide whether a traced request should be persisted to D1 `admin_api_traffic`.
 * Errors, slow requests (>= 250ms), and mutations are always persisted; fast 2xx
 * GETs are sampled at `sampleRate` (default 10%) to reduce D1 write contention.
 */
export function shouldPersistTrafficTrace(
  { method, status, durationMs } = {},
  { sampleRate = 0.1, random = Math.random } = {},
) {
  const normalizedMethod = String(method || '').toUpperCase();
  const normalizedStatus = Number(status) || 0;
  const normalizedDuration = Number(durationMs) || 0;

  if (normalizedStatus >= 400) return true;
  if (normalizedDuration >= 250) return true;
  if (MUTATION_METHODS.has(normalizedMethod)) return true;
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  if (normalizedMethod === 'GET' && normalizedStatus >= 200 && normalizedStatus < 300) {
    return random() < sampleRate;
  }
  return false;
}

export class AdminApiTrafficRepository {
  constructor({ model = AdminApiTrafficModel, now = () => new Date() } = {}) {
    this.model = model;
    this.now = now;
  }

  async record({ requestId, surface, method, route, status, durationMs, cacheControl = '' } = {}) {
    const timestamp = this.now();
    const normalizedMethod = String(method || 'UNKNOWN').toUpperCase();
    const normalizedStatus = Number(status);
    const normalizedDuration = Number(durationMs);
    const normalizedRoute = typeof route === 'string' && route.startsWith('/')
      ? route.slice(0, 180)
      : 'unmatched';
    const event = {
      id: `api_${crypto.randomUUID()}`,
      request_id: isServerRequestId(requestId) ? requestId : null,
      surface: safeSurfaces.has(surface) ? surface : 'authenticated-admin',
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(normalizedMethod)
        ? normalizedMethod
        : 'UNKNOWN',
      route: normalizedRoute,
      status: Number.isInteger(normalizedStatus) && normalizedStatus >= 100 && normalizedStatus <= 599
        ? normalizedStatus
        : 0,
      duration_ms: Number.isFinite(normalizedDuration)
        ? Math.max(0, Math.min(600_000, Math.round(normalizedDuration * 100) / 100))
        : 0,
      cache_control: String(cacheControl || '').slice(0, 80),
      created_at: timestamp.toISOString(),
    };
    await this.model.create(event);
    return event;
  }

  async list({ page = 1, limit = 50, window = '24h', statusClass = null, surface = null, scope = null } = {}) {
    const safePage = Math.max(1, Math.floor(Number(page) || 1));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 50)));
    const safeWindow = windowMs[window] ? window : '24h';
    const since = new Date(this.now().getTime() - windowMs[safeWindow]).toISOString();
    const filter = { created_at: { $gte: since } };
    if (statusRanges[statusClass]) {
      const [from, to] = statusRanges[statusClass];
      filter.status = { $gte: from, $lt: to };
    }
    const targetSurface = surface || scope;
    if (targetSurface === 'patient' || targetSurface === 'patient-api') {
      filter.surface = 'patient-api';
    } else if (targetSurface === 'admin') {
      filter.surface = { $ne: 'patient-api' };
    } else if (safeSurfaces.has(targetSurface)) {
      filter.surface = targetSurface;
    }
    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ created_at: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
      this.model.countDocuments(filter),
    ]);
    return {
      items: items.map((item) => ({
        id: item.id,
        request_id: isServerRequestId(item.request_id) ? item.request_id : null,
        surface: safeSurfaces.has(item.surface) ? item.surface : 'authenticated-admin',
        method: item.method,
        route: item.route,
        status: Number(item.status) || 0,
        duration_ms: Number(item.duration_ms) || 0,
        cache_control: String(item.cache_control || '').slice(0, 80),
        created_at: item.created_at,
      })),
      meta: {
        page: safePage,
        limit: safeLimit,
        total,
        total_pages: Math.ceil(total / safeLimit),
        window: safeWindow,
        retention_days: 30,
        surface: targetSurface || 'all',
      },
    };
  }

  async purgeExpired(before = new Date(this.now().getTime() - retentionMs)) {
    const cutoff = before instanceof Date ? before.toISOString() : new Date(before).toISOString();
    return this.model.deleteMany({ created_at: { $lt: cutoff } });
  }
}
