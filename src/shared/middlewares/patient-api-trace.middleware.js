import { logger as defaultLogger } from '../utils/logger.js';
import { isServerRequestId } from './requestId.middleware.js';
import { getExecutionContext } from '../runtime/execution-context.js';
import { shouldPersistTrafficTrace } from '../../modules/admin/infrastructure/AdminApiTrafficRepository.js';

const adminPathPrefixes = ['/api/v1/admin', '/api/v1/admin-auth', '/admin', '/Admin'];

const isAdminApiPath = (pathname) => adminPathPrefixes.some((prefix) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`));

/**
 * Emit a sanitized, privacy-safe access trace for patient and public API requests.
 * Captures status code, route template, method, duration, and server request ID.
 * Strictly omits query parameters, request bodies, patient identifiers, and credentials.
 */
export function patientApiTraceMiddleware({
  logger = defaultLogger,
  now = () => performance.now(),
  record = null,
  sampleRate = 0.1,
  random = Math.random,
} = {}) {
  return (req, res, next) => {
    const startedAt = now();
    const pathname = String(req.originalUrl || req.path || '').split('?', 1)[0];

    res.once('finish', () => {
      const role = req.user?.role;
      // Skip if this is an admin request
      if (isAdminApiPath(pathname) || role === 'admin' || role === 'super_admin') return;

      const durationMs = Math.max(0, now() - startedAt);
      const trace = {
        request_id: isServerRequestId(req.serverRequestId) ? req.serverRequestId : null,
        surface: 'patient-api',
        method: String(req.method || 'UNKNOWN').toUpperCase(),
        route: typeof req.route?.path === 'string' ? req.route.path : 'unmatched',
        status: Number(res.statusCode) || 0,
        duration_ms: Math.round(durationMs * 100) / 100,
        cache_control: String(res.getHeader?.('cache-control') || '').slice(0, 80) || undefined,
      };

      logger.info('patient.api.request', trace);

      if (record && shouldPersistTrafficTrace(
        { method: trace.method, status: trace.status, durationMs: trace.duration_ms },
        { sampleRate, random },
      )) {
        const persistence = Promise.resolve().then(() => record({
          requestId: trace.request_id,
          surface: trace.surface,
          method: trace.method,
          route: trace.route,
          status: trace.status,
          durationMs: trace.duration_ms,
          cacheControl: trace.cache_control,
        }));
        const executionContext = getExecutionContext();
        if (executionContext?.waitUntil) {
          executionContext.waitUntil(persistence.catch((error) => {
            logger.warn('patient.api.traffic_persistence_failed', {
              error_type: error?.constructor?.name || 'Error',
            });
          }));
        } else {
          void persistence.catch((error) => {
            logger.warn('patient.api.traffic_persistence_failed', {
              error_type: error?.constructor?.name || 'Error',
            });
          });
        }
      }
    });

    next();
  };
}
