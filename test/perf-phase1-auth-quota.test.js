import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateToken } from '../src/shared/middlewares/auth.middleware.js';
import { TokenService } from '../src/shared/utils/token.service.js';
import { SessionRepository } from '../src/modules/auth/infrastructure/SessionRepository.js';
import { UserRepository } from '../src/modules/users/infrastructure/UserRepository.js';
import { AdminAccountRepository } from '../src/modules/admin/infrastructure/AdminAccountRepository.js';
import { dailyUsageLimit } from '../src/shared/middlewares/daily-usage-limit.js';
import { clearDatabaseBinding, setWorkerBindings } from '../src/shared/database/runtime.js';
import { PatientClinicalController } from '../src/modules/patient/presentation/patient-clinical.controller.js';
import { FeatureFlagRepository } from '../src/modules/admin/infrastructure/FeatureFlagRepository.js';
import { store } from '../src/shared/database/store.js';

const makeRes = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  ended: false,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  end() { this.ended = true; return this; },
});

test('authenticateToken runs session and user lookups concurrently in Promise.all', async () => {
  const origVerify = TokenService.verifyToken;
  const origFindActive = SessionRepository.prototype.findActive;
  const origFindUser = UserRepository.prototype.findById;

  const events = [];
  let releaseSession;
  let releaseUser;

  TokenService.verifyToken = () => ({ id: 42, role: 'user', sessionId: 'sess-1' });
  SessionRepository.prototype.findActive = () => new Promise((resolve) => {
    events.push('session:start');
    releaseSession = () => resolve({ id: 'sess-1', active: true });
  });
  UserRepository.prototype.findById = () => new Promise((resolve) => {
    events.push('user:start');
    releaseUser = () => resolve({ id: 42, phone: '9999999999', name: 'Test', is_blocked: false });
  });

  try {
    const req = { headers: { authorization: 'Bearer fake-token' } };
    let nextErr;
    const promise = authenticateToken(req, makeRes(), (err) => { nextErr = err; });

    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(events, ['session:start', 'user:start']);

    releaseSession();
    releaseUser();
    await promise;

    assert.equal(nextErr, undefined);
    assert.equal(req.user.id, 42);
  } finally {
    TokenService.verifyToken = origVerify;
    SessionRepository.prototype.findActive = origFindActive;
    UserRepository.prototype.findById = origFindUser;
  }
});

test('authenticateToken runs session and admin lookups concurrently and enforces revoked session first', async () => {
  const origVerify = TokenService.verifyToken;
  const origFindActive = SessionRepository.prototype.findActive;
  const origFindAdmin = AdminAccountRepository.prototype.findByLogin;

  const events = [];
  let releaseSession;
  let releaseAdmin;

  TokenService.verifyToken = () => ({ role: 'admin', email: 'doc@drhair.in', sessionId: 'sess-admin' });
  SessionRepository.prototype.findActive = () => new Promise((resolve) => {
    events.push('session:start');
    releaseSession = () => resolve(null);
  });
  AdminAccountRepository.prototype.findByLogin = () => new Promise((resolve) => {
    events.push('admin:start');
    releaseAdmin = () => resolve({ email: 'doc@drhair.in', active: true, role: 'super_admin' });
  });

  try {
    const req = { headers: { authorization: 'Bearer admin-token' } };
    let nextErr;
    const promise = authenticateToken(req, makeRes(), (err) => { nextErr = err; });

    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(events, ['session:start', 'admin:start']);

    releaseSession();
    releaseAdmin();
    await promise;

    assert.equal(nextErr?.statusCode, 401);
    assert.equal(nextErr?.code, 'AUTH_REQUIRED');
  } finally {
    TokenService.verifyToken = origVerify;
    SessionRepository.prototype.findActive = origFindActive;
    AdminAccountRepository.prototype.findByLogin = origFindAdmin;
  }
});

test('dailyUsageLimit fetches user and default KV policies concurrently on cache miss', async () => {
  const events = [];
  let releaseUser;
  let releaseDefault;
  let observedLimit;

  setWorkerBindings({
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ total: 0 }) }) }) },
    PUBLIC_CONFIG_KV: {
      get(key) {
        if (key.includes(':user:')) {
          events.push('kv-user:start');
          return new Promise((resolve) => { releaseUser = () => resolve(null); });
        }
        events.push('kv-default:start');
        return new Promise((resolve) => { releaseDefault = () => resolve({ daily_limit: 9 }); });
      },
    },
    DAILY_USAGE_QUOTA: {
      getByName: () => ({
        async consume(_date, limit) {
          observedLimit = limit;
          return { allowed: true, used: 1, limit, remaining: limit - 1, resetAt: '2026-11-27T00:00:00.000Z' };
        },
      }),
    },
  });

  try {
    const middleware = dailyUsageLimit({ feature: 'parallel_kv_test', defaultLimit: 5, subject: () => 'patient:99' });
    const res = makeRes();
    let nextCalled = false;
    const promise = middleware({}, res, () => { nextCalled = true; });

    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(events, ['kv-user:start', 'kv-default:start']);

    releaseUser();
    releaseDefault();
    await promise;

    assert.equal(nextCalled, true);
    assert.equal(observedLimit, 9);
  } finally {
    clearDatabaseBinding();
  }
});

