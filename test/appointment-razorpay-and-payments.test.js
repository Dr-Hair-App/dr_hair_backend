import test from 'node:test';
import assert from 'node:assert/strict';
import { createContainer } from '../src/container.js';
import { ConflictError } from '../src/shared/errors/index.js';

const createMockRes = () => {
  const res = {
    statusCode: 200,
    data: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.data = payload;
      return this;
    },
  };
  return res;
};

test('Appointment Cashfree Billing & Admin Received Payments', async (t) => {
  const mockPaymentGatewayService = {
    provider: 'cashfree', environment: 'TEST',
    async assertConfigured() {},
    async createPaymentIntent({ orderId, amount, currency }) { return { intentId: orderId, orderId, payment_session_id: `session_${orderId}`, gateway: 'cashfree', amount: amount * 100, currency }; },
    async getPaymentOrder(orderId) { return verifiedOrder?.order_id === orderId ? verifiedOrder : null; },
    async verifyCapturedPayment({ paymentId }) { if (paymentId === 'pay_test_uncaptured') throw new Error('Cashfree payment is not captured.'); return { transaction_id: paymentId, payment: { cf_payment_id: paymentId, payment_status: 'SUCCESS' } }; },
    async refundCapturedPayment() { return { id: 'refund_test', status: 'pending' }; },
  };
  let verifiedOrder = null;
  const container = createContainer({ paymentGatewayService: mockPaymentGatewayService });
  const { appointmentController, adminController } = container.controllers;
  const { userRepository } = container.repositories;
  const { paymentGatewayService } = container.services;

  await container.repositories.featureFlagRepository.setFlag('clinic_appointment_schedule', {
    group: 'Appointments', enabled: true,
    metadata: { booking_window_days: 90, weekly_closed_weekdays: [7], slot_interval_minutes: 30, appointment_duration_minutes: 30, appointment_services: ['Consultation'], sessions: [
      { label: 'Morning Session', opens_at: '10:00', closes_at: '12:30' },
      { label: 'Evening Session', opens_at: '15:30', closes_at: '18:30' },
    ] },
  });


  const patient = await userRepository.create({
    phone: '9876543210',
    name: 'Cashfree Test Patient',
    email: 'cashfree.patient@example.com',
    role: 'user',
  });

  await t.test('1. Reports appointment billing defaults until an admin saves it', async () => {
    const res = createMockRes();
    await appointmentController.getBillingConfigPatient({}, res, (err) => { if (err) throw err; });
    assert.equal(res.data.data.payment_required, false);
    assert.equal(res.data.data.configured, true);
    assert.equal(res.data.data.consultation_fee, 500);
  });

  await t.test('2. Admin updates appointment billing to require payment (ON) and fee to ₹650', async () => {
    const req = {
      user: { email: 'admin@drhair.com', role: 'super-admin' },
      body: {
        payment_required: true,
        consultation_fee: 650,
      },
    };
    const res = createMockRes();
    await appointmentController.updateBillingConfigAdmin(req, res, (err) => { if (err) throw err; });
    assert.equal(res.data.data.payment_required, true);
    assert.equal(res.data.data.consultation_fee, 650);

    const patientRes = createMockRes();
    await appointmentController.getBillingConfigPatient({}, patientRes, () => {});
    assert.equal(patientRes.data.data.payment_required, true);
    assert.equal(patientRes.data.data.consultation_fee, 650);
  });

  await t.test('3. Patient cannot book directly without payment when payment_required is true', async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + ((1 + 7 - futureDate.getDay()) % 7 || 7));
    futureDate.setHours(10, 0, 0, 0);

    const req = {
      user: { id: patient.id },
      body: {
        starts_at: futureDate.toISOString(),
        reason: 'Severe scalp itching',
      },
    };

    let errorThrown = null;
    const res = createMockRes();
    await appointmentController.createPatient(req, res, (err) => { errorThrown = err; });
    assert.ok(errorThrown);
    assert.match(errorThrown.message, /Online payment is required/i);
  });

  await t.test('4. Patient creates a Cashfree sandbox payment intent for appointment', async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + ((1 + 7 - futureDate.getDay()) % 7 || 7));
    futureDate.setHours(10, 30, 0, 0);

    const req = {
      user: { id: patient.id },
      body: {
        starts_at: futureDate.toISOString(),
        reason: 'General hair & scalp consultation',
      },
    };
    const res = createMockRes();
    await appointmentController.createPaymentIntent(req, res, (err) => { if (err) throw err; });
    assert.ok(res.data.data.orderId);
    assert.equal(res.data.data.amount, 65000);
    assert.equal(res.data.data.amountFormatted, 650);
    assert.equal(res.data.data.currency, 'INR');
  });

  await t.test('5. Patient verifies Cashfree payment and books appointment via verifyAndBook', async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + ((1 + 7 - futureDate.getDay()) % 7 || 7));
    futureDate.setHours(11, 0, 0, 0);

    const cashfreeOrderId = 'APT-123-' + patient.id + '-deadbeef';
    const cashfreePaymentId = 'pay_test_apt_888';
    verifiedOrder = {
      order_id: cashfreeOrderId,
      order_amount: 650,
      order_currency: 'INR',
      order_status: 'ACTIVE',
      order_tags: {
        app_order_id: cashfreeOrderId,
        patient_id: String(patient.id),
        starts_at: futureDate.toISOString(),
        consultation_fee: '650',
        reason: 'Follicular assessment',
      },
    };

    const req = {
      user: { id: patient.id },
      body: {
        starts_at: futureDate.toISOString(),
        reason: 'Follicular assessment',
        cashfree_order_id: cashfreeOrderId,
        payment_id: cashfreePaymentId,
      },
    };
    const res = createMockRes();
    await appointmentController.verifyAndBook(req, res, (err) => { if (err) throw err; });
    assert.equal(res.data.data.status, 'Confirmed');
    assert.equal(res.data.data.paymentStatus, 'Paid');
    assert.equal(res.data.data.paymentMethod, 'Cashfree');
    assert.equal(res.data.data.paymentTransactionId, cashfreePaymentId);
    assert.equal(res.data.data.consultationFee, 650);
    assert.ok(res.data.data.tokenNumber);

    const retryRes = createMockRes();
    await appointmentController.verifyAndBook(req, retryRes, (err) => { if (err) throw err; });
    assert.equal(retryRes.data.data.id, res.data.data.id);
    assert.equal((await container.repositories.appointmentRepository.listByPatient(patient.id)).length, 1);

    verifiedOrder.order_tags.patient_id = String(patient.id + 999);
    const mismatchedPaymentId = 'pay_test_wrong_patient';
    let mismatchError = null;
    await appointmentController.verifyAndBook({
      user: { id: patient.id },
      body: { ...req.body, cashfree_order_id: `${cashfreeOrderId}x`, payment_id: mismatchedPaymentId },
    }, createMockRes(), (err) => { mismatchError = err; });
    assert.match(mismatchError?.message || '', /does not match this patient/i);
    verifiedOrder.order_tags.patient_id = String(patient.id);

    verifiedOrder.order_amount = 100;
    const wrongAmountId = 'pay_test_wrong_amount';
    let amountError = null;
    await appointmentController.verifyAndBook({
      user: { id: patient.id },
      body: { ...req.body, payment_id: wrongAmountId },
    }, createMockRes(), (err) => { amountError = err; });
    assert.match(amountError?.message || '', /consultation fee/i);
    verifiedOrder.order_amount = 650;

    const uncapturedId = 'pay_test_uncaptured';
    const uncapturedStartsAt = new Date(new Date(futureDate).getTime() + 30 * 60 * 1000).toISOString();
    verifiedOrder.order_tags.starts_at = uncapturedStartsAt;
    let captureError = null;
    await appointmentController.verifyAndBook({
      user: { id: patient.id },
      body: { ...req.body, starts_at: uncapturedStartsAt, payment_id: uncapturedId },
    }, createMockRes(), (err) => { captureError = err; });
    assert.match(captureError?.message || '', /not captured/i);
    assert.equal((await container.repositories.appointmentRepository.listByPatient(patient.id)).length, 1);
  });

  await t.test('6. Admin listReceivedPayments returns aggregated payments and metrics', async () => {
    const req = {
      query: { page: '1', limit: '20' },
    };
    const res = createMockRes();
    await adminController.listReceivedPayments(req, res, (err) => { if (err) throw err; });
    assert.ok(res.data.data.items.length >= 1);
    const aptPayment = res.data.data.items.find((p) => p.type === 'Appointment' && p.transaction_id === 'pay_test_apt_888');
    assert.ok(aptPayment);
    assert.equal(aptPayment.amount, 650);
    assert.equal(aptPayment.status, 'Paid');
    assert.equal(aptPayment.transaction_id, 'pay_test_apt_888');
    assert.ok(res.data.data.summary.total_collected >= 650);
    assert.ok(res.data.data.summary.appointment_revenue >= 650);
    assert.ok(res.data.data.summary.paid_count >= 1);
  });

  await t.test('7. Admin enables first_appointment_free and new patient books for ₹0', async () => {
    const newPatient = await userRepository.create({
      phone: '9876500001',
      name: 'First Time Patient',
      email: 'new.patient@example.com',
      role: 'user',
    });

    // Update billing: payment required ON, but first appointment free ON
    await appointmentController.updateBillingConfigAdmin({
      user: { email: 'admin@drhair.com', role: 'super-admin' },
      body: { payment_required: true, consultation_fee: 500, first_appointment_free: true },
    }, createMockRes(), (err) => { if (err) throw err; });

    // Check patient billing config: should show first appointment free
    const patientConfigRes = createMockRes();
    await appointmentController.getBillingConfigPatient({ user: { id: newPatient.id } }, patientConfigRes, () => {});
    assert.equal(patientConfigRes.data.data.first_appointment_free, true);
    assert.equal(patientConfigRes.data.data.is_first_appointment, true);
    assert.equal(patientConfigRes.data.data.effective_fee, 0);
    assert.equal(patientConfigRes.data.data.effective_payment_required, false);

    // New patient books directly for free
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + ((1 + 7 - futureDate.getDay()) % 7 || 7));
    futureDate.setHours(11, 30, 0, 0);

    const bookRes = createMockRes();
    await appointmentController.createPatient({
      user: { id: newPatient.id },
      body: {
        starts_at: futureDate.toISOString(),
        reason: 'First consultation for hair thinning',
      },
    }, bookRes, (err) => { if (err) throw err; });

    assert.equal(bookRes.data.data.consultationFee, 0);
    assert.equal(bookRes.data.data.paymentMethod, 'Free First Consultation');
    assert.equal(bookRes.data.data.paymentStatus, 'Waived');
  });

  await t.test('8. Admin turns off payment_required (payment disabled) and allows direct booking', async () => {
    const regularPatient = await userRepository.create({
      phone: '9876500002',
      name: 'Regular Patient',
      email: 'reg.patient@example.com',
      role: 'user',
    });

    await appointmentController.updateBillingConfigAdmin({
      user: { email: 'admin@drhair.com', role: 'super-admin' },
      body: { payment_required: false, consultation_fee: 400, first_appointment_free: false },
    }, createMockRes(), (err) => { if (err) throw err; });

    const patientConfigRes = createMockRes();
    await appointmentController.getBillingConfigPatient({ user: { id: regularPatient.id } }, patientConfigRes, () => {});
    assert.equal(patientConfigRes.data.data.payment_required, false);
    assert.equal(patientConfigRes.data.data.effective_payment_required, false);

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + ((2 + 7 - futureDate.getDay()) % 7 || 7));
    futureDate.setHours(12, 0, 0, 0);

    const bookRes = createMockRes();
    await appointmentController.createPatient({
      user: { id: regularPatient.id },
      body: {
        starts_at: futureDate.toISOString(),
        reason: 'Routine scalp checkup',
        payment_method: 'Pay at clinic',
      },
    }, bookRes, (err) => { if (err) throw err; });

    assert.equal(bookRes.data.data.consultationFee, 400);
    assert.equal(bookRes.data.data.paymentMethod, 'Pay at clinic');
    assert.equal(bookRes.data.data.paymentStatus, 'Pending');
  });
});

