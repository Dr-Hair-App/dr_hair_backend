import test from 'node:test';
import assert from 'node:assert/strict';
import { CreateShiprocketShipmentUseCase } from '../src/modules/commerce/application/CreateShiprocketShipmentUseCase.js';
import { CancelOrderUseCase } from '../src/modules/commerce/application/CancelOrderUseCase.js';
import { CreateShiprocketReturnUseCase } from '../src/modules/commerce/application/CreateShiprocketReturnUseCase.js';
import { CommerceController } from '../src/modules/commerce/presentation/commerce.controller.js';
import { Order } from '../src/modules/commerce/domain/Order.js';

function makeOrder(overrides = {}) {
  return new Order({
    order_id: 'ORD-SR-TEST',
    user_id: 'patient-1',
    items: [{ product_id: 'serum-1', title: 'Serum', price: 100, quantity: 1 }],
    pricing: { subtotal: 100, delivery_fee: 0, total: 100 },
    payment: { gateway: 'cod', payment_status: 'Pending' },
    fulfillment: { status: 'Preparing', ...overrides },
  });
}

function mergeOrder(order, patch) {
  const data = order.toJSON();
  for (const [key, value] of Object.entries(patch)) {
    data[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...data[key], ...value }
      : value;
  }
  return new Order(data);
}

test('creating a Shiprocket AWB requests pickup but does not claim courier handoff', async () => {
  let order = makeOrder();
  const orderRepository = {
    async findById() { return order; },
    async claimShiprocketShipment() {
      order = mergeOrder(order, { fulfillment: { shiprocket_status: 'processing' } });
      return order;
    },
    async update(_id, patch) {
      order = mergeOrder(order, patch);
      return order;
    },
  };
  const useCase = new CreateShiprocketShipmentUseCase({
    orderRepository,
    shiprocketService: {
      assertConfigured() {},
      validateOrder() {},
      async createForwardShipment() {
        return { shipmentId: '12345', awbCode: 'AWB-12345', courierName: 'Test Courier' };
      },
    },
  });

  const created = await useCase.execute({ orderId: 'ORD-SR-TEST' });
  assert.equal(created.fulfillment.status, 'Preparing');
  assert.equal(created.fulfillment.shipped_at, null);
  assert.equal(created.fulfillment.awb_code, 'AWB-12345');
  assert.equal(created.fulfillment.shiprocket_status, 'created');
  assert.match(created.timeline.at(-1).label, /awaiting courier handoff/i);
});

test('order cancellation first confirms Shiprocket cancellation before releasing reserved stock', async () => {
  let released = false;
  let carrierCancelled = false;
  let order = makeOrder({ shiprocket_shipment_id: '12345', awb_code: 'AWB-12345' });
  const useCase = new CancelOrderUseCase({
    orderRepository: {
      async findById() { return order; },
      async update(_id, patch) { order = mergeOrder(order, patch); return order; },
    },
    inventoryRepository: { async releaseStock() { released = true; } },
    shiprocketService: { async cancelShipment() { carrierCancelled = true; } },
  });

  const cancelled = await useCase.execute({ orderId: 'ORD-SR-TEST', userId: 'patient-1' });
  assert.equal(carrierCancelled, true);
  assert.equal(released, true);
  assert.equal(cancelled.fulfillment.status, 'Cancelled');
});