test('getHomeSummary evaluates shop and clinic_appointment flags in the main Promise.all batch', async () => {
  const events = [];
  let releaseHairTests;
  let releaseShopFlag;
  let releaseAptFlag;

  const controller = new PatientClinicalController({
    hairTestRepository: {
      findByUserId: () => new Promise((resolve) => {
        events.push('hairTests:start');
        releaseHairTests = () => resolve([]);
      }),
      getDraft: async () => null,
    },
    treatmentRepository: { findByUserId: async () => [] },
    clinicalReportRepository: { listSharedByUserId: async () => [] },
    appointmentRepository: { listByPatient: async () => [] },
    featureFlagRepository: {
      evaluate: (key) => new Promise((resolve) => {
        events.push(`flag:${key}:start`);
        if (key === 'shop') releaseShopFlag = () => resolve({ enabled: false });
        else releaseAptFlag = () => resolve({ enabled: true });
      }),
    },
  });

  const res = makeRes();
  const promise = controller.getHomeSummary({ user: { id: 42 } }, res, (err) => { throw err; });

  await new Promise((r) => setTimeout(r, 5));
  assert.ok(events.includes('hairTests:start'));
  assert.ok(events.includes('flag:shop:start'));
  assert.ok(events.includes('flag:clinic_appointment:start'));

  releaseHairTests();
  releaseShopFlag();
  releaseAptFlag();
  await promise;

  assert.equal(res.body.data.feature_flags.shop_enabled, false);
  assert.equal(res.body.data.feature_flags.clinic_appointment_enabled, true);
});

test('getClinicalRecord sets private Cache-Control and ETag and returns 304 when If-None-Match matches', async () => {
  let updatedAt = '2026-11-26T10:00:00.000Z';
  const controller = new PatientClinicalController({
    hairTestRepository: {
      findByUserId: async () => [{ id: 1, reference_no: 'HT-1', status: 'reviewed', updated_at: updatedAt }],
    },
    treatmentRepository: {
      findByUserId: async () => [{ id: 2, reference_no: 'HT-1', updated_at: '2026-11-26T10:05:00.000Z', toResponse: () => ({}) }],
    },
    clinicalReportRepository: {
      listSharedByUserId: async () => [{ id: 'rpt-1', title: 'Lab', visibility: 'Shared', scanning_status: 'clean', created_at: '2026-11-26T10:10:00.000Z' }],
    },
    appointmentRepository: {
      listByPatient: async () => [{ id: 'apt-1', status: 'confirmed', updated_at: '2026-11-26T10:15:00.000Z' }],
    },
  });

  const res1 = makeRes();
  await controller.getClinicalRecord({ user: { id: 42 }, headers: {} }, res1, (err) => { throw err; });
  assert.equal(res1.statusCode, 200);
  assert.match(res1.headers['cache-control'], /private/);
  assert.equal(res1.headers['cache-control'].includes('public'), false);
  const etag1 = res1.headers.etag;
  assert.ok(etag1);

  const res304 = makeRes();
  await controller.getClinicalRecord({ user: { id: 42 }, headers: { 'if-none-match': etag1 } }, res304, (err) => { throw err; });
  assert.equal(res304.statusCode, 304);
  assert.equal(res304.ended, true);
  assert.equal(res304.body, null);

  updatedAt = '2026-11-26T11:00:00.000Z';
  const res2 = makeRes();
  await controller.getClinicalRecord({ user: { id: 42 }, headers: { 'if-none-match': etag1 } }, res2, (err) => { throw err; });
  assert.equal(res2.statusCode, 200);
  assert.notEqual(res2.headers.etag, etag1);
});

test('FeatureFlagRepository.evaluate caches for 30s and invalidates on setFlag', async () => {
  const originalFlags = store.featureFlags;
  store.featureFlags = [
    { key: 'test_perf_flag', enabled: true, platform: 'patient', rolloutPercentage: 100 },
  ];

  const repo = new FeatureFlagRepository();
  let findCalls = 0;
  const origFind = repo.findByKey.bind(repo);
  repo.findByKey = async (key) => {
    findCalls += 1;
    return origFind(key);
  };

  try {
    const first = await repo.evaluate('test_perf_flag', { platform: 'patient' });
    const second = await repo.evaluate('test_perf_flag', { platform: 'patient' });
    assert.equal(first.enabled, true);
    assert.equal(second.enabled, true);
    assert.equal(findCalls, 1);

    await repo.setFlag('test_perf_flag', { enabled: false });
    const third = await repo.evaluate('test_perf_flag', { platform: 'patient' });
    assert.equal(third.enabled, false);
    assert.equal(third.reason, 'DISABLED');
    assert.equal(findCalls, 2);
  } finally {
    store.featureFlags = originalFlags;
  }
});
