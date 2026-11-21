import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdminController } from '../src/modules/admin/presentation/admin.controller.js';

const invoke = async (handler, req) => {
  let statusCode = 200;
  let body;
  let error;
  const res = { status(code) { statusCode = code; return this; }, json(payload) { body = payload; return this; } };
  await handler(req, res, (nextError) => { error = nextError; });
  return { statusCode, body, error };
};

describe('Admin patient record', () => {
  const patient = {
    id: 42, role: 'user', name: 'Test Patient', email: 'patient@example.test', phone: '+91 9000000042',
    age: 34, gender: 'Female', city: 'Pune', occupation: 'Designer', profile_url: null,
    created_at: '2026-08-01T12:00:00.000Z',
    toPublicProfile() { return { id: this.id, name: this.name, email: this.email, phone: this.phone, age: this.age, gender: this.gender, city: this.city, occupation: this.occupation, profile_url: this.profile_url }; },
  };

  it('returns only the selected patient’s assessments, treatments, and safe report metadata', async () => {
    const controller = new AdminController({
      userRepository: { findById: async (id) => Number(id) === 42 ? patient : null },
      hairTestRepository: { findByUserId: async () => [{ id: 501, reference_no: 'HT-TEST-0501', hair_loss_stage: 'Stage 2', userId: 42 }] },
      treatmentRepository: { findByTestIdentifier: async () => [{ reference_no: 'HT-TEST-0501', toResponse: () => ({ id: 1, treatment_name: 'Routine', duration: '8 weeks' }) }] },
      clinicalReportRepository: {
        listByUserId: async () => [{ id: 'report-id', userId: 42, title: 'Lab report', file_name: 'lab.pdf', mime_type: 'application/pdf', format: 'pdf', bytes: 512, public_id: 'private/path/secret.pdf', asset_id: 'private-asset', uploaded_by: 'doctor@example.test', created_at: '2026-08-02T12:00:00.000Z' }],
        listArchivedByUserId: async () => [],
      },
      appointmentRepository: { listByPatient: async () => [] },
      patientActivityRepository: { listByPatient: async () => [], record: async () => {} },
      progressCheckInRepository: { listByUserId: async () => [] },
      imageStorage: { createPrivateDownloadUrl: () => 'https://example.com/dl' },
    });
    const result = await invoke(controller.getPatient, { params: { userId: '42' } });
    assert.equal(result.error, undefined);
    assert.equal(result.body.data.patient.id, 42);
    assert.equal(result.body.data.assessments[0].reference_no, 'HT-TEST-0501');
    assert.equal(result.body.data.treatments[0].reference_no, 'HT-TEST-0501');
    assert.equal(result.body.data.reports[0].title, 'Lab report');
    assert.equal('public_id' in result.body.data.reports[0], false);
    assert.equal('asset_id' in result.body.data.reports[0], false);
  });

  it('updates app-editable fields but blocks email and phone changes', async () => {
    let saved;
    const controller = new AdminController({
      userRepository: { findById: async () => patient, update: async (_id, fields) => { saved = fields; return { toPublicProfile: () => ({ ...patient.toPublicProfile(), ...fields }) }; } },
    });
    const good = await invoke(controller.updatePatient, { params: { userId: '42' }, body: { age: 35, city: 'Jaipur' } });
    assert.equal(good.error, undefined);
    assert.deepEqual(saved, { age: 35, city: 'Jaipur' });
    const bad = await invoke(controller.updatePatient, { params: { userId: '42' }, body: { phone: '9000000000' } });
    assert.equal(bad.error?.statusCode, 400);
  });

  it('does not upload a report whose file contents do not match its claimed type', async () => {
    const controller = new AdminController({
      userRepository: { findById: async () => patient },
      clinicalReportRepository: { create: async () => ({}) },
    });
    const result = await invoke(controller.uploadPatientReport, {
      params: { userId: '42' }, body: { title: 'Synthetic report' },
      file: { originalname: 'report.pdf', mimetype: 'application/pdf', size: 6, buffer: Buffer.from('not pdf') },
      user: { email: 'doctor@example.test' },
    });
    assert.equal(result.error?.statusCode, 400);
  });

  it('uploads and shares in one multipart request only with explicit patient consent', async () => {
    let saved;
    const notifications = [];
    const controller = new AdminController({
      userRepository: { findById: async () => patient },
      clinicalReportRepository: { create: async (report) => { saved = report; return report; } },
      patientActivityRepository: { record: async () => {} },
      notificationRepository: { create: async (notification) => { notifications.push(notification); return { ...notification, id: 'notif-42' }; } },
      deviceTokenRepository: { listByUserId: async () => [] },
      malwareScanner: { scanClinicalReport: async () => ({ status: 'clean' }) },
    });
    const file = {
      id: 'report-uuid', key: 'drhair/private-reports/user-42/report-uuid.pdf',
      format: 'pdf', originalname: 'lab.pdf', mimetype: 'application/pdf', size: 512,
      bytes: 512, storedBytes: 512, sha256: 'a'.repeat(64), scanningStatus: 'not_scanned',
    };
    const request = {
      params: { userId: '42' },
      body: { title: 'Blood test', visibility: 'Shared', patient_consent_confirmed: 'true' },
      file, user: { role: 'super_admin', email: 'doctor@example.test' },
    };
    const result = await invoke(controller.uploadPatientReport, request);
    assert.equal(result.error, undefined);
    assert.equal(result.statusCode, 201);
    assert.equal(saved.userId, patient.id);
    assert.equal(saved.title, 'Blood test');
    assert.equal(saved.visibility, 'Shared');
    assert.equal(result.body.data.notification_delivery.inboxCreated, true);
    assert.equal(result.body.data.notification_delivery.pushSent, 0);
    assert.equal(result.body.data.notification_delivery.pushStatus, 'no_devices');
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0].destination, { type: 'report', entityId: 'report-uuid' });

    const unconsented = await invoke(controller.uploadPatientReport, {
      ...request,
      body: { title: 'Blood test', visibility: 'Shared' },
    });
    assert.equal(unconsented.error?.statusCode, 400);
  });


  it('allows hair test operators to upload private reports but requires share permission for Shared uploads', async () => {
    const reportFile = {
      id: 'report-uuid', key: 'drhair/private-reports/user-42/report-uuid.pdf',
      format: 'pdf', originalname: 'lab.pdf', mimetype: 'application/pdf', size: 512,
      bytes: 512, storedBytes: 512, sha256: 'a'.repeat(64), scanningStatus: 'not_scanned',
    };
    const makeController = (savedReports, notifications) => new AdminController({
      userRepository: { findById: async () => patient },
      clinicalReportRepository: { create: async (report) => { savedReports.push(report); return report; } },
      patientActivityRepository: { record: async () => {} },
      notificationRepository: { create: async (notification) => { notifications.push(notification); return { ...notification, id: 'notif-id' }; } },
      malwareScanner: { scanClinicalReport: async () => ({ status: 'clean' }) },
    });

    const savedReports = [];
    const notifications = [];
    const controller = makeController(savedReports, notifications);
    const privateResult = await invoke(controller.uploadPatientReport, {
      params: { userId: '42' }, body: { title: 'Private lab result' }, file: reportFile,
      user: { role: 'admin', permissions: ['hair-tests.upload'], email: 'operator@example.test' },
    });
    assert.equal(privateResult.error, undefined);
    assert.equal(privateResult.body.data.visibility, 'Private');
    assert.equal(savedReports.length, 1);

    const deniedShared = await invoke(controller.uploadPatientReport, {
      params: { userId: '42' },
      body: { title: 'Shared lab result', visibility: 'Shared', patient_consent_confirmed: 'true' },
      file: reportFile,
      user: { role: 'admin', permissions: ['hair-tests.upload'], email: 'operator@example.test' },
    });
    assert.equal(deniedShared.error?.statusCode, 403);
    assert.equal(savedReports.length, 1);
    assert.equal(notifications.length, 0);

    const sharedResult = await invoke(controller.uploadPatientReport, {
      params: { userId: '42' },
      body: { title: 'Shared lab result', visibility: 'Shared', patient_consent_confirmed: 'true' },
      file: reportFile,
      user: { role: 'admin', permissions: ['hair-tests.upload', 'documents.share'], email: 'operator@example.test' },
    });
    assert.equal(sharedResult.error, undefined);
    assert.equal(sharedResult.body.data.visibility, 'Shared');
    assert.equal(savedReports.length, 2);
    assert.equal(notifications.length, 1);
  });

  it('records scan status and leaves unconfigured scanning explicitly not_scanned', async () => {
    let saved;
    let scanInput;
    const controller = new AdminController({
      userRepository: { findById: async () => patient },
      clinicalReportRepository: { create: async (report) => { saved = report; return report; } },
      patientActivityRepository: { record: async () => {} },
      malwareScanner: { scanClinicalReport: async (input) => { scanInput = input; return { status: 'clean' }; } },
    });
    const result = await invoke(controller.uploadPatientReport, {
      params: { userId: '42' }, body: { title: 'Lab report' },
      file: {
        id: 'report-uuid', key: 'drhair/private-reports/user-42/report-uuid.pdf',
        format: 'pdf', originalname: 'lab.pdf', mimetype: 'application/pdf', size: 512,
        bytes: 512, storedBytes: 512, sha256: 'a'.repeat(64), scanningStatus: 'not_scanned',
      },
      user: { email: 'doctor@example.test' },
    });
    assert.equal(result.error, undefined);
    assert.equal(scanInput.key, 'drhair/private-reports/user-42/report-uuid.pdf');
    assert.equal(saved.scanning_status, 'clean');
    assert.equal(result.body.data.scanning_status, 'clean');
  });

  it('blocks patient sharing when a report has no clean malware scan', async () => {
    let created = false;
    let visibilityUpdated = false;
    const reportFile = {
      id: 'unscanned-report', key: 'drhair/private-reports/user-42/unscanned-report.pdf',
      format: 'pdf', originalname: 'lab.pdf', mimetype: 'application/pdf', size: 512,
      bytes: 512, storedBytes: 512, sha256: 'a'.repeat(64), scanningStatus: 'not_scanned',
    };
    const controller = new AdminController({
      userRepository: { findById: async () => patient },
      clinicalReportRepository: {
        create: async (report) => { created = true; return report; },
        findByUserIdAndId: async () => ({ id: 'unscanned-report', scanning_status: 'not_scanned' }),
        updateVisibilityWithResult: async () => { visibilityUpdated = true; return { changed: true, report: {} }; },
      },
      malwareScanner: { scanClinicalReport: async () => ({ status: 'not_scanned' }) },
    });
    const uploadResult = await invoke(controller.uploadPatientReport, {
      params: { userId: '42' },
      body: { title: 'Unscanned lab result', visibility: 'Shared', patient_consent_confirmed: 'true' },
      file: reportFile,
      user: { role: 'super_admin', email: 'doctor@example.test' },
    });
    assert.equal(uploadResult.error?.statusCode, 400);
    assert.match(uploadResult.error?.message || '', /malware scanning is not configured.*Upload a new copy/s);
    assert.equal(created, false);

    const shareResult = await invoke(controller.updatePatientReportVisibility, {
      params: { userId: '42', reportId: 'unscanned-report' },
      body: { visibility: 'Shared', patient_consent_confirmed: true },
      user: { email: 'doctor@example.test' },
    });
    assert.equal(shareResult.error?.statusCode, 400);
    assert.match(shareResult.error?.message || '', /malware scanning is not configured.*Upload a new copy/s);
    assert.equal(visibilityUpdated, false);
  });

  it('rejects and cleans a report when a configured malware scanner flags it', async () => {
    let saved = false;
    const controller = new AdminController({
      userRepository: { findById: async () => patient },
      clinicalReportRepository: { create: async () => { saved = true; return {}; } },
      malwareScanner: { scanClinicalReport: async () => ({ status: 'infected' }) },
    });
    const result = await invoke(controller.uploadPatientReport, {
      params: { userId: '42' }, body: { title: 'Unsafe report' },
      file: {
        id: 'report-uuid', key: 'drhair/private-reports/user-42/report-uuid.pdf',
        format: 'pdf', originalname: 'lab.pdf', mimetype: 'application/pdf', size: 512,
        bytes: 512, storedBytes: 512, sha256: 'a'.repeat(64), scanningStatus: 'not_scanned',
      },
      user: { email: 'doctor@example.test' },
    });
    assert.equal(result.error?.statusCode, 400);
    assert.equal(saved, false);
  });

  it('updates complete patient profile details including contact and medical conditions when confirmed', async () => {
    let saved;
    const controller = new AdminController({
      userRepository: {
        findById: async () => patient,
        update: async (_id, fields) => {
          saved = fields;
          return { toPublicProfile: () => ({ ...patient.toPublicProfile(), ...fields }) };
        },
      },
    });
    const result = await invoke(controller.updatePatient, {
      params: { userId: '42' },
      body: {
        name: 'Jane Doe',
        phone: '9876543210',
        email: 'jane@example.com',
        gender: 'female',
        age: 28,
        medical_conditions: ['Thyroid', 'PCOS'],
        city: 'Mumbai',
        confirm_contact_change: true,
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.body.status, 'success');
    assert.equal(saved.name, 'Jane Doe');
    assert.equal(saved.phone, '9876543210');
    assert.equal(saved.email, 'jane@example.com');
    assert.equal(saved.gender, 'female');
    assert.equal(saved.age, 28);
    assert.deepEqual(saved.medical_conditions, ['Thyroid', 'PCOS']);
    assert.equal(saved.city, 'Mumbai');
  });

  it('updates hair test with clinical audit notes, treatment recommendations, and AI result overrides', async () => {
    const mockAssessment = {
      id: 101,
      reference_no: 'HT-2026-0101',
      userId: 42,
      status: 'submitted',
      clinical_notes: null,
      recommended_treatments: null,
      ai_assessment_override: null,
    };
    let updatedFields = null;
    let updatedStatus = null;
    const controller = new AdminController({
      hairTestRepository: {
        findByReferenceNo: async (ref) => (ref === 'HT-2026-0101' ? mockAssessment : null),
        updateStatus: async (ref, status) => {
          updatedStatus = status;
          mockAssessment.status = status;
          return mockAssessment;
        },
        update: async (ref, data) => {
          updatedFields = data;
          Object.assign(mockAssessment, data);
          return mockAssessment;
        },
      },
    });

    const result = await invoke(controller.updateHairTest, {
      params: { referenceNo: 'HT-2026-0101' },
      body: {
        status: 'under_review',
        clinical_notes: {
          doctor_notes: 'Patient exhibits early telogen effluvium triggered by nutritional deficit.',
          diagnosis_insights: 'Scalp micro-vascularity is intact; minoxidil response projected to be positive.',
          clinical_recommendations: 'Prescribe biotin supplements and peptide scalp lotion.',
        },
        recommended_treatments: {
          products: [
            { id: 'prod-01', name: 'Dr. Hair Follicle Activator Serum', dosage: '1ml nightly' },
            { id: 'prod-02', name: 'Dr. Hair Biotin Gummies', dosage: '1 gummy daily' },
          ],
          appointment: {
            recommended: true,
            type: 'video_teleconsultation',
            notes: 'Follow-up trichology assessment in 30 days',
          },
        },
        ai_assessment_override: {
          hair_loss_stage: 'Stage 2',
          scalp_score: 72,
          primary_concern: 'Diffuse thinning at crown',
          prognosis: 'Good reversibility with consistent care',
          notes: 'Doctor adjusted scalp score based on dermatoscope findings',
        },
      },
      user: { name: 'Dr. Jai Bansal', email: 'dr.jai@drhairindia.com' },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.body.status, 'success');
    assert.equal(updatedStatus, 'under_review');
    assert.ok(updatedFields.clinical_notes);
    assert.equal(updatedFields.clinical_notes.doctor_notes, 'Patient exhibits early telogen effluvium triggered by nutritional deficit.');
    assert.equal(updatedFields.clinical_notes.updated_by, 'Dr. Jai Bansal');
    assert.ok(updatedFields.recommended_treatments);
    assert.equal(updatedFields.recommended_treatments.products.length, 2);
    assert.equal(updatedFields.recommended_treatments.appointment.recommended, true);
    assert.ok(updatedFields.ai_assessment_override);
    assert.equal(updatedFields.ai_assessment_override.hair_loss_stage, 'Stage 2');
    assert.equal(updatedFields.ai_assessment_override.scalp_score, 72);
  });
});
