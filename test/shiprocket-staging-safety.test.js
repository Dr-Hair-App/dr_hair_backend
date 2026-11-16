import test from 'node:test';
import assert from 'node:assert/strict';
import { ShiprocketService } from '../src/modules/commerce/infrastructure/ShiprocketService.js';

const ENV_NAMES = [
  'NODE_ENV',
  'DRHAIR_DEPLOYMENT_ENV',
  'SHIPROCKET_API_ENV',
  'SHIPROCKET_API_EMAIL',
  'SHIPROCKET_API_PASSWORD',
  'SHIPROCKET_SANDBOX_API_EMAIL',
  'SHIPROCKET_SANDBOX_API_PASSWORD',
];

function isolateEnvironment(t, values) {
  const before = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
}

test('Cloudflare staging is forced to Shiprocket sandbox even if production is configured', (t) => {
  isolateEnvironment(t, {
    NODE_ENV: 'production',
    DRHAIR_DEPLOYMENT_ENV: 'staging',
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

test('production honors explicit Shiprocket production configuration', (t) => {
  isolateEnvironment(t, {
    NODE_ENV: 'production',
    DRHAIR_DEPLOYMENT_ENV: 'production',
    SHIPROCKET_API_EMAIL: 'live@example.invalid',
    SHIPROCKET_API_PASSWORD: 'live-password',
    SHIPROCKET_SANDBOX_API_EMAIL: 'sandbox@example.invalid',
    SHIPROCKET_SANDBOX_API_PASSWORD: 'sandbox-password',
  });

  const configuration = new ShiprocketService().getConfiguration();
  assert.equal(configuration.environment, 'production');
  assert.equal(configuration.apiBase, 'https://apiv2.shiprocket.in/v1/external');
  assert.equal(configuration.email, 'live@example.invalid');
  assert.equal(configuration.password, 'live-password');
});
