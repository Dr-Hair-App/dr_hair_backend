import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderRepository } from '../src/modules/commerce/infrastructure/OrderRepository.js';
import { store } from '../src/shared/database/store.js';

test('payment attempt history is deduplicated, bounded, and excludes provider payloads', async () => {
  const previousOrders = store.orders;
  store.orders = [{
    order_id: 'ORD-ATTEMPTS-1',
    user_id: '42',
    customer: {},
    items: [{ product_id: 'prod-1', title: 'Serum', price: 100, quantity: 1 }],
    shipping_address: {},
    pricing: { subtotal: 100, total: 100 },
    payment: { gateway: 'razorpay', payment_status: 'Pending', payment_attempts: [] },
    fulfillment: { status: 'New' },
  }];
  try {
    const repository = new OrderRepository();
    for (let i = 0; i < 22; i += 1) {
      await repository.appendPaymentAttempt('ORD-ATTEMPTS-1', {
        payment_id: `pay_${i}`,
        status: 'failed',
        amount: 100,
        method: 'upi',
        failure_code: 'BAD_REQUEST_ERROR',
        attempted_at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        raw_payload: { authorization: 'must-not-be-stored' },
      });
    }
    await repository.appendPaymentAttempt('ORD-ATTEMPTS-1', {
      payment_id: 'pay_21', status: 'captured', amount: 100, method: 'upi',
    });
    const order = await repository.findById('ORD-ATTEMPTS-1');
    assert.equal(order.payment.payment_attempts.length, 20);
    assert.equal(order.payment.payment_attempts.at(-1).payment_id, 'pay_21');
    assert.equal(order.payment.payment_attempts.at(-1).status, 'captured');
    assert.equal(JSON.stringify(order.payment.payment_attempts).includes('must-not-be-stored'), false);
  } finally {
    store.orders = previousOrders;
  }
});
