import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminApiTrafficRepository } from '../src/modules/admin/infrastructure/AdminApiTrafficRepository.js';
import { adminApiTrafficQuerySchema } from '../src/shared/validators/admin-api-traffic.validator.js';

test('API traffic persistence stores only bounded request metadata and rejects caller IDs', async () => {
  let saved;
  const repository = new AdminApiTrafficRepository({
    model: { create: async (record) => { saved = record; } },
    now: () => new Date('2026-11-21T00:00:00.000Z'),
  });
  const event = await repository.record({
    requestId: 'user-supplied-id', surface: '/api/v1/admin', method: 'get',
    route: '/patients/:id?private=1', status: 200, durationMs: 12.345,
    cacheControl: 'private, no-store', body: { patient: 'sensitive' },
  });
  assert.equal(saved.request_id, null);
  assert.equal(saved.route, '/patients/:id?private=1');
  assert.equal(saved.duration_ms, 12.35);
  assert.equal(saved.created_at, '2026-11-21T00:00:00.000Z');
  assert.equal('body' in saved, false);
  assert.equal(event.request_id, null);
});

test('API traffic persistence accepts server IDs and normalizes untrusted fields', async () => {
  let saved;
  const repository = new AdminApiTrafficRepository({ model: { create: async (record) => { saved = record; } } });
  await repository.record({
    requestId: 'req_123e4567-e89b-12d3-a456-426614174000', surface: 'unexpected',
    method: 'TRACE', route: 'sensitive-route', status: 999, durationMs: 9999999,
    cacheControl: 'x'.repeat(200),
  });
  assert.match(saved.request_id, /^req_/);
  assert.equal(saved.surface, 'authenticated-admin');
  assert.equal(saved.method, 'UNKNOWN');
  assert.equal(saved.route, 'unmatched');
  assert.equal(saved.status, 0);
  assert.equal(saved.duration_ms, 600000);
  assert.equal(saved.cache_control.length, 80);
});

test('API traffic query schema applies defaults and rejects invalid filters', () => {
  assert.deepEqual(adminApiTrafficQuerySchema.parse({ limit: '25', window: '7d' }), {
    page: 1, limit: 25, window: '7d',
  });
  assert.equal(adminApiTrafficQuerySchema.safeParse({ page: '0' }).success, false);
  assert.equal(adminApiTrafficQuerySchema.safeParse({ statusClass: '3xx' }).success, false);
  assert.equal(adminApiTrafficQuerySchema.safeParse({ unexpected: 'secret' }).success, false);
});
