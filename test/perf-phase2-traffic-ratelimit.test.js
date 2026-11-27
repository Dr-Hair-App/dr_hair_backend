import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { shouldPersistTrafficTrace } from '../src/modules/admin/infrastructure/AdminApiTrafficRepository.js';
import { patientApiTraceMiddleware } from '../src/shared/middlewares/patient-api-trace.middleware.js';
import { adminApiTraceMiddleware } from '../src/shared/middlewares/admin-api-trace.middleware.js';
import { D1RateLimitStore } from '../src/shared/middlewares/d1-rate-limit-store.js';
import { RateLimitCounterModel } from '../src/shared/database/models.js';

function createResponse(statusCode = 200) {
  const emitter = new EventEmitter();
  emitter.statusCode = statusCode;
  emitter.headers = { 'cache-control': 'private, no-store' };
  emitter.getHeader = (name) => emitter.headers[name.toLowerCase()];
  emitter.setHeader = (name, value) => { emitter.headers[name.toLowerCase()] = value; };
  return emitter;
}

test('shouldPersistTrafficTrace always persists errors, slow requests, and mutations, and samples fast 2xx GETs', () => {
  assert.equal(shouldPersistTrafficTrace({ method: 'GET', status: 404, durationMs: 5 }, { random: () => 0.99 }), true);
  assert.equal(shouldPersistTrafficTrace({ method: 'GET', status: 500, durationMs: 5 }, { random: () => 0.99 }), true);
  assert.equal(shouldPersistTrafficTrace({ method: 'GET', status: 200, durationMs: 250 }, { random: () => 0.99 }), true);
  assert.equal(shouldPersistTrafficTrace({ method: 'POST', status: 201, durationMs: 10 }, { random: () => 0.99 }), true);
  assert.equal(shouldPersistTrafficTrace({ method: 'PUT', status: 200, durationMs: 10 }, { random: () => 0.99 }), true);
  assert.equal(shouldPersistTrafficTrace({ method: 'PATCH', status: 200, durationMs: 10 }, { random: () => 0.99 }), true);
  assert.equal(shouldPersistTrafficTrace({ method: 'DELETE', status: 204, durationMs: 10 }, { random: () => 0.99 }), true);

  assert.equal(shouldPersistTrafficTrace({ method: 'GET', status: 200, durationMs: 20 }, { sampleRate: 0.1, random: () => 0.05 }), true);
  assert.equal(shouldPersistTrafficTrace({ method: 'GET', status: 200, durationMs: 20 }, { sampleRate: 0.1, random: () => 0.1 }), false);
  assert.equal(shouldPersistTrafficTrace({ method: 'GET', status: 304, durationMs: 20 }, { sampleRate: 0.1, random: () => 0.01 }), false);
  assert.equal(shouldPersistTrafficTrace({ method: 'HEAD', status: 200, durationMs: 20 }, { sampleRate: 0.1, random: () => 0.01 }), false);
});

test('patientApiTraceMiddleware logs 100% of requests while sampling fast 2xx GET D1 persistence', async () => {
  const logged = [];
  const persisted = [];
  let clock = 0;
  let roll = 0.95;

  const middleware = patientApiTraceMiddleware({
    logger: { info: (msg, fields) => logged.push({ msg, fields }), warn: () => {} },
    now: () => clock,
    record: async (event) => { persisted.push(event); },
    random: () => roll,
  });

  // Fast 200 GET skipped from D1 persistence when roll >= 0.1, but still logged
  const req1 = { method: 'GET', originalUrl: '/api/v1/products', route: { path: '/products' } };
  const res1 = createResponse(200);
  middleware(req1, res1, () => {});
  clock = 15;
  res1.emit('finish');

  // Fast 200 GET persisted when roll < 0.1
  roll = 0.05;
  const req2 = { method: 'GET', originalUrl: '/api/v1/products', route: { path: '/products' } };
  const res2 = createResponse(200);
  middleware(req2, res2, () => {});
  clock = 30;
  res2.emit('finish');

  // Slow 200 GET (>= 250ms) persisted even when roll >= 0.1
  roll = 0.99;
  const req3 = { method: 'GET', originalUrl: '/api/v1/products', route: { path: '/products' } };
  const res3 = createResponse(200);
  middleware(req3, res3, () => {});
  clock = 300;
  res3.emit('finish');

  // 4xx GET persisted even when roll >= 0.1
  const req4 = { method: 'GET', originalUrl: '/api/v1/products/missing', route: { path: '/products/:id' } };
  const res4 = createResponse(404);
  middleware(req4, res4, () => {});
  clock = 310;
  res4.emit('finish');

  // POST mutation persisted even when roll >= 0.1
  const req5 = { method: 'POST', originalUrl: '/api/v1/orders', route: { path: '/orders' } };
  const res5 = createResponse(201);
  middleware(req5, res5, () => {});
  clock = 320;
  res5.emit('finish');

  await new Promise((r) => setTimeout(r, 10));

  assert.equal(logged.length, 5);
  assert.equal(persisted.length, 4);
  assert.deepEqual(persisted.map((p) => p.status), [200, 200, 404, 201]);
  assert.deepEqual(persisted.map((p) => p.method), ['GET', 'GET', 'GET', 'POST']);
});

