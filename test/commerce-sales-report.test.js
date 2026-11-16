import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderRepository } from '../src/modules/commerce/infrastructure/OrderRepository.js';
import { CommerceController } from '../src/modules/commerce/presentation/commerce.controller.js';
import { store } from '../src/shared/database/store.js';

test('commerce sales report buckets captured order totals net of recorded refunds', async (t) => {
  const original = store.orders;
  store.orders = [
    { order_id: 'ORD-PAID', created_at: '2026-11-16T08:00:00.000Z', pricing: { total: 100 }, payment: { payment_status: 'Partially refunded', refund_amount: 20 } },
    { order_id: 'ORD-REFUNDED', created_at: '2026-11-16T09:00:00.000Z', pricing: { total: 50 }, payment: { payment_status: 'Refunded', refund_amount: 50 } },
    { order_id: 'ORD-PENDING', created_at: '2026-11-16T10:00:00.000Z', pricing: { total: 900 }, payment: { payment_status: 'Pending', refund_amount: 0 } },
    { order_id: 'ORD-OLD', created_at: '2026-10-30T10:00:00.000Z', pricing: { total: 500 }, payment: { payment_status: 'Paid', refund_amount: 0 } },
  ];
  t.after(() => { store.orders = original; });
  const report = await new OrderRepository().getSalesReport('month', new Date('2026-11-16T12:00:00.000Z'));
  const today = report.buckets.find((bucket) => bucket.key === '2026-11-16');

  assert.equal(report.period, 'month');
  assert.equal(report.totals.order_count, 2);
  assert.equal(report.totals.gross_sales, 150);
  assert.equal(report.totals.refunds, 70);
  assert.equal(report.totals.net_sales, 80);
  assert.deepEqual(today, { key: '2026-11-16', label: '', order_count: 2, gross_sales: 150, refunds: 70, net_sales: 80 });
});

test('commerce sales report returns all seven UTC week buckets', async (t) => {
  const original = store.orders;
  store.orders = [];
  t.after(() => { store.orders = original; });
  const report = await new OrderRepository().getSalesReport('week', new Date('2026-11-18T12:00:00.000Z'));
  assert.equal(report.buckets.length, 7);
  assert.equal(report.buckets[0].key, '2026-11-16');
  assert.equal(report.buckets[6].key, '2026-11-22');
});

test('admin sales report controller rejects invalid periods and returns repository data', async () => {
  const calls = [];
  const controller = new CommerceController({
    orderRepository: { async getSalesReport(period) { calls.push(period); return { period, totals: {}, buckets: [] }; } },
  });
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  let error;
  await controller.getSalesReport({ query: { period: 'all' } }, response, (reason) => { error = reason; });
  assert.equal(error?.statusCode, 400);
  assert.deepEqual(calls, []);

  const validResponse = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  error = undefined;
  await controller.getSalesReport({ query: { period: 'year' } }, validResponse, (reason) => { error = reason; });
  assert.equal(error, undefined);
  assert.deepEqual(calls, ['year']);
  assert.equal(validResponse.body.data.period, 'year');
});
