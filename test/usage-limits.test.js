import test from 'node:test';
import assert from 'node:assert/strict';
import { clearDatabaseBinding, setWorkerBindings } from '../src/shared/database/runtime.js';
import { cloudflareRateLimit } from '../src/shared/middlewares/rate-limit-store.js';
import { dailyUsageLimit } from '../src/shared/middlewares/daily-usage-limit.js';

const response = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const bindings = (extra = {}) => ({
  DB: { prepare: () => ({ bind: () => ({ first: async () => ({ total: 0 }) }) }) },
  ...extra,
});

test('daily quota reads a KV policy and uses a hashed per-user DO key', async () => {
  let observedPolicyKey;
  let observedObjectName;
  let observedLimit;
  setWorkerBindings(bindings({
    PUBLIC_CONFIG_KV: {
      async get(key) {
        observedPolicyKey = key;
        return key.includes(':user:') ? { daily_limit: 3 } : null;
      },
    },
    DAILY_USAGE_QUOTA: {
      getByName(name) {
        observedObjectName = name;
        return { async consume(_date, limit) { observedLimit = limit; return { allowed: true, used: 1, limit, remaining: 2, resetAt: '2026-11-18T00:00:00.000Z' }; } };
      },
    },
  }));
  try {
    const middleware = dailyUsageLimit({ feature: 'unit_policy', defaultLimit: 60, subject: (req) => `patient:${req.user.id}` });
    const req = { user: { id: 123 } };
    const res = response();
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(observedPolicyKey, 'usage-policy:v1:unit_policy:user:' + observedObjectName.split(':').at(-1));
    assert.equal(observedLimit, 3);
    assert.match(observedObjectName, /^unit_policy:[a-f0-9]{32}$/);
    assert.equal(res.headers['x-daily-remaining'], '2');
  } finally {
    clearDatabaseBinding();
  }
});

test('daily quota denies at the configured limit and returns reset metadata', async () => {
  setWorkerBindings(bindings({
    DAILY_USAGE_QUOTA: {
      getByName: () => ({ async consume() { return { allowed: false, used: 4, limit: 4, remaining: 0, resetAt: new Date(Date.now() + 60_000).toISOString() }; } }),
    },
  }));
  try {
    const middleware = dailyUsageLimit({ feature: 'unit_deny', defaultLimit: 4, subject: () => 'patient:42' });
    const res = response();
    let nextCalled = false;
    await middleware({}, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error.code, 'DAILY_LIMIT_EXCEEDED');
    assert.equal(res.body.error.details.remaining, 0);
    assert.ok(Number(res.headers['retry-after']) > 0);
  } finally {
    clearDatabaseBinding();
  }
});

test('Cloudflare per-user rate binding avoids the D1 fallback when available', async () => {
  let keySeen;
  setWorkerBindings(bindings({
    TEST_RATE_LIMITER: { async limit({ key }) { keySeen = key; return { success: true }; } },
  }));
  try {
    let fallbackCalled = false;
    let nextCalled = false;
    const middleware = cloudflareRateLimit('TEST_RATE_LIMITER', () => { fallbackCalled = true; }, {
      key: (req) => `patient:${req.user.id}`,
      message: 'limited',
    });
    await new Promise((resolve, reject) => middleware({ user: { id: 42 } }, response(), (err) => err ? reject(err) : (nextCalled = true, resolve())));
    assert.equal(keySeen, 'patient:42');
    assert.equal(nextCalled, true);
    assert.equal(fallbackCalled, false);
  } finally {
    clearDatabaseBinding();
  }
});
