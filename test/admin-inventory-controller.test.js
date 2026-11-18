import test from 'node:test';
import assert from 'node:assert/strict';
import { CommerceController } from '../src/modules/commerce/presentation/commerce.controller.js';

const makeResponse = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test('admin inventory controller forwards signed, idempotent adjustments', async () => {
  let call;
  const controller = new CommerceController({
    inventoryRepository: { async adjustStock(...args) { call = args; return 4; } },
  });
  const response = makeResponse();
  let error;
  await controller.restockProduct({
    params: { productId: 'prod-1' },
    body: { delta: -2, notes: 'Damaged', idempotency_key: 'request-1' },
    admin: { id: 'admin-1' },
  }, response, (nextError) => { error = nextError; });

  assert.equal(error, undefined);
  assert.deepEqual(call, ['prod-1', -2, 'Damaged', 'admin-1', 'ADJUSTMENT', 'request-1']);
  assert.equal(response.body.data.newStock, 4);
});

test('admin inventory controller rejects coercible deltas and oversized notes', async () => {
  let calls = 0;
  const controller = new CommerceController({
    inventoryRepository: { async adjustStock() { calls += 1; return 0; } },
  });
  for (const body of [
    { delta: true, idempotency_key: 'request-1' },
    { delta: '2', idempotency_key: 'request-2' },
    { delta: 1, idempotency_key: 'request-3', notes: 'x'.repeat(501) },
  ]) {
    const response = makeResponse();
    let error;
    await controller.restockProduct({ params: { productId: 'prod-1' }, body, admin: { id: 'admin-1' } }, response, (nextError) => { error = nextError; });
    assert.equal(error?.statusCode, 400);
  }
  assert.equal(calls, 0);
});
