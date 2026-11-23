import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AdminController } from '../src/modules/admin/presentation/admin.controller.js';
import { HairTestRepository } from '../src/modules/hair_test/infrastructure/HairTestRepository.js';
import { TreatmentRepository } from '../src/modules/treatment/infrastructure/TreatmentRepository.js';
import { CashfreePaymentGatewayService } from '../src/modules/commerce/infrastructure/CashfreePaymentGatewayService.js';
import { store } from '../src/shared/database/store.js';

function mockResponse() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('P0 1: Decouple care plans from assessment review', async (t) => {
  const originalHairTests = [...store.hairTests];
  const originalTreatments = [...store.treatments];
  t.after(() => {
    store.hairTests = originalHairTests;
    store.treatments = originalTreatments;
  });

  const testHairTest = {
    id: 8801,
    reference_no: 'HT-DECOUPLE-01',
    userId: 881,
    status: 'submitted',
    reviewed: false,
    status_history: [{ status: 'submitted', changed_by: 'Patient' }],
    created_at: new Date().toISOString(),
  };
  store.hairTests = [testHairTest];
  store.treatments = [];

  const hairTestRepo = new HairTestRepository();
  const treatmentRepo = new TreatmentRepository();
  const recordedAudits = [];
  const adminController = new AdminController({
    hairTestRepository: hairTestRepo,
    treatmentRepository: treatmentRepo,
    auditEventRepository: {
      record: async (event) => { recordedAudits.push(event); },
    },
  });

  const res = mockResponse();
  let err = null;
  await adminController.createTreatment(
    {
      body: {
        reference_no: 'HT-DECOUPLE-01',
        treatment_name: 'Hair Fall Arrest Protocol',
        duration: '12 weeks',
        instructions: 'Apply serum daily',
        doctor_name: 'Dr. Jai Bansal',
        medications: [{ name: 'Follicle Serum', dose: '1ml', frequency: 'Daily' }],
        routine_steps: [{ title: 'Apply serum', time_of_day: 'Night' }],
        diet_meals: [{ type: 'Breakfast', name: 'Biotin bowl' }],
      },
      user: { email: 'doctor@drhair.test', role: 'super_admin' },
    },
    res,
    (e) => { err = e; },
  );

  assert.equal(err, null);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.treatment_name, 'Hair Fall Arrest Protocol');

  // Verify: Assessment status remains 'submitted', NOT automatically transitioned to 'reviewed'
  const assessmentAfter = await hairTestRepo.findByReferenceNo('HT-DECOUPLE-01');
  assert.equal(assessmentAfter.status, 'submitted');
  assert.notEqual(assessmentAfter.status, 'reviewed');

  // Verify: Audit event care_plan.created was recorded
  const audit = recordedAudits.find((a) => a.action === 'care_plan.created');
  assert.ok(audit, 'Audit log care_plan.created must be recorded');
  assert.equal(audit.metadata.treatment_name, 'Hair Fall Arrest Protocol');
});

