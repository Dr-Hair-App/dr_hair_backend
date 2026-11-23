import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminController } from '../src/modules/admin/presentation/admin.controller.js';
import { AppointmentController } from '../src/modules/appointments/presentation/appointment.controller.js';
import { CommerceController } from '../src/modules/commerce/presentation/commerce.controller.js';
import { HairTestRepository } from '../src/modules/hair_test/infrastructure/HairTestRepository.js';
import { AppointmentRepository } from '../src/modules/appointments/infrastructure/AppointmentRepository.js';
import { UserRepository } from '../src/modules/users/infrastructure/UserRepository.js';
import { MalwareScanner } from '../src/modules/admin/infrastructure/MalwareScanner.js';
import { GetShippingQuoteUseCase } from '../src/modules/commerce/application/GetShippingQuoteUseCase.js';
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

// -----------------------------------------------------------------------------
// P0 Audit Verification: Patient Permissions, Lookup & Profile Edits
// -----------------------------------------------------------------------------
test('P0: Patient lookup vs clinical detail vs profile edit permissions', async (t) => {
  const originalUsers = [...(store.users || [])];
  const testPatient = {
    id: 991,
    role: 'user',
    name: 'Ananya Sharma',
    phone: '+919876543210',
    email: 'ananya@example.test',
    age: 29,
    gender: 'female',
    city: 'Mumbai',
    occupation: 'Architect',
    patient_code: 'DHP00991',
    created_at: '2026-01-01T00:00:00.000Z',
    toPublicProfile() {
      return { id: this.id, name: this.name, phone: this.phone, patient_code: this.patient_code };
    },
  };
  store.users = [testPatient];

  t.after(() => {
    store.users = originalUsers;
  });

  const userRepo = new UserRepository();
  const adminController = new AdminController({
    userRepository: userRepo,
    hairTestRepository: { findByUserId: async () => [] },
    treatmentRepository: { findByTestIdentifier: async () => [] },
    clinicalReportRepository: { listByUserId: async () => [], listArchivedByUserId: async () => [] },
    appointmentRepository: { listByPatient: async () => [] },
    patientActivityRepository: { listByPatient: async () => [] },
    progressCheckInRepository: { listByUserId: async () => [] },
  });

  // 1. lookupPatient allows basic demographic lookup
  const lookupRes = mockResponse();
  let lookupErr = null;
  await adminController.lookupPatient(
    { params: { userId: '991' }, user: { role: 'operator', roleTemplate: 'hair-test-operator' } },
    lookupRes,
    (err) => { lookupErr = err; },
  );
  assert.equal(lookupErr, null);
  assert.equal(lookupRes.statusCode, 200);
  assert.equal(lookupRes.body.data.patient.name, 'Ananya Sharma');
  assert.equal(lookupRes.body.data.patient.patient_code, 'DHP00991');

  // 2. getPatient (full clinical detail) strictly rejects callers with only patients.lookup (lacking patients.view)
  let clinicalErr = null;
  await adminController.getPatient(
    { params: { userId: '991' }, user: { role: 'operator', roleTemplate: 'hair-test-operator' } },
    mockResponse(),
    (err) => { clinicalErr = err; },
  );
  assert.ok(clinicalErr, 'Should reject clinical details when caller lacks patients.view');
  assert.equal(clinicalErr.statusCode, 403);
  assert.match(clinicalErr.message, /patients\.view/);

  // 3. getPatient succeeds when caller has patients.view
  const clinicalRes = mockResponse();
  clinicalErr = null;
  await adminController.getPatient(
    { params: { userId: '991' }, user: { role: 'doctor', roleTemplate: 'clinical-admin' } },
    clinicalRes,
    (err) => { clinicalErr = err; },
  );
  assert.equal(clinicalErr, null);
  assert.equal(clinicalRes.statusCode, 200);
  assert.equal(clinicalRes.body.data.patient.id, 991);

  // 4. Contact edit rejection without patients.edit permission
  let editErr = null;
  await adminController.updatePatient(
    {
      params: { userId: '991' },
      body: { phone: '+919999999999' },
      user: { role: 'operator', roleTemplate: 'hair-test-operator' },
    },
    mockResponse(),
    (err) => { editErr = err; },
  );
  assert.ok(editErr, 'Should reject contact edit without patients.edit permission');
  assert.equal(editErr.statusCode, 403);
  assert.match(editErr.message, /patients\.edit/);

  // 5. admin_override: true bypass attempt by non-super-admin is rejected
  let overrideErr = null;
  await adminController.updatePatient(
    {
      params: { userId: '991' },
      body: { phone: '+919999999999', admin_override: true },
      user: { role: 'operator', roleTemplate: 'hair-test-operator' },
    },
    mockResponse(),
    (err) => { overrideErr = err; },
  );
  assert.ok(overrideErr, 'Should reject admin_override bypass attempt');
  assert.equal(overrideErr.statusCode, 403);
});

