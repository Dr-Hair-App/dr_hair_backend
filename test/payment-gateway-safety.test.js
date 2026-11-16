import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PaymentGatewayService } from '../src/modules/commerce/infrastructure/PaymentGatewayService.js';
import { VerifyPaymentUseCase } from '../src/modules/commerce/application/VerifyPaymentUseCase.js';
import { Order } from '../src/modules/commerce/domain/Order.js';

test('Razorpay staging deployments reject live key IDs', (t) => {
  const envNames = ['DRHAIR_DEPLOYMENT_ENV'];
  const before = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const service = new PaymentGatewayService({ keyId: 'rzp_live_key', keySecret: 'live-secret' });
  process.env.DRHAIR_DEPLOYMENT_ENV = 'staging';
  assert.throws(() => service.assertConfigured(), { code: 'RAZORPAY_TEST_MODE_REQUIRED' });

  assert.doesNotThrow(() => new PaymentGatewayService({ keyId: 'rzp_test_key', keySecret: 'test-secret' }).assertConfigured());
});

test('Razorpay webhooks require a configured secret and the original raw request bytes', () => {
  const rawBody = Buffer.from('{ "event" : "payment.captured", "payload": {} }');
  const signature = crypto.createHmac('sha256', 'test-hook-secret').update(rawBody).digest('hex');
  const service = new PaymentGatewayService({ webhookSecret: 'test-hook-secret' });

  assert.equal(service.verifyWebhookSignature({ rawBody, signature }), true);
  assert.equal(service.verifyWebhookSignature({ rawBody: Buffer.from(rawBody.toString().replaceAll(' ', '')), signature }), false);
  assert.equal(service.verifyWebhookSignature({ rawBody: null, payload: JSON.parse(rawBody.toString()), signature }), false);
  assert.equal(new PaymentGatewayService({ webhookSecret: '' }).verifyWebhookSignature({ rawBody, signature }), false);
});

test('Razorpay order refund calls the provider in paise with a stable receipt and reports its actual state', async () => {
  const calls = [];
  const service = new PaymentGatewayService({
    keyId: 'rzp_test_key',
    keySecret: 'test-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ id: 'rfnd_test_123', status: 'pending', amount: 129900 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const refund = await service.processRefund({
    orderId: 'ORD-TEST-123',
    transactionId: 'pay_test_456',
    amount: 1299,
    reason: 'Customer return',
    receipt: 'drh_0123456789abcdef0123456789abcdef',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.razorpay.com/v1/payments/pay_test_456/refund');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    amount: 129900,
    speed: 'normal',
    notes: { reason: 'ORD-TEST-123: Customer return' },
    receipt: 'drh_0123456789abcdef0123456789abcdef',
  });
  assert.equal(refund.id, 'rfnd_test_123');
  assert.equal(refund.status, 'pending');
});

test('Razorpay order refund fails closed when there is no captured payment reference', async () => {
  const service = new PaymentGatewayService({ keyId: 'rzp_test_key', keySecret: 'test-secret' });
  await assert.rejects(
    service.processRefund({ orderId: 'ORD-TEST-123', amount: 100 }),
    /captured Razorpay payment ID is required/i,
  );
});

test('late captured payment for a cancelled order is refunded instead of reopening fulfillment', async () => {
  let order = new Order({
    order_id: 'ORD-LATE-CAPTURE', user_id: '42',
    customer: { name: 'Test', phone: '9000000000' },
    items: [{ product_id: 'product-1', title: 'Product', price: 100, quantity: 1 }],
    shipping_address: { name: 'Test', phone: '9000000000', house_number: '1', street: 'Road', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' },
    pricing: { subtotal: 100, total: 100 },
    payment: { gateway: 'razorpay', payment_status: 'Pending', payment_intent_id: 'order_late' },
    fulfillment: { status: 'Cancelled', inventory_release_status: 'completed' },
  });
  let refundRequest;
  const orderRepository = {
    async findById() { return order; },
    async markPaymentCaptured() { return null; },
    async update(_id, patch) {
      const data = order.toJSON();
      for (const [key, value] of Object.entries(patch)) {
        data[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...data[key], ...value } : value;
      }
      order = new Order(data);
      return order;
    },
  };
  const useCase = new VerifyPaymentUseCase({
    orderRepository,
    paymentGatewayService: {
      async verifyCapturedPayment() { return { id: 'pay_late', status: 'captured' }; },
      async refundCapturedPayment(input) { refundRequest = input; return { id: 'refund_late', status: 'pending' }; },
    },
  });

  const result = await useCase.execute({ orderId: order.order_id, paymentId: 'pay_late', isWebhook: true });
  assert.equal(refundRequest.paymentId, 'pay_late');
  assert.equal(refundRequest.amount, 100);
  assert.match(refundRequest.receipt, /^drh_late_/);
  assert.equal(result.fulfillment.status, 'Cancelled');
  assert.equal(result.payment.payment_status, 'Paid');
  assert.equal(result.payment.refund_status, 'pending');
  assert.equal(result.payment.refund_pending_amount, 100);
});
