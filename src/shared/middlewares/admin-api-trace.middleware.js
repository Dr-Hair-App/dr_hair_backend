import { logger as defaultLogger } from '../utils/logger.js';
import { isServerRequestId } from './requestId.middleware.js';
import { getExecutionContext } from '../runtime/execution-context.js';

// The legacy /admin and /Admin mounts also host patient-facing user routes.
// Only count them after authentication proves the caller has an Admin role.
const adminPathPrefixes = ['/api/v1/admin', '/api/v1/admin-auth'];

const isAdminApiPath = (pathname) => adminPathPrefixes.some((prefix) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`));

const getSurface = (pathname) => {
  if (pathname === '/api/v1/admin-auth' || pathname.startsWith('/api/v1/admin-auth/')) return '/api/v1/admin-auth';
  if (pathname === '/api/v1/admin' || pathname.startsWith('/api/v1/admin/')) return '/api/v1/admin';
  if (pathname === '/Admin' || pathname.startsWith('/Admin/')) return '/Admin';
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return '/admin';
  return 'authenticated-admin';
};

/**
 * Emit a sanitized access trace for Admin API requests. The response request ID
 * lets browser HARs correlate with Worker logs; routes use Express templates so
 * patient IDs, query values, request bodies, and account identifiers stay out.
 */
export function adminApiTraceMiddleware({ logger = defaultLogger, now = () => performance.now(), record = null } = {}) {
  return (req, res, next) => {
    const startedAt = now();
    const pathname = String(req.originalUrl || req.path || '').split('?', 1)[0];

    res.once('finish', () => {
      const role = req.user?.role;
      if (!isAdminApiPath(pathname) && role !== 'admin' && role !== 'super_admin') return;

      const durationMs = Math.max(0, now() - startedAt);
      const trace = {
        request_id: isServerRequestId(req.serverRequestId) ? req.serverRequestId : null,
        surface: getSurface(pathname),
        method: String(req.method || 'UNKNOWN').toUpperCase(),
        route: typeof req.route?.path === 'string' ? req.route.path : 'unmatched',
        status: Number(res.statusCode) || 0,
        duration_ms: Math.round(durationMs * 100) / 100,
        cache_control: String(res.getHeader?.('cache-control') || '').slice(0, 80) || undefined,
      };
      logger.info('admin.api.request', trace);
      if (record) {
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
            logger.warn('admin.api.traffic_persistence_failed', {
              error_type: error?.constructor?.name || 'Error',
            });
          }));
        } else {
          void persistence.catch((error) => {
            logger.warn('admin.api.traffic_persistence_failed', {
              error_type: error?.constructor?.name || 'Error',
            });
          });
        }
      }
    });

    next();
  };
}
