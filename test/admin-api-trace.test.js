import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { adminApiTraceMiddleware } from '../src/shared/middlewares/admin-api-trace.middleware.js';

function response(statusCode = 200) {
  const emitter = new EventEmitter();
  emitter.statusCode = statusCode;
  emitter.headers = { 'cache-control': 'private, no-store' };
  emitter.getHeader = (name) => emitter.headers[name.toLowerCase()];
  return emitter;
}

test('admin API trace logs request ID, route template, status, duration, and cache policy only', () => {
  const records = [];
  let clock = 10;
  const middleware = adminApiTraceMiddleware({
    logger: { info: (message, fields) => records.push({ message, fields }) },
    now: () => clock,
  });
  const req = {
    id: 'req_123e4567-e89b-12d3-a456-426614174000',
    serverRequestId: 'req_123e4567-e89b-12d3-a456-426614174001',
    method: 'GET',
    originalUrl: '/api/v1/admin/users/987654/reports?search=private-name%40example.test',
    user: { id: 987654, email: 'admin@example.test', role: 'admin' },
    body: { patient_name: 'Private Patient' },
    route: { path: '/users/:userId/reports' },
  };
  const res = response(200);
  let nextCalled = false;

  middleware(req, res, () => { nextCalled = true; });
  clock = 42.347;
  res.emit('finish');

  assert.equal(nextCalled, true);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    message: 'admin.api.request',
    fields: {
      request_id: 'req_123e4567-e89b-12d3-a456-426614174001',
      surface: '/api/v1/admin',
      method: 'GET',
      route: '/users/:userId/reports',
      status: 200,
      duration_ms: 32.35,
      cache_control: 'private, no-store',
    },
  });
  const serialized = JSON.stringify(records[0]);
  assert.doesNotMatch(serialized, /987654|private-name|admin@example|Private Patient/);
});

test('admin API trace omits patient requests and includes unauthenticated admin-route failures', () => {
  const records = [];
  const middleware = adminApiTraceMiddleware({
    logger: { info: (_message, fields) => records.push(fields) },
    now: () => 0,
  });

  const patientReq = { method: 'GET', originalUrl: '/api/v1/users/me', user: { id: 44, role: 'user' } };
  const patientRes = response(200);
  middleware(patientReq, patientRes, () => {});
  patientRes.emit('finish');
  assert.equal(records.length, 0);

  const unauthenticatedReq = { id: 'req_unauthorized', method: 'GET', originalUrl: '/api/v1/admin/users?email=secret', user: undefined };
  const unauthorizedRes = response(401);
  middleware(unauthenticatedReq, unauthorizedRes, () => {});
  unauthorizedRes.emit('finish');

  assert.equal(records.length, 1);
  assert.equal(records[0].surface, '/api/v1/admin');
  assert.equal(records[0].status, 401);
  assert.equal(records[0].request_id, null);
  assert.equal(records[0].route, 'unmatched');
  assert.doesNotMatch(JSON.stringify(records[0]), /secret/);
});

test('legacy /admin mounts are traced only when the authenticated caller is an admin', () => {
  const records = [];
  const middleware = adminApiTraceMiddleware({
    logger: { info: (_message, fields) => records.push(fields) },
    now: () => 0,
  });

  const patientReq = { method: 'GET', originalUrl: '/Admin/get_profile', user: { id: 44, role: 'user' } };
  const patientRes = response(200);
  middleware(patientReq, patientRes, () => {});
  patientRes.emit('finish');
  assert.equal(records.length, 0);

  const adminReq = { method: 'GET', originalUrl: '/Admin/get_profile', user: { id: 1, role: 'admin' }, route: { path: '/get_profile' } };
  const adminRes = response(200);
  middleware(adminReq, adminRes, () => {});
  adminRes.emit('finish');
  assert.equal(records.length, 1);
  assert.equal(records[0].surface, '/Admin');
});
