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
});
