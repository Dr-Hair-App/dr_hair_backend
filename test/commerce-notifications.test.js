import test from 'node:test';
import assert from 'node:assert/strict';
import { CommerceController } from '../src/modules/commerce/presentation/commerce.controller.js';

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function order(status) {
  return {
    user_id: '42',
    order_id: 'ORD-NOTIFY-1',
    fulfillment: { status, tracking_number: 'AWB123' },
    toJSON() { return { order_id: this.order_id, fulfillment: this.fulfillment }; },
  };
}

test('manual fulfillment milestones create user notifications with order destination', async () => {
  const notifications = [];
  const controller = new CommerceController({
    updateFulfillmentUseCase: { async execute({ status }) { return order(status); } },
    notificationRepository: { async create(notification) { notifications.push(notification); return { ...notification, id: 'notif-1' }; } },
    deviceTokenRepository: { async listByUserId() { return []; } },
  });

  for (const status of ['Shipped', 'Delivered', 'Needs attention', 'Preparing']) {
    const res = response();
    await controller.updateFulfillment({ params: { orderId: 'ORD-NOTIFY-1' }, body: { status } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
  }

  assert.deepEqual(notifications.map(({ title }) => title), ['Order shipped', 'Order delivered', 'Order update']);
  assert.ok(notifications.every(({ userId, destination }) => userId === 42 && destination.screen === 'orders'));
  assert.match(notifications[0].body, /AWB123/);
});

test('patient and admin order cancellations create an in-app notification', async () => {
  const notifications = [];
  const controller = new CommerceController({
    cancelOrderUseCase: { async execute() { return order('Cancelled'); } },
    notificationRepository: { async create(notification) { notifications.push(notification); return { id: 'notif-cancel' }; } },
  });

  const patientRes = response();
  await controller.cancelPatientOrder({ user: { id: 42 }, params: { orderId: 'ORD-NOTIFY-1' }, body: {} }, patientRes, (error) => { throw error; });
  const adminRes = response();
  await controller.cancelAdminOrder({ params: { orderId: 'ORD-NOTIFY-1' }, body: {} }, adminRes, (error) => { throw error; });

  assert.equal(notifications.length, 2);
  assert.ok(notifications.every(({ title, userId }) => title === 'Order cancelled' && userId === 42));
});

test('repeating the same admin fulfillment status does not send duplicate milestone notifications', async () => {
  const notifications = [];
  const controller = new CommerceController({
    orderRepository: { async findById() { return order('Shipped'); } },
    updateFulfillmentUseCase: { async execute() { return order('Shipped'); } },
    notificationRepository: { async create(notification) { notifications.push(notification); return { id: 'notif-ship' }; } },
  });
  const res = response();

  await controller.updateFulfillment({ params: { orderId: 'ORD-NOTIFY-1' }, body: { status: 'Shipped' } }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 200);
  assert.equal(notifications.length, 0);
});

test('a new COD checkout sends an order received notification exactly once', async () => {
  const notifications = [];
  const checkoutOrder = {
    user_id: '42',
    order_id: 'ORD-COD-1',
    payment: { gateway: 'cod', payment_status: 'Pending' },
    toJSON() { return { order_id: this.order_id }; },
  };
  const controller = new CommerceController({
    checkoutUseCase: {
      async execute() {
        return { order: checkoutOrder, paymentIntent: null, idempotentReplay: false };
      },
    },
    notificationRepository: {
      async create(notification) {
        notifications.push(notification);
        return { ...notification, id: 'notif-cod' };
      },
    },
    deviceTokenRepository: { async listByUserId() { return []; } },
  });

  const res = response();
  await controller.checkout({
    user: { id: 42 },
    headers: {},
    body: { shipping_quote_id: 'quote-1' },
  }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 201);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Order received');
  assert.equal(notifications[0].destination.screen, 'orders');
});

test('successful Razorpay verification sends a payment confirmation notification', async () => {
  const notifications = [];
  const before = {
    user_id: '42', order_id: 'ORD-PAID-1',
    payment: { payment_status: 'Pending' },
  };
  const settled = {
    ...before,
    payment: { payment_status: 'Paid' },
    toJSON() { return { order_id: this.order_id, payment: this.payment }; },
  };
  const controller = new CommerceController({
    orderRepository: { async findById() { return before; } },
    verifyPaymentUseCase: { async execute() { return settled; } },
    notificationRepository: {
      async create(notification) {
        notifications.push(notification);
        return { ...notification, id: 'notif-paid' };
      },
    },
    deviceTokenRepository: { async listByUserId() { return []; } },
  });

  const res = response();
  await controller.verifyPayment({
    user: { id: 42 },
    body: { order_id: 'ORD-PAID-1', payment_id: 'pay-1', payment_signature: 'signature' },
  }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 200);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Payment confirmed');
  assert.equal(notifications[0].destination.entityId, 'ORD-PAID-1');
});
