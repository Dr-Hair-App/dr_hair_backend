import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CashfreePaymentGatewayService } from '../src/modules/commerce/infrastructure/CashfreePaymentGatewayService.js';
import { CheckoutUseCase } from '../src/modules/commerce/application/CheckoutUseCase.js';
import { CommerceController } from '../src/modules/commerce/presentation/commerce.controller.js';

const configuredService = (fetchImpl, overrides = {}) => new CashfreePaymentGatewayService({
  appId: 'sandbox_app_id',
  secretKey: 'sandbox_secret',
  fetchImpl,
  ...overrides,
});

test('Cashfree order creation is sandbox-only and returns a payment session', async () => {
  let request;
  const service = configuredService(async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({
      order_id: request.body.order_id,
      cf_order_id: 'cashfree_internal_id',
      payment_session_id: 'sandbox_session',
      order_amount: 349,
      order_currency: 'INR',
      order_status: 'ACTIVE',
    }) };
  }, {
    environment: 'PRODUCTION',
    webhookUrl: 'https://sandbox.example.test/api/v1/commerce/webhook/payment',
  });

  const result = await service.createPaymentIntent({
    orderId: 'ORD-20261123-3210',
    amount: 349,
    customer: { id: 'patient-test', phone: '9876543210' },
    metadata: { app_order_id: 'ORD-20261123-3210' },
  });

  assert.match(request.url, /^https:\/\/sandbox\.cashfree\.com\/pg\/orders$/);
  assert.equal(request.options.headers['x-api-version'], '2026-01-01');
  assert.equal(request.options.headers['x-client-id'], 'sandbox_app_id');
  assert.equal(request.body.order_id, 'ORD-20261123-3210');
  assert.equal(request.body.order_tags.app_order_id, 'ORD-20261123-3210');
  assert.equal(request.body.order_meta.notify_url, 'https://sandbox.example.test/api/v1/commerce/webhook/payment');
  assert.equal(result.payment_session_id, 'sandbox_session');
  assert.equal(result.gateway, 'cashfree');
  assert.equal(result.environment, 'TEST');
});

test('Cashfree calls the platform fetch with the global receiver', async () => {
  let receiver;
  const service = configuredService(function fetchWithPlatformReceiver() {
    receiver = this;
    return Promise.resolve({ ok: true, json: async () => ({
      order_id: 'ORD-RECEIVER-1', payment_session_id: 'sandbox_session', order_amount: 1,
      order_currency: 'INR', order_status: 'ACTIVE',
    }) });
  });
  await service.createPaymentIntent({ orderId: 'ORD-RECEIVER-1', amount: 1 });
  assert.equal(receiver, globalThis);
});

test('Cashfree network failures expose only sanitized diagnostics and keep the app error generic', async () => {
  const messages = [];
  const originalError = console.error;
  console.error = (...args) => messages.push(args);
  try {
    const service = configuredService(async () => {
      const error = new TypeError('fetch failed: connect ECONNREFUSED sandbox.cashfree.com');
      throw error;
    });
    await assert.rejects(
      service.createPaymentIntent({ orderId: 'ORD-NETWORK-1', amount: 1 }),
      /Could not reach Cashfree to create a payment session/i,
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0][0], '[Cashfree] order request failed');
    assert.equal(messages[0][1].name, 'TypeError');
    assert.doesNotMatch(JSON.stringify(messages), /sandbox_secret|x-client-secret/i);
  } finally {
    console.error = originalError;
  }
});

test('Cashfree backend reads the merchant key names provided for this project', () => {
  const previousAppId = process.env.CASHFREE_App_ID;
  const previousSecret = process.env.CASHFREE_KEY_SECRET;
  try {
    process.env.CASHFREE_App_ID = 'test_app_id';
    process.env.CASHFREE_KEY_SECRET = 'test_secret_key';
    const service = new CashfreePaymentGatewayService({ fetchImpl: async () => { throw new Error('not used'); } });
    assert.equal(service.appId, 'test_app_id');
    assert.equal(service.secretKey, 'test_secret_key');
  } finally {
    if (previousAppId === undefined) delete process.env.CASHFREE_App_ID;
    else process.env.CASHFREE_App_ID = previousAppId;
    if (previousSecret === undefined) delete process.env.CASHFREE_KEY_SECRET;
    else process.env.CASHFREE_KEY_SECRET = previousSecret;
  }
});