// -----------------------------------------------------------------------------
// P0 Audit Verification: Assessment Approvals & Role Permissions
// -----------------------------------------------------------------------------
test('P0: Assessment submission vs doctor approval permissions', async (t) => {
  const originalHairTests = [...(store.hairTests || [])];
  const testHairTest = {
    id: 'ht-p0-test',
    reference_no: 'HT-P0-001',
    user_id: 101,
    status: 'submitted',
    reviewed: false,
    photos: [],
    created_at: new Date().toISOString(),
  };
  store.hairTests = [testHairTest];

  t.after(() => {
    store.hairTests = originalHairTests;
  });

  const hairTestRepo = new HairTestRepository();
  const adminController = new AdminController({
    hairTestRepository: hairTestRepo,
    userRepository: { findById: async () => ({ id: 101, name: 'Test Patient', patient_code: 'DHP0101' }) },
  });

  // 1. Approving assessment (status: 'reviewed') requires assessments.review.
  // An operator with only hair-tests.submit (roleTemplate: hair-test-operator) is rejected with 403.
  let approveErr = null;
  await adminController.updateHairTestStatus(
    {
      params: { referenceNo: 'HT-P0-001' },
      body: { status: 'reviewed', doctor_notes: 'Approved without doctor permission' },
      user: { role: 'operator', roleTemplate: 'hair-test-operator' },
    },
    mockResponse(),
    (err) => { approveErr = err; },
  );
  assert.ok(approveErr, 'Operator should not be able to approve assessment');
  assert.equal(approveErr.statusCode, 403);
  assert.match(approveErr.message, /assessments\.review/);

  // 2. Doctor with assessments.review can approve assessment
  const approveRes = mockResponse();
  let doctorApproveErr = null;
  await adminController.updateHairTestStatus(
    {
      params: { referenceNo: 'HT-P0-001' },
      body: { status: 'reviewed', doctor_notes: 'Approved by trichologist' },
      user: { role: 'doctor', roleTemplate: 'clinical-admin' },
    },
    approveRes,
    (err) => { doctorApproveErr = err; },
  );
  assert.equal(doctorApproveErr, null);
  assert.equal(approveRes.statusCode, 200);

  // 3. Updating treatment recommendations strictly requires care-plans.edit
  let carePlanErr = null;
  await adminController.updateHairTest(
    {
      params: { referenceNo: 'HT-P0-001' },
      body: {
        recommended_treatments: {
          products: [{ id: 'prod-1', name: 'Serum', dosage: '1ml' }],
        },
      },
      user: { role: 'operator', roleTemplate: 'hair-test-operator' }, // lacks care-plans.edit
    },
    mockResponse(),
    (err) => { carePlanErr = err; },
  );
  assert.ok(carePlanErr, 'Should reject treatment recommendations without care-plans.edit');
  assert.equal(carePlanErr.statusCode, 403);
  assert.match(carePlanErr.message, /care-plans\.edit/);

  // 4. Overriding AI assessment strictly requires assessments.review
  let aiOverrideErr = null;
  await adminController.updateHairTest(
    {
      params: { referenceNo: 'HT-P0-001' },
      body: {
        ai_assessment_override: {
          hair_loss_stage: 'Stage 3',
          scalp_score: 80,
        },
      },
      user: { role: 'operator', roleTemplate: 'hair-test-operator' }, // lacks assessments.review
    },
    mockResponse(),
    (err) => { aiOverrideErr = err; },
  );
  assert.ok(aiOverrideErr, 'Should reject AI override without assessments.review');
  assert.equal(aiOverrideErr.statusCode, 403);
  assert.match(aiOverrideErr.message, /assessments\.review/);
});

