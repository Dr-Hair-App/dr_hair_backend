import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/shared/database/store.js';
import { ProviderWebhookEventRepository } from '../src/modules/commerce/infrastructure/ProviderWebhookEventRepository.js';
import { CommerceController } from '../src/modules/commerce/presentation/commerce.controller.js';
import { AppointmentController } from '../src/modules/appointments/presentation/appointment.controller.js';
import { Order } from '../src/modules/commerce/domain/Order.js';

function mockResponse() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function mergeOrder(order, patch) {
  const value = order.toJSON();
  for (const [key, next] of Object.entries(patch)) {
    value[key] = next && typeof next === 'object' && !Array.isArray(next)
      ? { ...value[key], ...next }
      : next;
  }
  return new Order(value);
}

test('Razorpay event inbox claims once and retries events that previously failed', async (t) => {
  const original = store.providerWebhookEvents;
  store.providerWebhookEvents = [];
  t.after(() => { store.providerWebhookEvents = original; });
  const repository = new ProviderWebhookEventRepository();
  const event = { provider: 'razorpay', eventId: 'evt_1', eventType: 'payment.captured', payloadHash: 'hash' };

  assert.deepEqual(await repository.claim(event), { claimed: true, duplicate: false });
  assert.deepEqual(await repository.claim(event), { claimed: false, duplicate: true });
  await repository.markFailed({ provider: 'razorpay', eventId: 'evt_1', errorCode: 'temporary' });
  assert.deepEqual(await repository.claim(event), { claimed: true, duplicate: false });
  await repository.markProcessed({ provider: 'razorpay', eventId: 'evt_1' });
  assert.deepEqual(await repository.claim(event), { claimed: false, duplicate: true });
});

