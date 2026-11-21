import test from 'node:test';
import assert from 'node:assert/strict';
import { errorHandler } from '../src/shared/middlewares/error.middleware.js';
import { ServiceUnavailableError } from '../src/shared/errors/index.js';

test('error handler logs the route template without request or error secrets', () => {
  const logOutput = [];
  const originalError = console.error;
  console.error = (...parts) => logOutput.push(parts.join(' '));

  const response = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  const secret = 'patient-token-secret-value';
  const request = {
    method: 'GET',
    url: `/api/v1/admin/patients?access_token=${secret}`,
    baseUrl: `/api/v1/admin/${secret}`,
    route: { path: '/patients/:patientId' },
    id: secret,
  };
  const error = new Error(`database failed for ${secret}`);

  try {
    errorHandler(error, request, response, () => {});
  } finally {
    console.error = originalError;
  }

  const logs = logOutput.join('\n');
  assert.match(logs, /GET \/patients\/:patientId/);
  assert.match(logs, /untrusted-request-id/);
  assert.doesNotMatch(logs, new RegExp(secret));
  assert.doesNotMatch(logs, /database failed/);
  assert.equal(response.statusCode, 500);
  assert.equal(response.payload.error.code, 'INTERNAL_ERROR');
});

test('error handler preserves a stable operational code on a 503', () => {
  const originalError = console.error;
  console.error = () => {};
  const response = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  try {
    errorHandler(
      new ServiceUnavailableError('Credentials are missing', null, 'SHIPROCKET_NOT_CONFIGURED'),
      { method: 'POST', route: { path: '/shipping/quote' }, serverRequestId: 'req_test_123', id: 'req_test_123' },
      response,
      () => {},
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.error.code, 'SHIPROCKET_NOT_CONFIGURED');
});
