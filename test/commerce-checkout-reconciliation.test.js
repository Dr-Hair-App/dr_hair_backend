import test from 'node:test';
import assert from 'node:assert/strict';
import { CommerceController } from '../src/modules/commerce/presentation/commerce.controller.js';
import { Order } from '../src/modules/commerce/domain/Order.js';

function mockResponse() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function pendingOrder() {
  return new Order({
    order_id: 'ORD-EXPIRE-1', user_id: '42',
    customer: { name: 'Test', phone: '9000000000' },
    items: [{ product_id: 'product-1', title: 'Product', price: 100, quantity: 1 }],
    shipping_address: { name: 'Test', phone: '9000000000', house_number: '1', street: 'Road', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' },
    pricing: { subtotal: 100, total: 100 },
    payment: { gateway: 'razorpay', payment_status: 'Pending', payment_intent_id: 'order_expire' },
    fulfillment: { status: 'Preparing' },
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
}

test('checkout cron expires only provider-created orders with no payment attempt and releases stock once', async (t) => {
  const previousSecret = process.env.CRON_SECRET;
  const previousTtl = process.env.PENDING_CHECKOUT_EXPIRY_MINUTES;
  process.env.CRON_SECRET = 'staging-cron-test-secret';
  process.env.PENDING_CHECKOUT_EXPIRY_MINUTES = '30';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousTtl === undefined) delete process.env.PENDING_CHECKOUT_EXPIRY_MINUTES;
    else process.env.PENDING_CHECKOUT_EXPIRY_MINUTES = previousTtl;
  });

  const candidate = pendingOrder();
  const cancelled = new Order({ ...candidate.toJSON(), fulfillment: { ...candidate.fulfillment, status: 'Cancelled', inventory_release_status: 'pending' } });
  const calls = { expired: 0, release: 0, completed: 0, notices: 0 };
  const controller = new CommerceController({
    orderRepository: {
      async listForCheckoutReconciliation() { return [candidate]; },
      async expirePendingRazorpayOrder(id, intentId) { calls.expired += 1; assert.equal(id, candidate.order_id); assert.equal(intentId, 'order_expire'); return cancelled; },
      async markInventoryReleaseComplete() { calls.completed += 1; },
    },
    paymentGatewayService: {
      async getPaymentOrder() { return { status: 'created' }; },
      async getOrderPayments() { return []; },
    },
    inventoryRepository: { async releaseStock() { calls.release += 1; } },
    notificationRepository: { async create() { calls.notices += 1; return { id: 'notif-expired' }; } },
  });
  const response = mockResponse();
  let error;
  await controller.reconcilePendingCheckouts({ get: () => 'Bearer staging-cron-test-secret' }, response, (reason) => { error = reason; });

  assert.equal(error, undefined);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.data, { checked: 1, settled: 0, cancelled: 1, inventory_released: 1, deferred: 0, errors: 0, pending_limit: 50, expiry_minutes: 30 });
  assert.deepEqual(calls, { expired: 1, release: 1, completed: 1, notices: 1 });
});

test('checkout reconciliation defers while Razorpay has an authorized payment attempt', async (t) => {
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'staging-cron-test-secret';
  t.after(() => { if (previousSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previousSecret; });
  let cancelled = false;
  const controller = new CommerceController({
    orderRepository: {
      async listForCheckoutReconciliation() { return [pendingOrder()]; },
      async expirePendingRazorpayOrder() { cancelled = true; return null; },
    },
    paymentGatewayService: {
      async getPaymentOrder() { return { status: 'attempted' }; },
      async getOrderPayments() { return [{ id: 'pay_auth', status: 'authorized' }]; },
    },
  });
  const response = mockResponse();
  await controller.reconcilePendingCheckouts({ get: () => 'Bearer staging-cron-test-secret' }, response, () => {});
  assert.equal(response.body.data.deferred, 1);
  assert.equal(response.body.data.cancelled, 0);
  assert.equal(cancelled, false);
});

test('checkout reconciliation requires an environment secret', async () => {
  const previousSecret = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const controller = new CommerceController({});
  const response = mockResponse();
  await controller.reconcilePendingCheckouts({ get: () => '' }, response, () => {});
  if (previousSecret !== undefined) process.env.CRON_SECRET = previousSecret;
  assert.equal(response.statusCode, 503);
});