test('signed duplicate Razorpay webhook is acknowledged without repeating payment settlement', async (t) => {
  const original = store.providerWebhookEvents;
  store.providerWebhookEvents = [];
  t.after(() => { store.providerWebhookEvents = original; });
  let settlementCalls = 0;
  const controller = new CommerceController({
    providerWebhookEventRepository: new ProviderWebhookEventRepository(),
    paymentGatewayService: { verifyWebhookSignature: () => true },
    verifyPaymentUseCase: { async execute() { settlementCalls += 1; } },
  });
  const payload = {
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_test_1', notes: { app_order_id: 'ORD-1' } } } },
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const request = {
    body: payload,
    rawBody,
    headers: { 'x-razorpay-signature': 'verified-by-stub', 'x-razorpay-event-id': 'evt_duplicate_test' },
  };

  const firstResponse = mockResponse();
  let firstError;
  await controller.handlePaymentWebhook(request, firstResponse, (error) => { firstError = error; });
  assert.equal(firstError, undefined);
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(settlementCalls, 1);

  const duplicateResponse = mockResponse();
  let duplicateError;
  await controller.handlePaymentWebhook(request, duplicateResponse, (error) => { duplicateError = error; });
  assert.equal(duplicateError, undefined);
  assert.equal(duplicateResponse.statusCode, 200);
  assert.equal(duplicateResponse.body.data.duplicate, true);
  assert.equal(settlementCalls, 1);
});

test('appointment payment webhook recovers the booking idempotently from Razorpay order notes', async () => {
  const records = [];
  const notifications = [];
  const startsAt = '2026-12-04T05:00:00.000Z';
  const notes = {
    app_order_id: 'APT-1796371000000-7-abcdef12',
    patient_id: '7',
    starts_at: startsAt,
    consultation_fee: '750',
    reason: 'Consultation',
  };
  const controller = new AppointmentController({
    appointmentRepository: {
      async findByPaymentTransactionId(id) { return records.find((record) => record.payment_transaction_id === id) || null; },
      async create(data) { const record = { id: `APT-${records.length + 1}`, opd_token: 'OPD-1', ...data }; records.push(record); return record; },
    },
    userRepository: { async findById() { return { id: 7, patient_code: 'PT-7' }; } },
    patientActivityRepository: { async record() {} },
    notificationRepository: { async create(data) { notifications.push(data); return { id: `notif-${notifications.length}` }; } },
    paymentGatewayService: {
      async getPaymentOrder(id) { return { id, notes, amount: 75000, currency: 'INR' }; },
      async verifyCapturedPayment(input) { assert.deepEqual(input, { paymentId: 'pay_apt_1', expectedOrderId: 'order_apt_1', expectedAmount: 750, currency: 'INR' }); },
    },
  });
  controller.getScheduleConfig = async () => ({ timezone: 'Asia/Kolkata', doctor_name: 'Clinic doctor', room: 'Consultation room' });
  controller.validateSlot = async () => {};
  const paymentEntity = {
    id: 'pay_apt_1', order_id: 'order_apt_1', amount: 75000, currency: 'INR', notes,
  };

  const first = await controller.recoverCapturedPaymentFromWebhook(paymentEntity);
  const retry = await controller.recoverCapturedPaymentFromWebhook(paymentEntity);
  assert.equal(first.payment_status, 'Paid');
  assert.equal(first.status, 'Confirmed');
  assert.equal(first.reason, 'Consultation');
  assert.equal(retry.id, first.id);
  assert.equal(records.length, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'appointment');
});

test('Razorpay refund and failed-payment events update provider state without double-counting refunds', async (t) => {
  const originalEvents = store.providerWebhookEvents;
  store.providerWebhookEvents = [];
  t.after(() => { store.providerWebhookEvents = originalEvents; });
  let order = new Order({
    order_id: 'ORD-WEBHOOK-REFUND', user_id: '7',
    customer: { name: 'Test patient', phone: '9000000000' },
    items: [{ product_id: 'p1', title: 'Product', price: 100, quantity: 1 }],
    shipping_address: { name: 'Test patient', phone: '9000000000', house_number: '1', street: 'Road', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' },
    pricing: { subtotal: 100, total: 100 },
    payment: { payment_status: 'Paid', gateway: 'razorpay', transaction_id: 'pay_order_1', payment_intent_id: 'order_1' },
    fulfillment: { status: 'Preparing' },
  });
  const notifications = [];
  const controller = new CommerceController({
    providerWebhookEventRepository: new ProviderWebhookEventRepository(),
    paymentGatewayService: { verifyWebhookSignature: () => true },
    notificationRepository: { async create(data) { notifications.push(data); return { id: `notif-${notifications.length}` }; } },
    orderRepository: {
      async findByPaymentTransactionId(id) { return id === order.payment.transaction_id ? order : null; },
      async findById(id) { return id === order.order_id ? order : null; },
      async update(_id, patch) { order = mergeOrder(order, patch); return order; },
    },
  });

  async function deliver(event, entity, eventId) {
    const body = { event, payload: { [event.startsWith('refund.') ? 'refund' : 'payment']: { entity } } };
    const request = { body, rawBody: Buffer.from(JSON.stringify(body)), headers: { 'x-razorpay-signature': 'valid', 'x-razorpay-event-id': eventId } };
    const response = mockResponse();
    let error;
    await controller.handlePaymentWebhook(request, response, (reason) => { error = reason; });
    if (error) throw error;
    return response;
  }

  const refund = { id: 'rfnd_1', payment_id: 'pay_order_1', amount: 3000, currency: 'INR' };
  await deliver('refund.created', refund, 'evt_refund_created');
  await deliver('refund.processed', refund, 'evt_refund_processed');
  await deliver('refund.processed', refund, 'evt_refund_processed_retry');
  assert.equal(order.payment.refunds.length, 1);
  assert.equal(order.payment.refund_amount, 30);
  assert.equal(order.payment.refund_status, 'processed');
  assert.equal(order.payment.payment_status, 'Partially refunded');
  assert.equal(notifications.filter((item) => item.title === 'Refund processed').length, 1);

  const failedPayment = { id: 'pay_failed_attempt', order_id: 'order_1', error_code: 'BAD_REQUEST_ERROR', notes: { app_order_id: order.order_id } };
  await deliver('payment.failed', failedPayment, 'evt_payment_failed');
  assert.equal(order.payment.payment_status, 'Partially refunded');
  assert.equal(order.payment.gateway_status, 'failed_attempt');
  assert.equal(order.payment.last_failure_code, 'BAD_REQUEST_ERROR');
});

test('Razorpay appointment refund webhooks persist status and notify after provider confirmation', async (t) => {
  const originalEvents = store.providerWebhookEvents;
  store.providerWebhookEvents = [];
  t.after(() => { store.providerWebhookEvents = originalEvents; });
  const notifications = [];
  let appointment = {
    id: 'APT-2026-0081', userId: 7, patient_code: 'PT-7', status: 'Confirmed',
    starts_at: '2026-12-04T05:00:00.000Z', consultation_fee: 750,
    payment_status: 'Paid', payment_method: 'Razorpay', payment_transaction_id: 'pay_appt_refund_1',
    refunds: [], status_history: [],
  };
  const appointmentController = new AppointmentController({
    appointmentRepository: {
      async findByPaymentTransactionId(paymentId) { return appointment.payment_transaction_id === paymentId ? appointment : null; },
      async update(id, patch, event) {
        appointment = { ...appointment, ...patch, status_history: [...appointment.status_history, event] };
        return appointment;
      },
    },
    notificationRepository: { async create(data) { notifications.push(data); return { id: `notif-${notifications.length}` }; } },
    deviceTokenRepository: { async listByUserId() { return []; } },
  });
  const controller = new CommerceController({
    providerWebhookEventRepository: new ProviderWebhookEventRepository(),
    paymentGatewayService: { verifyWebhookSignature: () => true },
    orderRepository: { async findByPaymentTransactionId() { return null; } },
    appointmentController,
  });

  const deliver = async (event, id, eventId) => {
    const payload = { event, payload: { refund: { entity: { id, payment_id: 'pay_appt_refund_1', amount: 75000, currency: 'INR' } } } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const res = mockResponse();
    let error;
    await controller.handlePaymentWebhook({
      body: payload, rawBody,
      headers: { 'x-razorpay-signature': 'signed-by-test', 'x-razorpay-event-id': eventId },
    }, res, (reason) => { error = reason; });
    assert.equal(error, undefined);
    assert.equal(res.statusCode, 200);
  };

  await deliver('refund.created', 'rfnd_appt_1', 'evt_appt_refund_created');
  assert.equal(appointment.refund_status, 'pending');
  assert.equal(appointment.payment_status, 'Paid');
  await deliver('refund.processed', 'rfnd_appt_1', 'evt_appt_refund_processed');
  assert.equal(appointment.refund_status, 'processed');
  assert.equal(appointment.payment_status, 'Refunded');
  assert.equal(appointment.refund_amount, 750);
  assert.equal(appointment.refunds.length, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'appointment');
  await deliver('refund.processed', 'rfnd_appt_1', 'evt_appt_refund_processed');
  assert.equal(notifications.length, 1);
});