test('P0 2: Make diet-plan writes canonical, idempotent, and return { plan_id, items, ... }', async (t) => {
  const originalTreatments = [...store.treatments];
  t.after(() => {
    store.treatments = originalTreatments;
  });
  store.treatments = [];

  const treatmentRepo = new TreatmentRepository();
  const recordedAudits = [];
  const adminController = new AdminController({
    treatmentRepository: treatmentRepo,
    auditEventRepository: {
      record: async (event) => { recordedAudits.push(event); },
    },
  });

  const meals = [
    { type: 'Breakfast', name: 'Sprouted moong with almonds', nutrients: 'Protein, Zinc', benefit: 'Strengthens follicles' },
    { type: 'Lunch', name: 'Quinoa bowl with spinach', nutrients: 'Iron, Folate', benefit: 'Improves scalp circulation' },
  ];

  const res1 = mockResponse();
  let err1 = null;
  await adminController.updatePatientDietPlan(
    {
      params: { userId: '881' },
      body: { diet_meals: meals },
      user: { email: 'doctor@drhair.test', role: 'super_admin' },
    },
    res1,
    (e) => { err1 = e; },
  );

  assert.equal(err1, null);
  assert.equal(res1.statusCode, 200);
  assert.ok(res1.body.data.plan_id);
  assert.equal(res1.body.data.items.length, 2);
  assert.equal(res1.body.data.items[0].name, 'Sprouted moong with almonds');

  const firstPlanId = res1.body.data.plan_id;

  // Idempotent retry: Re-submitting the same or updated meals returns the same plan_id
  const res2 = mockResponse();
  let err2 = null;
  await adminController.updatePatientDietPlan(
    {
      params: { userId: '881' },
      body: { diet_meals: meals },
      user: { email: 'doctor@drhair.test', role: 'super_admin' },
    },
    res2,
    (e) => { err2 = e; },
  );

  assert.equal(err2, null);
  assert.equal(res2.body.data.plan_id, firstPlanId);
  assert.equal(res2.body.data.items.length, 2);
});

test('P1 4: Care-plan lifecycle: detail, edit, and withdraw endpoints with audit logging', async (t) => {
  const originalTreatments = [...store.treatments];
  t.after(() => {
    store.treatments = originalTreatments;
  });

  const initialRecord = {
    id: 7701,
    userId: 992,
    reference_no: 'HT-LIFECYCLE-01',
    treatment_name: 'Stage 2 Care Plan',
    duration: '6 months',
    instructions: 'Use morning and night',
    doctor_name: 'Dr. Jai Bansal',
    status: 'active',
    medications: [{ name: 'Minoxidil 5%', dose: '1ml', frequency: 'Twice daily' }],
    routine_steps: [],
    diet_meals: [],
    date: '2026-11-20',
  };
  store.treatments = [initialRecord];

  const treatmentRepo = new TreatmentRepository();
  const recordedAudits = [];
  const adminController = new AdminController({
    treatmentRepository: treatmentRepo,
    auditEventRepository: {
      record: async (event) => { recordedAudits.push(event); },
    },
  });

  // 1. Get treatment detail
  const detailRes = mockResponse();
  let detailErr = null;
  await adminController.getTreatment(
    { params: { treatmentId: '7701' }, user: { role: 'super_admin' } },
    detailRes,
    (e) => { detailErr = e; },
  );
  assert.equal(detailErr, null);
  assert.equal(detailRes.statusCode, 200);
  assert.equal(detailRes.body.data.treatment_name, 'Stage 2 Care Plan');
  assert.equal(detailRes.body.data.status, 'active');

  // 2. Update treatment plan
  const updateRes = mockResponse();
  let updateErr = null;
  await adminController.updateTreatment(
    {
      params: { treatmentId: '7701' },
      body: { treatment_name: 'Stage 2 Care Plan - Revised', duration: '9 months' },
      user: { email: 'doctor@drhair.test', role: 'super_admin' },
    },
    updateRes,
    (e) => { updateErr = e; },
  );
  assert.equal(updateErr, null);
  assert.equal(updateRes.statusCode, 200);
  assert.equal(updateRes.body.data.treatment_name, 'Stage 2 Care Plan - Revised');
  assert.equal(updateRes.body.data.duration, '9 months');

  const auditUpdate = recordedAudits.find((a) => a.action === 'care_plan.updated');
  assert.ok(auditUpdate, 'Must record care_plan.updated audit event');

  // 3. Withdraw treatment plan
  const withdrawRes = mockResponse();
  let withdrawErr = null;
  await adminController.withdrawTreatment(
    {
      params: { treatmentId: '7701' },
      body: { reason: 'Patient transitioned to maintenance program' },
      user: { email: 'doctor@drhair.test', role: 'super_admin' },
    },
    withdrawRes,
    (e) => { withdrawErr = e; },
  );
  assert.equal(withdrawErr, null);
  assert.equal(withdrawRes.statusCode, 200);
  assert.equal(withdrawRes.body.data.status, 'withdrawn');
  assert.equal(withdrawRes.body.data.withdrawn_reason, 'Patient transitioned to maintenance program');
  assert.ok(withdrawRes.body.data.withdrawn_at);

  const auditWithdraw = recordedAudits.find((a) => a.action === 'care_plan.withdrawn');
  assert.ok(auditWithdraw, 'Must record care_plan.withdrawn audit event');
});