// -----------------------------------------------------------------------------
// P0 Audit Verification: Appointment Billing Single Source of Truth & Zero Coercion
// -----------------------------------------------------------------------------
test('P0: Appointment billing single source of truth, unconfigured blocking & explicit waiver', async (t) => {
  const originalAppointments = [...(store.appointments || [])];
  t.after(() => {
    store.appointments = originalAppointments;
  });

  const appointmentRepo = new AppointmentRepository();
  const appointmentController = new AppointmentController({
    appointmentRepository: appointmentRepo,
    userRepository: { findById: async () => ({ id: 501, role: 'user', patient_code: 'DHP0501' }) },
    patientActivityRepository: { record: async () => {} },
  });
  appointmentController.validateSlot = async () => {};
  appointmentController.getScheduleConfig = async () => ({ timezone: 'Asia/Kolkata', appointment_services: ['Consultation'] });

  // 1. When billing is unconfigured, consultation_fee is null (not coerced to 0)
  appointmentController.getBillingConfig = async () => ({
    configured: false,
    consultation_fee: null,
    pay_at_clinic_enabled: true,
    online_pay_enabled: true,
  });

  const unconfiguredBilling = await appointmentController.getBillingConfig();
  assert.equal(unconfiguredBilling.configured, false);
  assert.equal(unconfiguredBilling.consultation_fee, null);

  // 2. Unconfigured billing blocks scheduling Paid or Pending appointments
  let unconfiguredBookingErr = null;
  await appointmentController.createAdmin(
    {
      body: {
        patient_id: 501,
        starts_at: '2026-12-01T04:30:00.000Z',
        payment_status: 'Paid',
        payment_method: 'Cash',
      },
      user: { email: 'admin@drhair.test' },
    },
    mockResponse(),
    (err) => { unconfiguredBookingErr = err; },
  );
  assert.ok(unconfiguredBookingErr, 'Should block paid booking when billing is unconfigured');
  assert.equal(unconfiguredBookingErr.statusCode, 400);
  assert.match(unconfiguredBookingErr.message, /billing has not been configured/i);

  // 3. Configured billing with fee 0 requires explicit waiver
  appointmentController.getBillingConfig = async () => ({
    configured: true,
    consultation_fee: 0,
    pay_at_clinic_enabled: true,
    online_pay_enabled: true,
    first_appointment_free: false,
  });

  let zeroFeeErr = null;
  await appointmentController.createAdmin(
    {
      body: {
        patient_id: 501,
        starts_at: '2026-12-01T04:30:00.000Z',
        consultation_fee: 0,
        payment_status: 'Paid',
        payment_method: 'Cash',
      },
      user: { email: 'admin@drhair.test' },
    },
    mockResponse(),
    (err) => { zeroFeeErr = err; },
  );
  assert.ok(zeroFeeErr, 'Fee of 0 should require an explicit waiver');
  assert.equal(zeroFeeErr.statusCode, 400);
  assert.match(zeroFeeErr.message, /explicit fee waiver/i);

  // 4. Configured billing with fee 0 and fee_waived: true succeeds
  const waivedRes = mockResponse();
  let waivedErr = null;
  await appointmentController.createAdmin(
    {
      body: {
        patient_id: 501,
        starts_at: '2026-12-01T04:30:00.000Z',
        consultation_fee: 0,
        fee_waived: true,
        payment_status: 'Waived',
        payment_method: 'Fee Waived',
      },
      user: { email: 'admin@drhair.test' },
    },
    waivedRes,
    (err) => { waivedErr = err; },
  );
  assert.equal(waivedErr, null);
  assert.equal(waivedRes.statusCode, 201);
  assert.equal(waivedRes.body.data.payment_status, 'Waived');
});

// -----------------------------------------------------------------------------
// P1 Audit Verification: Assessment Review Count & Consistent Status Definition
// -----------------------------------------------------------------------------
test('P1: Assessment review count repository fix and status definitions', async (t) => {
  const originalHairTests = [...(store.hairTests || [])];
  store.hairTests = [
    { id: 'ht-1', reference_no: 'HT-1', status: 'submitted', reviewed: false },
    { id: 'ht-2', reference_no: 'HT-2', status: 'under_review', reviewed: false },
    { id: 'ht-3', reference_no: 'HT-3', status: 'reviewed', reviewed: true },
    { id: 'ht-4', reference_no: 'HT-4', status: 'draft', reviewed: false }, // draft should not count
  ];

  t.after(() => {
    store.hairTests = originalHairTests;
  });

  const hairTestRepo = new HairTestRepository();

  // listAdmin must exist as a method
  assert.equal(typeof hairTestRepo.listAdmin, 'function');
  const adminList = await hairTestRepo.listAdmin();
  assert.ok(adminList.items || Array.isArray(adminList));

  // getStatusSummary must count submitted and under_review without draft
  const summary = await hairTestRepo.getStatusSummary();
  assert.equal(summary.total, 3, 'Draft should be excluded from total non-draft tests');
  assert.equal(summary.submitted, 1);
  assert.equal(summary.under_review, 1);
  assert.equal(summary.reviewed, 1);
});