test('a slot conflict after a captured Cashfree appointment payment starts a full refund', async () => {
  const paymentGatewayService = {
    provider: 'cashfree', environment: 'TEST',
    async assertConfigured() {},
    async getPaymentOrder(orderId) { return orderId === cashfreeOrderId ? { order_id: orderId, order_amount: 500, order_currency: 'INR', order_status: 'ACTIVE', order_tags: { patient_id: String(patient.id), starts_at: startsAt.toISOString(), consultation_fee: '500', reason: 'Consultation' } } : null; },
    async verifyCapturedPayment({ paymentId }) { return { transaction_id: paymentId, payment: { cf_payment_id: paymentId, payment_status: 'SUCCESS' } }; },
    async refundCapturedPayment() { return { id: 'refund_conflict', status: 'pending' }; },
  };
  const container = createContainer({ paymentGatewayService });
  const { appointmentController } = container.controllers;
  const { userRepository, appointmentRepository } = container.repositories;
  const gateway = container.services.paymentGatewayService;
  const patient = await userRepository.create({
    phone: '9876500999', name: 'Slot Race Patient', email: 'slot.race@example.com', role: 'user',
  });
  await appointmentController.updateBillingConfigAdmin({
    user: { email: 'admin@drhair.com', role: 'super-admin' },
    body: { payment_required: true, consultation_fee: 650 },
  }, createMockRes(), (error) => { if (error) throw error; });

  const startsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const paymentId = 'pay_slot_race_captured';
  const orderId = 'order_slot_race_captured';
  gateway.getPaymentOrder = async () => ({
    order_id: orderId,
    order_amount: 650,
    order_currency: 'INR',
    order_tags: {
      app_order_id: `APT-123-${patient.id}-1234abcd`,
      patient_id: String(patient.id), starts_at: startsAt, consultation_fee: '650',
    },
  });
  gateway.verifyCapturedPayment = async () => ({ transaction_id: paymentId });
  gateway.refundCapturedPayment = async () => ({ id: 'rfnd_slot_race', status: 'pending' });
  appointmentController.validateSlot = async () => {};
  appointmentRepository.create = async () => {
    throw new ConflictError('This clinic slot has just been booked. Choose another time.');
  };

  let caught = null;
  await appointmentController.verifyAndBook({
    user: { id: patient.id },
    body: {
      starts_at: startsAt, reason: 'Consultation', cashfree_order_id: orderId,
      payment_id: paymentId,
    },
  }, createMockRes(), (error) => { caught = error; });

  assert.match(caught?.message || '', /refund has been initiated/i);
  assert.match(caught?.message || '', /rfnd_slot_race/);
});
