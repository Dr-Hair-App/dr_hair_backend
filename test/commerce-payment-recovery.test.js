import test from 'node:test';
import assert from 'node:assert/strict';
import { CommerceController } from '../src/modules/commerce/presentation/commerce.controller.js';
import { Order } from '../src/modules/commerce/domain/Order.js';

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function pendingOrder(userId = '7') {
  return new Order({
    order_id: 'ORD-RECOVER-1', user_id: userId,
    customer: { name: 'Patient', phone: '9000000000' },
    items: [{ product_id: 'p1', title: 'Product', price: 500, quantity: 1 }],
    shipping_address: { name: 'Patient', phone: '9000000000', house_number: '1', street: 'Road', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' },
    pricing: { subtotal: 500, total: 500 },
    payment: { gateway: 'cashfree', payment_status: 'Pending', payment_intent_id: 'order_recover_1', payment_session_id: 'session_recover_1' },
    fulfillment: { status: 'Preparing' },
  });
}

test('patient payment recovery captures an authorized attempt and settles the saved order', async () => {
  const order = pendingOrder();
  const controller = new CommerceController({
    orderRepository: { async findById() { return order; } },
    paymentGatewayService: { async getOrderPayments() { return [{ id: 'pay_auth_1', status: 'authorized' }]; } },
    verifyPaymentUseCase: { async execute(input) {
      assert.equal(input.orderId, order.order_id);
      assert.equal(input.paymentId, 'pay_auth_1');
      assert.equal(input.isWebhook, true);
      const paid = order.toJSON();
      paid.payment = { ...paid.payment, payment_status: 'Paid', transaction_id: 'pay_auth_1' };
      return new Order(paid);
    } },
  });
  const res = response();
  await controller.reconcilePatientPayment({ user: { id: 7 }, params: { orderId: order.order_id } }, res, (error) => { throw error; });

  assert.equal(res.body.data.paid, true);
  assert.equal(res.body.data.can_retry, false);
  assert.equal(res.body.data.order.payment.payment_status, 'Paid');
});

test('patient payment recovery only enables retry after provider reports all attempts failed', async () => {
  const order = pendingOrder();
  const controller = new CommerceController({
    orderRepository: { async findById() { return order; } },
    paymentGatewayService: { async getOrderPayments() { return [{ id: 'pay_failed_1', status: 'failed' }]; } },
  });
  const res = response();
  await controller.reconcilePatientPayment({ user: { id: 7 }, params: { orderId: order.order_id } }, res, (error) => { throw error; });
  assert.equal(res.body.data.paid, false);
  assert.equal(res.body.data.can_retry, true);
});

test('patient payment recovery refuses to disclose another users order', async () => {
  const order = pendingOrder('8');
  const controller = new CommerceController({ orderRepository: { async findById() { return order; } } });
  let error;
  await controller.reconcilePatientPayment({ user: { id: 7 }, params: { orderId: order.order_id } }, response(), (reason) => { error = reason; });
  assert.equal(error?.name, 'ForbiddenError');
});