// -----------------------------------------------------------------------------
// P1 Audit Verification: Appointment Summary Scale & Asia/Kolkata Timezone
// -----------------------------------------------------------------------------
test('P1: Appointment summary at scale with Asia/Kolkata timezone boundaries', async (t) => {
  const originalAppointments = [...(store.appointments || [])];
  // 2026-06-15 01:00 UTC is 2026-06-15 06:30 IST (same day in Asia/Kolkata)
  // 2026-06-14 20:00 UTC is 2026-06-15 01:30 IST (today in Asia/Kolkata!)
  // 2026-06-14 17:00 UTC is 2026-06-14 22:30 IST (yesterday in Asia/Kolkata!)
  store.appointments = [
    { id: 'apt-today-1', starts_at: '2026-06-15T01:00:00.000Z', status: 'Confirmed' },
    { id: 'apt-today-2', starts_at: '2026-06-14T20:00:00.000Z', status: 'Pending' },
    { id: 'apt-yesterday', starts_at: '2026-06-14T17:00:00.000Z', status: 'Confirmed' },
    { id: 'apt-cancelled-today', starts_at: '2026-06-15T02:00:00.000Z', status: 'Cancelled' },
  ];

  t.after(() => {
    store.appointments = originalAppointments;
  });

  const appointmentRepo = new AppointmentRepository();
  const testNow = new Date('2026-06-15T08:00:00.000Z'); // 13:30 IST on June 15
  const metrics = await appointmentRepo.getDashboardMetrics({
    timeZone: 'Asia/Kolkata',
    now: testNow,
  });

  assert.equal(metrics.total, 4);
  assert.equal(metrics.today, 2, 'Should count today active appointments in Asia/Kolkata (excluding cancelled)');
  assert.equal(metrics.confirmed, 2);
  assert.equal(metrics.pending, 1);
});

// -----------------------------------------------------------------------------
// P1 Audit Verification: Server-Side Patient Search with Pagination
// -----------------------------------------------------------------------------
test('P1: Server-side patient search with pagination and accurate total', async (t) => {
  const originalUsers = [...(store.users || [])];
  store.users = [
    { id: 1, role: 'user', name: 'Rohan Mehra', phone: '+919111111111', email: 'rohan@test.com', patient_code: 'DHP0001' },
    { id: 2, role: 'user', name: 'Rohan Kapoor', phone: '+919222222222', email: 'kapoor@test.com', patient_code: 'DHP0002' },
    { id: 3, role: 'user', name: 'Priya Sharma', phone: '+919333333333', email: 'priya@test.com', patient_code: 'DHP0003' },
    { id: 4, role: 'admin', name: 'Admin Staff', phone: '+919444444444', email: 'admin@test.com', patient_code: 'DHP0004' }, // non-user
  ];

  t.after(() => {
    store.users = originalUsers;
  });

  const userRepo = new UserRepository();
  const searchResult = await userRepo.list({ search: 'rohan', page: 1, limit: 1 });
  assert.equal(searchResult.total, 2, 'Accurate total matching search query');
  assert.equal(searchResult.items.length, 1, 'Respects pagination limit');
  assert.equal(searchResult.items[0].name, 'Rohan Mehra');
});

// -----------------------------------------------------------------------------
// P1 Audit Verification: Shipping Quote Safe Error Handling
// -----------------------------------------------------------------------------
test('P1: Shipping quote safe error handling without secrets leak', async () => {
  const mockProductRepo = {
    async getById(id) {
      return {
        id,
        name: 'Anti-Hairfall Shampoo',
        status: 'active',
        price: 499,
        shipping_profile: { weight_kg: 0.3, length_cm: 15, breadth_cm: 10, height_cm: 8 },
      };
    },
  };

  const failingShiprocket = {
    async getCourierQuotes() {
      const err = new Error('Shiprocket API token invalid or credentials missing');
      err.code = 'SHIPROCKET_NOT_CONFIGURED';
      err.statusCode = 503;
      throw err;
    },
  };

  const useCase = new GetShippingQuoteUseCase({
    productRepository: mockProductRepo,
    addressRepository: null,
    shiprocketService: failingShiprocket,
  });

  await assert.rejects(
    async () => {
      await useCase.execute({
        deliveryPincode: '400001',
      paymentGateway: 'cashfree',
        items: [{ product_id: 'prod-1', quantity: 1 }],
      });
    },
    (err) => {
      assert.equal(err.name, 'ServiceUnavailableError');
      assert.equal(err.code, 'SHIPROCKET_NOT_CONFIGURED');
      assert.doesNotMatch(err.message, /token|key|secret/i, 'Must not leak credential internals');
      return true;
    },
  );
});