test('adminApiTraceMiddleware supports configurable sampleRate while logging 100% of requests', async () => {
  const logged = [];
  const persisted = [];
  const middleware = adminApiTraceMiddleware({
    logger: { info: (_msg, fields) => logged.push(fields), warn: () => {} },
    now: () => 0,
    record: async (event) => { persisted.push(event); },
    sampleRate: 0.1,
    random: () => 0.5,
  });

  const req = { method: 'GET', originalUrl: '/api/v1/admin/users', user: { id: 1, role: 'admin' }, route: { path: '/users' } };
  const res = createResponse(200);
  middleware(req, res, () => {});
  res.emit('finish');

  await new Promise((r) => setTimeout(r, 10));

  assert.equal(logged.length, 1);
  assert.equal(persisted.length, 0);
});

test('D1RateLimitStore caches already-blocked keys within reset window to avoid redundant D1 round-trips', async () => {
  const originalFindOneAndUpdate = RateLimitCounterModel.findOneAndUpdate;
  const originalFindOne = RateLimitCounterModel.findOne;
  const originalUpdateOne = RateLimitCounterModel.updateOne;
  const originalDeleteOne = RateLimitCounterModel.deleteOne;

  let d1Calls = 0;
  const futureReset = new Date(Date.now() + 60_000);
  let dbHits = 0;

  RateLimitCounterModel.findOneAndUpdate = (filter) => {
    d1Calls += 1;
    return {
      lean: async () => {
        if (filter.resetTime?.$gt) {
          dbHits += 1;
          return { key: filter.key, totalHits: dbHits, resetTime: futureReset };
        }
        return null;
      },
    };
  };
  RateLimitCounterModel.findOne = () => {
    d1Calls += 1;
    return { lean: async () => ({ totalHits: dbHits, resetTime: futureReset }) };
  };
  RateLimitCounterModel.updateOne = async () => {
    d1Calls += 1;
    dbHits = Math.max(0, dbHits - 1);
  };
  RateLimitCounterModel.deleteOne = async () => {
    d1Calls += 1;
    dbHits = 0;
  };

  try {
    const store = new D1RateLimitStore('test-ns');
    store.init({ windowMs: 60_000, limit: 2 });

    // Hit 1 & 2: <= limit, goes to D1
    const r1 = await store.increment('user-1');
    assert.equal(r1.totalHits, 1);
    const r2 = await store.increment('user-1');
    assert.equal(r2.totalHits, 2);
    assert.equal(d1Calls, 2);

    // Hit 3: > limit, hits D1 once and caches blocked state
    const r3 = await store.increment('user-1');
    assert.equal(r3.totalHits, 3);
    assert.equal(d1Calls, 3);

    // Hit 4 & get(): served from isolate-level blockedCache with 0 extra D1 calls
    const r4 = await store.increment('user-1');
    assert.equal(r4.totalHits, 4);
    const got = await store.get('user-1');
    assert.equal(got.totalHits, 4);
    assert.equal(d1Calls, 3);

    // decrement() invalidates blockedCache
    await store.decrement('user-1');
    assert.equal(d1Calls, 4);
    const r5 = await store.increment('user-1');
    assert.equal(r5.totalHits, 3);
    assert.equal(d1Calls, 5);

    // resetKey() invalidates blockedCache
    await store.resetKey('user-1');
    assert.equal(d1Calls, 6);
  } finally {
    RateLimitCounterModel.findOneAndUpdate = originalFindOneAndUpdate;
    RateLimitCounterModel.findOne = originalFindOne;
    RateLimitCounterModel.updateOne = originalUpdateOne;
    RateLimitCounterModel.deleteOne = originalDeleteOne;
  }
});