test('P1 Cashfree: Sandbox gateway adapter create session, verify webhook signature, and verify payment', async () => {
  const mockFetch = async (url, options) => {
    if (url.includes('/orders') && options.method === 'POST') {
      const parsed = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          order_id: parsed.order_id,
          cf_order_id: 'cf_ord_test_12345',
          payment_session_id: 'session_test_abc123xyz',
          order_amount: parsed.order_amount,
          order_currency: parsed.order_currency,
          order_status: 'ACTIVE',
        }),
      };
    }
    if (url.includes('/orders/CF-ORD-01/payments')) {
      return {
        ok: true,
        json: async () => ([
          {
            cf_payment_id: 'cf_pay_998877',
            payment_status: 'SUCCESS',
            payment_amount: 500,
            payment_currency: 'INR',
          },
        ]),
      };
    }
    if (url.includes('/orders/CF-ORD-01')) {
      return {
        ok: true,
        json: async () => ({
          order_id: 'CF-ORD-01',
          cf_order_id: 'cf_ord_test_12345',
          order_amount: 500,
          order_currency: 'INR',
          order_status: 'PAID',
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ message: 'Not found' }) };
  };

  const cashfree = new CashfreePaymentGatewayService({
    appId: 'TEST_CF_APP_ID',
    secretKey: 'TEST_CF_SECRET_KEY',
    environment: 'TEST',
    fetchImpl: mockFetch,
  });

  // 1. Create payment intent returning payment_session_id
  const session = await cashfree.createPaymentIntent({
    orderId: 'CF-ORD-01',
    amount: 500,
    currency: 'INR',
    customer: { id: 'cust-1', name: 'Ananya Sharma', phone: '9876543210' },
  });

  assert.equal(session.orderId, 'CF-ORD-01');
  assert.equal(session.payment_session_id, 'session_test_abc123xyz');
  assert.equal(session.status, 'ACTIVE');
  assert.equal(session.gateway, 'cashfree');
  assert.equal(session.environment, 'TEST');

  // 2. Webhook signature verification using timestamp + rawBody HMAC
  const timestamp = Date.now().toString();
  const rawBody = JSON.stringify({
    data: {
      order: { order_id: 'CF-ORD-01', order_amount: 500 },
      payment: { payment_status: 'SUCCESS', cf_payment_id: 'cf_pay_998877' },
    },
    event_time: new Date().toISOString(),
    type: 'PAYMENT_SUCCESS_WEBHOOK',
  });

  const validSignature = crypto
    .createHmac('sha256', 'TEST_CF_SECRET_KEY')
    .update(`${timestamp}${rawBody}`)
    .digest('base64');

  const isValid = cashfree.verifyWebhookSignature({
    rawBody,
    timestamp,
    signature: validSignature,
  });
  assert.equal(isValid, true, 'Valid webhook signature must be verified');

  const isInvalid = cashfree.verifyWebhookSignature({
    rawBody,
    timestamp,
    signature: 'invalid_forged_signature',
  });
  assert.equal(isInvalid, false, 'Invalid webhook signature must be rejected');

  // 3. Server-side payment verification
  const verification = await cashfree.verifyCapturedPayment({
    orderId: 'CF-ORD-01',
    expectedAmount: 500,
    currency: 'INR',
  });
  assert.equal(verification.order_status, 'PAID');
});
