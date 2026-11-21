import test from 'node:test';
import assert from 'node:assert/strict';
import { AppointmentController } from '../src/modules/appointments/presentation/appointment.controller.js';
import { AdminController } from '../src/modules/admin/presentation/admin.controller.js';
import { store } from '../src/shared/database/store.js';

function mockResponse() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('clinic staff cannot create an appointment falsely marked as Razorpay-paid', async () => {
  let created = false;
  const controller = new AppointmentController({
    appointmentRepository: { async create() { created = true; } },
    userRepository: { async findById() { return { id: 7, role: 'user', patient_code: 'PT-7' }; } },
  });
  controller.validateSlot = async () => {};
  controller.getScheduleConfig = async () => ({ timezone: 'Asia/Kolkata', appointment_services: ['Consultation'] });
  controller.getBillingConfig = async () => ({ consultation_fee: 500 });
  let error;
  await controller.createAdmin({
    body: { patient_id: 7, starts_at: '2027-01-05T05:00:00.000Z', payment_status: 'Paid', payment_method: 'Razorpay' },
  }, {}, (reason) => { error = reason; });

  assert.equal(error?.name, 'BadRequestError');
  assert.match(error.message, /payment verification flow/i);
  assert.equal(created, false);
});

test('clinic staff cannot override an unresolved Razorpay appointment payment', async () => {
  let updated = false;
  const controller = new AppointmentController({
    appointmentRepository: {
      async findById() {
        return {
          id: 'APT-2027-0001', userId: 7, status: 'Confirmed', starts_at: '2027-01-05T05:00:00.000Z',
          payment_status: 'Pending', payment_method: 'Razorpay', payment_transaction_id: '', consultation_fee: 500,
        };
      },
      async update() { updated = true; },
    },
  });
  let error;
  await controller.updateAdmin({
    params: { appointmentId: 'APT-2027-0001' },
    body: { payment_status: 'Paid', payment_method: 'Cash' },
  }, {}, (reason) => { error = reason; });

  assert.equal(error?.name, 'BadRequestError');
  assert.match(error.message, /provider-managed/i);
  assert.equal(updated, false);
});

test('Razorpay appointment refunds use provider state and stay pending until webhook confirmation', async () => {
  let appointment = {
    id: 'APT-2027-0002', userId: 7, status: 'Confirmed', starts_at: '2027-01-05T05:00:00.000Z',
    timezone: 'Asia/Kolkata', patient_code: 'PT-7', consultation_fee: 750, payment_status: 'Paid',
    payment_method: 'Razorpay', payment_transaction_id: 'pay_appointment_1', refunds: [], status_history: [],
  };
  let providerCalls = 0;
  const notifications = [];
  const controller = new AppointmentController({
    appointmentRepository: {
      async findById() { return appointment; },
      async update(_id, patch, event) {
        appointment = { ...appointment, ...patch, status_history: [...appointment.status_history, event] };
        return appointment;
      },
    },
    paymentGatewayService: {
      async refundCapturedPayment(input) {
        providerCalls += 1;
        assert.equal(input.paymentId, 'pay_appointment_1');
        assert.equal(input.amount, 250);
        return { id: 'rfnd_appointment_1', status: 'pending' };
      },
    },
    notificationRepository: { async create(input) { notifications.push(input); return { id: 'notif-refund' }; } },
    auditEventRepository: { async record() {} },
  });
  const res = mockResponse();
  let error;
  await controller.refundAdmin({
    params: { appointmentId: appointment.id }, user: { id: 2, email: 'clinic@example.test' },
    body: { amount: 250, reason: 'Patient request' },
  }, res, (reason) => { error = reason; });

  assert.equal(error, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(appointment.payment_status, 'Paid');
  assert.equal(appointment.refund_status, 'pending');
  assert.equal(appointment.refund_pending_amount, 250);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].title, /requested/i);

  const retryResponse = mockResponse();
  let retryError;
  await controller.refundAdmin({ params: { appointmentId: appointment.id }, body: {} }, retryResponse, (reason) => { retryError = reason; });
  assert.equal(retryError?.name, 'ConflictError');
  assert.equal(providerCalls, 1);
});

test('admin payment ledger reports appointment refunds and subtracts processed refund from net collected', async (t) => {
  const previousAppointments = store.appointments;
  store.appointments = [{
    id: 'APT-2027-0003', userId: 7, patient_code: 'PT-7', consultation_fee: 700,
    payment_status: 'Paid', payment_method: 'Razorpay', payment_transaction_id: 'pay_ledger_1',
    refund_status: 'processed', refund_amount: 200, refund_pending_amount: 0,
    refunds: [{ id: 'rfnd_ledger_1', amount: 200, status: 'processed' }],
    payment_time: new Date('2026-11-01T10:00:00.000Z'),
  }];
  t.after(() => { store.appointments = previousAppointments; });
  let requestedUserIds = null;
  const controller = new AdminController({
    userRepository: {
      async findByIds(ids) {
        requestedUserIds = ids;
        return [{ id: 7, name: 'Test Patient', phone: '9000000000', email: 'patient@example.test' }];
      },
    },
  });
  const res = mockResponse();

  await controller.listReceivedPayments({ query: { type: 'appointment' } }, res, (error) => { throw error; });

  const payment = res.body.data.items[0];
  assert.equal(payment.gateway, 'razorpay');
  assert.deepEqual(requestedUserIds, [7]);
  assert.equal(payment.customer_name, 'Test Patient');
  assert.equal(payment.refund_amount, 200);
  assert.equal(payment.refunds[0].id, 'rfnd_ledger_1');
  assert.equal(res.body.data.summary.total_collected, 500);
  assert.equal(res.body.data.summary.appointment_revenue, 500);
});