test('Cashfree verifies server-side amount, currency, order, and successful payment status', async () => {
  const service = configuredService(async (url) => {
    if (url.endsWith('/orders/ORD-1')) return { ok: true, json: async () => ({
      order_id: 'ORD-1', order_amount: 500, order_currency: 'INR', order_status: 'PAID',
    }) };
    if (url.endsWith('/orders/ORD-1/payments')) return { ok: true, json: async () => [{
      cf_payment_id: 'cf_payment_1', payment_status: 'SUCCESS', payment_amount: 500, payment_currency: 'INR',
    }] };
    throw new Error(`Unexpected Cashfree URL ${url}`);
  });

  const paid = await service.verifyCapturedPayment({ orderId: 'ORD-1', paymentId: 'ORD-1', expectedAmount: 500 });
  assert.equal(paid.transaction_id, 'cf_payment_1');
  await assert.rejects(
    service.verifyCapturedPayment({ orderId: 'ORD-1', expectedAmount: 501 }),
    /amount does not match/i,
  );
});

test('Cashfree webhook accepts only timestamp plus raw-body Base64 signatures', () => {
  const service = configuredService(async () => { throw new Error('not used'); });
  const rawBody = Buffer.from('{"type":"PAYMENT_SUCCESS_WEBHOOK"}');
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', 'sandbox_secret')
    .update(`${timestamp}${rawBody.toString('utf8')}`)
    .digest('base64');
  assert.equal(service.verifyWebhookSignature({ rawBody, timestamp, signature }), true);
  assert.equal(service.verifyWebhookSignature({ rawBody, timestamp, signature: 'forged' }), false);
  assert.equal(service.verifyWebhookSignature({ rawBody, timestamp, signature: Buffer.from(signature).toString('hex') }), false);
});

test('Cashfree webhook controller rejects forged requests and acknowledges valid test events idempotently', async () => {
  const secret = 'sandbox_webhook_secret';
  const service = configuredService(async () => { throw new Error('API call not expected'); }, { secretKey: secret });
  const seen = new Set();
  const controller = new CommerceController({
    paymentGatewayService: service,
    orderRepository: { async findById() { return null; } },
    providerWebhookEventRepository: {
      async claim({ eventId }) {
        if (seen.has(eventId)) return { claimed: false, duplicate: true };
        seen.add(eventId);
        return { claimed: true, duplicate: false };
      },
      async markProcessed() {},
      async markFailed() {},
    },
  });
  const payload = {
    type: 'PAYMENT_FAILED_WEBHOOK',
    event_time: new Date().toISOString(),
    data: {
      order: { order_id: 'ORD-CF-WEBHOOK-1', order_amount: 100, order_currency: 'INR' },
      payment: { cf_payment_id: 'cf_pay_test_1', payment_status: 'FAILED' },
    },
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}${rawBody}`).digest('base64');
  const makeResponse = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });

  let forgedError;
  await controller.handlePaymentWebhook({
    body: payload,
    rawBody,
    headers: { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': 'forged' },
  }, makeResponse(), (error) => { forgedError = error; });
  assert.equal(forgedError?.name, 'BadRequestError');
  assert.equal(seen.size, 0);

  const request = {
    body: payload,
    rawBody,
    headers: { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signature },
  };
  const first = makeResponse();
  await controller.handlePaymentWebhook(request, first, (error) => { throw error; });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.data.received, true);

  const duplicate = makeResponse();
  await controller.handlePaymentWebhook(request, duplicate, (error) => { throw error; });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.data.duplicate, true);
  assert.equal(seen.size, 1);
});

test('new checkout requests reject Razorpay and accept only Cashfree for online payment', async () => {
  const checkout = new CheckoutUseCase({});
  await assert.rejects(
    checkout.execute({ userId: 'test-patient', paymentGateway: 'razorpay' }),
    /Unsupported payment method/,
  );
});
