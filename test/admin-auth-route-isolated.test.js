import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DRHAIR_DEPLOYMENT_ENV = '';
process.env.JWT_SECRET = `admin-login-isolated-${randomUUID()}`;

const [{ createApp }, { hashPassword }, { TokenService }] = await Promise.all([
  import('../src/app.js'),
  import('../src/shared/utils/password-hasher.js'),
  import('../src/shared/utils/token.service.js'),
]);

const login = `isolated-${randomUUID()}@example.test`;
const password = `Local-test-${randomUUID()}!`;
const account = {
  id: `fixture-${randomUUID()}`,
  email: login,
  name: 'Isolated Test Admin',
  role: 'admin',
  roleTemplate: 'clinical-admin',
  active: true,
  passwordHash: await hashPassword(password),
};
const { app } = createApp({
  adminAccountRepository: {
    findByLogin: async (providedLogin) => providedLogin === login ? { ...account } : null,
  },
  sessionRepository: {
    create: async ({ userId, userType }) => ({
      sessionId: `local-session-${randomUUID()}`,
      refreshToken: `local-refresh-${randomUUID()}`,
      userId,
      userType,
    }),
  },
});

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

describe('Admin login route with isolated local fixtures', () => {
  it('authenticates the injected test account without writing to a shared repository', async () => {
    const response = await fetch(`${baseUrl}/api/v1/admin-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: login, password }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'success');
    assert.equal(payload.data.admin.email, login);
    assert.equal(payload.data.admin.role, 'admin');
    assert.equal(payload.data.passwordHash, undefined);
    assert.equal(TokenService.verifyToken(payload.data.token)?.email, login);
  });

  it('returns the generic auth failure for a wrong fixture password', async () => {
    const response = await fetch(`${baseUrl}/api/v1/admin-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: login, password: `${password}-wrong` }),
    });
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(payload.error.message, 'Admin ID or password is incorrect.');
  });
});