test('reverse shipment is available only for a reviewed return and cannot be duplicated', async () => {
  let order = new Order({
    order_id: 'ORD-SR-RETURN', user_id: 'patient-1',
    customer: { name: 'Test Patient', email: 'patient@example.test', phone: '9876543210' },
    items: [{ product_id: 'serum-1', title: 'Serum', price: 100, quantity: 1 }],
    shipping_address: { house_number: '1', street: 'Main Road', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' },
    pricing: { subtotal: 100, total: 100 },
    fulfillment: { status: 'Return requested', shiprocket_package: { weight_kg: 0.2, length_cm: 10, breadth_cm: 8, height_cm: 4 } },
  });
  const repository = {
    async findById() { return order; },
    async claimShiprocketReturn() {
      order = mergeOrder(order, { fulfillment: { shiprocket_status: 'return_processing' } });
      return order;
    },
    async update(_id, patch) { order = mergeOrder(order, patch); return order; },
  };
  let created = 0;
  const useCase = new CreateShiprocketReturnUseCase({
    orderRepository: repository,
    shiprocketService: { async createReturnShipment() { created += 1; return { shipmentId: 'ret-12', awbCode: 'RET-AWB-12' }; } },
  });
  const returned = await useCase.execute({ orderId: 'ORD-SR-RETURN' });
  assert.equal(returned.fulfillment.shiprocket_return_awb, 'RET-AWB-12');
  await assert.rejects(useCase.execute({ orderId: 'ORD-SR-RETURN' }), /already associated/i);
  assert.equal(created, 1);
});

test('reverse carrier webhook updates return tracking without replacing the order return status', async (t) => {
  const oldSecret = process.env.SHIPROCKET_WEBHOOK_SECRET;
  process.env.SHIPROCKET_WEBHOOK_SECRET = 'webhook-test-key';
  t.after(() => {
    if (oldSecret === undefined) delete process.env.SHIPROCKET_WEBHOOK_SECRET;
    else process.env.SHIPROCKET_WEBHOOK_SECRET = oldSecret;
  });
  let order = new Order({
    order_id: 'ORD-SR-RETURN-WEBHOOK', user_id: 'patient-1',
    items: [{ product_id: 'serum-1', title: 'Serum', price: 100, quantity: 1 }],
    pricing: { subtotal: 100, total: 100 },
    fulfillment: { status: 'Return requested', awb_code: 'FORWARD-AWB', shiprocket_return_awb: 'RETURN-AWB' },
  });
  const controller = new CommerceController({
    orderRepository: {
      async findByAwb() { return order; },
      async update(_id, patch) { order = mergeOrder(order, patch); return order; },
    },
  });
  const req = {
    body: { awb: 'RETURN-AWB', shipment_status: 'IN TRANSIT', shipment_status_id: 18, current_timestamp: '2026-11-14 10:00:00' },
    get(name) { return name === 'x-api-key' ? 'webhook-test-key' : ''; },
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextError;
  await controller.handleCarrierWebhook(req, res, (error) => { nextError = error; });
  assert.equal(nextError, undefined);
  assert.equal(order.fulfillment.status, 'Return requested');
  assert.equal(order.fulfillment.shiprocket_return_status, 'IN TRANSIT');
  assert.equal(order.fulfillment.shiprocket_events[0].awb_code, 'RETURN-AWB');
});

test('carrier webhook maps current scan status and timestamp from Shiprocket payload', async (t) => {
  const oldSecret = process.env.SHIPROCKET_WEBHOOK_SECRET;
  process.env.SHIPROCKET_WEBHOOK_SECRET = 'webhook-test-key';
  t.after(() => {
    if (oldSecret === undefined) delete process.env.SHIPROCKET_WEBHOOK_SECRET;
    else process.env.SHIPROCKET_WEBHOOK_SECRET = oldSecret;
  });

  let order = new Order({
    order_id: 'ORD-SR-CURRENT-SCAN', user_id: '123',
    items: [{ product_id: 'serum-1', title: 'Serum', price: 100, quantity: 1 }],
    pricing: { subtotal: 100, total: 100 },
    fulfillment: { status: 'Preparing', awb_code: 'CURRENT-AWB' },
  });
  const notifications = [];
  const controller = new CommerceController({
    notificationRepository: { async create(data) { notifications.push(data); return { id: 'notification-delivered' }; } },
    orderRepository: {
      async findByAwb() { return order; },
      async update(_id, patch) { order = mergeOrder(order, patch); return order; },
    },
  });
  const req = {
    body: {
      awb: 'CURRENT-AWB',
      current_status: 'DELIVERED',
      current_status_id: 7,
      shipment_status: 'IN TRANSIT',
      shipment_status_id: 9,
      current_timestamp: '09 09 2026 16:13:13',
    },
    get(name) { return name === 'x-api-key' ? 'webhook-test-key' : ''; },
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextError;
  await controller.handleCarrierWebhook(req, res, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(order.fulfillment.status, 'Delivered');
  assert.equal(order.fulfillment.shiprocket_events[0].status_code, 7);
  assert.equal(order.fulfillment.shiprocket_events[0].timestamp, '09 09 2026 16:13:13');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Order delivered');
});
