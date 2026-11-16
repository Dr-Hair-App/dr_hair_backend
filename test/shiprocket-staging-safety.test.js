import test from 'node:test';
import assert from 'node:assert/strict';
import { ShiprocketService } from '../src/modules/commerce/infrastructure/ShiprocketService.js';

test('Vercel Preview is forced to Shiprocket sandbox even if production is configured', (t) => {
  const envNames = [
    'NODE_ENV',
    'VERCEL',
    'VERCEL_ENV',
    'SHIPROCKET_API_ENV',
    'SHIPROCKET_API_EMAIL',
    'SHIPROCKET_API_PASSWORD',
    'SHIPROCKET_SANDBOX_API_EMAIL',
    'SHIPROCKET_SANDBOX_API_PASSWORD',
  ];
  const before = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  Object.assign(process.env, {
    NODE_ENV: 'production',
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    SHIPROCKET_API_ENV: 'production',
    SHIPROCKET_API_EMAIL: 'live@example.invalid',
    SHIPROCKET_API_PASSWORD: 'live-password',
    SHIPROCKET_SANDBOX_API_EMAIL: 'sandbox@example.invalid',
    SHIPROCKET_SANDBOX_API_PASSWORD: 'sandbox-password',
  });

  const configuration = new ShiprocketService().getConfiguration();
  assert.equal(configuration.environment, 'sandbox');
  assert.equal(configuration.apiBase, 'https://api-sandbox.shiprocket.in/v1/external');
  assert.equal(configuration.email, 'sandbox@example.invalid');
  assert.equal(configuration.password, 'sandbox-password');
});

test('Vercel Production continues to honor production Shiprocket configuration', (t) => {
  const envNames = [
    'NODE_ENV',
    'VERCEL',
    'VERCEL_ENV',
    'SHIPROCKET_API_ENV',
    'SHIPROCKET_API_EMAIL',
    'SHIPROCKET_API_PASSWORD',
    'SHIPROCKET_SANDBOX_API_EMAIL',
    'SHIPROCKET_SANDBOX_API_PASSWORD',
  ];
  const before = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  Object.assign(process.env, {
    NODE_ENV: 'production',
    VERCEL: '1',
    VERCEL_ENV: 'production',
  });
  delete process.env.SHIPROCKET_API_ENV;
  process.env.SHIPROCKET_API_EMAIL = 'live@example.invalid';
  process.env.SHIPROCKET_API_PASSWORD = 'live-password';
  process.env.SHIPROCKET_SANDBOX_API_EMAIL = 'sandbox@example.invalid';
  process.env.SHIPROCKET_SANDBOX_API_PASSWORD = 'sandbox-password';

  const configuration = new ShiprocketService().getConfiguration();
  assert.equal(configuration.environment, 'production');
  assert.equal(configuration.apiBase, 'https://apiv2.shiprocket.in/v1/external');
  assert.equal(configuration.email, 'live@example.invalid');
  assert.equal(configuration.password, 'live-password');
});