// -----------------------------------------------------------------------------
// P1 Audit Verification: Malware Scanner Statuses & Safe Report Sharing
// -----------------------------------------------------------------------------
test('P1: Malware scanner unconfigured/infected status prevents report sharing', async () => {
  const scanner = new MalwareScanner({ enabled: false });
  const unconfiguredResult = await scanner.scanClinicalReport();
  assert.equal(unconfiguredResult.status, 'not_scanned');

  const enabledScanner = new MalwareScanner({ enabled: true });
  const infectedResult = await enabledScanner.scanClinicalReport({
    key: 'test-report-infected.pdf',
    buffer: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
  });
  assert.equal(infectedResult.status, 'infected');

  const unknownFileResult = await enabledScanner.scanClinicalReport({
    key: 'ordinary-clinical-report.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    buffer: Buffer.from('%PDF-1.7\\nordinary report contents'),
  });
  assert.equal(unknownFileResult.status, 'not_scanned');
  assert.equal(unknownFileResult.reason, 'scanner_provider_not_configured');

  // Verify AdminController blocks sharing infected report
  const adminController = new AdminController({
    userRepository: { findById: async () => ({ id: 42, role: 'user' }) },
    clinicalReportRepository: {
      findByUserIdAndId: async () => ({ id: 'rpt_inf', scanning_status: 'infected' }),
      updateVisibilityWithResult: async () => ({ changed: false }),
    },
  });

  let shareErr = null;
  await adminController.updatePatientReportVisibility(
    {
      params: { userId: '42', reportId: 'rpt_inf' },
      body: { visibility: 'Shared', patient_consent_confirmed: true },
      user: { email: 'doctor@drhair.test' },
    },
    mockResponse(),
    (err) => { shareErr = err; },
  );
  assert.ok(shareErr, 'Infected report must be rejected from sharing');
  assert.equal(shareErr.statusCode, 400);
});

// -----------------------------------------------------------------------------
// P1 Audit Verification: Inventory Adjustment Direction vs Reason Validation
// -----------------------------------------------------------------------------
test('P1: Inventory adjustment direction vs reason validation', async () => {
  const commerceController = new CommerceController({
    inventoryRepository: {
      async adjustStock() { return 50; },
    },
  });

  // 1. Receive direction with negative delta is rejected
  let invalidDirErr = null;
  await commerceController.restockProduct(
    {
      params: { productId: 'prod-001' },
      body: { delta: -5, direction: 'receive', reason: 'Routine adjustment', idempotency_key: 'key-1' },
      admin: { id: 'admin-1' },
    },
    mockResponse(),
    (err) => { invalidDirErr = err; },
  );
  assert.ok(invalidDirErr);
  assert.equal(invalidDirErr.statusCode, 400);
  assert.match(invalidDirErr.message, /positive stock delta/i);

  // 2. Remove delta with Receive-only reason is rejected
  let invalidReasonErr = null;
  await commerceController.restockProduct(
    {
      params: { productId: 'prod-001' },
      body: { delta: -5, reason: 'Supplier restock', idempotency_key: 'key-2' },
      admin: { id: 'admin-1' },
    },
    mockResponse(),
    (err) => { invalidReasonErr = err; },
  );
  assert.ok(invalidReasonErr);
  assert.equal(invalidReasonErr.statusCode, 400);
  assert.match(invalidReasonErr.message, /incompatible with reason/i);

  // 3. Positive delta with Remove-only reason (e.g. Damaged) is rejected
  let invalidIncreaseErr = null;
  await commerceController.restockProduct(
    {
      params: { productId: 'prod-001' },
      body: { delta: 10, reason: 'Damaged or expired', idempotency_key: 'key-3' },
      admin: { id: 'admin-1' },
    },
    mockResponse(),
    (err) => { invalidIncreaseErr = err; },
  );
  assert.ok(invalidIncreaseErr);
  assert.equal(invalidIncreaseErr.statusCode, 400);
  assert.match(invalidIncreaseErr.message, /incompatible with reason/i);

  // 4. Valid adjustment succeeds
  const validRes = mockResponse();
  let validErr = null;
  await commerceController.restockProduct(
    {
      params: { productId: 'prod-001' },
      body: { delta: 10, direction: 'receive', reason: 'Stock received from supplier', idempotency_key: 'key-4' },
      admin: { id: 'admin-1' },
    },
    validRes,
    (err) => { validErr = err; },
  );
  assert.equal(validErr, null);
  assert.equal(validRes.statusCode, 200);
});
