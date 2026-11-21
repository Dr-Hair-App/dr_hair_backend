import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DRHAIR_DEPLOYMENT_ENV = '';
process.env.JWT_SECRET ||= `admin-api-traffic-test-${randomUUID()}-local`;

const [{ createApp }, { TokenService }] = await Promise.all([
  import('../src/app.js'),
  import('../src/shared/utils/token.service.js'),
]);
const { app, container } = createApp();
let server;
let baseUrl;
let permittedToken;
let deniedToken;

async function createAccount(key, permissions) {
  const email = `${key}-${randomUUID()}@example.test`;
  const account = await container.repositories.adminAccountRepository.create({
    name: key,
    email,
    passwordHash: 'test-only-hash',
    role: 'admin',
    roleTemplate: 'custom-admin',
    permissions,
  });
  return TokenService.generateToken({ id: account.id, email, role: 'admin' });
}

async function request(path, token, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
  });
  return { response, payload: await response.json() };
}

before(async () => {
  permittedToken = await createAccount('traffic-viewer', ['audit.view']);
  deniedToken = await createAccount('traffic-denied', []);
  await container.repositories.adminApiTrafficRepository.record({
    requestId: 'req_123e4567-e89b-12d3-a456-426614174000',
    surface: '/api/v1/admin', method: 'GET', route: '/users/:userId',
    status: 503, durationMs: 84.2, cacheControl: 'private, no-store',
  });
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe('Admin API traffic route', () => {
  it('requires audit.view permission', async () => {
    assert.equal((await request('/admin/api-traffic')).response.status, 401);
    assert.equal((await request('/admin/api-traffic', deniedToken)).response.status, 403);
  });

  it('returns filtered route metadata without request bodies or patient data', async () => {
    const { response, payload } = await request('/admin/api-traffic?window=24h&statusClass=5xx&limit=10', permittedToken);
    assert.equal(response.status, 200);
    assert.equal(payload.data.items.length, 1);
    assert.equal(payload.data.items[0].route, '/users/:userId');
    assert.equal(payload.data.items[0].status, 503);
    assert.equal(payload.data.items[0].duration_ms, 84.2);
    assert.equal(payload.meta.retention_days, 30);
    assert.doesNotMatch(JSON.stringify(payload), /patient|body|email|query-string/);
  });

  it('exposes the server request ID to allowed browser origins', async () => {
    const { response } = await request('/admin/api-traffic', permittedToken, {
      Origin: 'http://localhost:3001',
      'X-Request-ID': 'admin-browser-trace-123',
    });
    const exposedHeaders = response.headers.get('access-control-expose-headers') || '';
    assert.match(response.headers.get('x-request-id') || '', /^admin-browser-trace-123$/);
    assert.match(response.headers.get('x-server-request-id') || '', /^req_[0-9a-f-]{36}$/);
    assert.match(exposedHeaders.toLowerCase(), /x-server-request-id/);
  });

  it('rejects invalid ranges and unknown query filters', async () => {
    assert.equal((await request('/admin/api-traffic?window=90d', permittedToken)).response.status, 400);
    assert.equal((await request('/admin/api-traffic?limit=1000', permittedToken)).response.status, 400);
    assert.equal((await request('/admin/api-traffic?unexpected=secret', permittedToken)).response.status, 400);
  });
});
