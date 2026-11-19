import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminController } from '../src/modules/admin/presentation/admin.controller.js';
import { ClinicalReportRepository } from '../src/modules/admin/infrastructure/ClinicalReportRepository.js';
import { isDatabaseConnected } from '../src/shared/database/database.js';
import { store } from '../src/shared/database/store.js';

const invoke = async (handler, req) => {
  let body;
  let error;
  const res = { status() { return this; }, json(payload) { body = payload; return this; } };
  await handler(req, res, (nextError) => { error = nextError; });
  return { body, error };
};

test('my reports are filtered to the exact authenticated uploader identity', async (t) => {
  if (isDatabaseConnected()) {
    t.skip('In-memory repository isolation test is only valid when the D1/Mongo repository is disconnected.');
    return;
  }

  const own = {
    id: 'mine-report-operator-1', userId: 42, title: 'My private upload', file_name: 'mine.pdf',
    mime_type: 'application/pdf', format: 'pdf', bytes: 100, uploaded_by: 'operator@example.test', visibility: 'Private', created_at: new Date().toISOString(),
  };
  const anotherAdminsPrivateReport = {
    id: 'other-report-admin-2', userId: 77, title: 'Other admin private report', file_name: 'other.pdf',
    mime_type: 'application/pdf', format: 'pdf', bytes: 200, uploaded_by: 'other@example.test', visibility: 'Private', created_at: new Date().toISOString(),
  };
  store.clinicalReports.push(own, anotherAdminsPrivateReport);

  try {
    const repository = new ClinicalReportRepository();
    const ownReports = await repository.listByUploadedBy('operator@example.test');
    assert.deepEqual(ownReports.map((report) => report.id), [own.id]);

    const identitiesUsed = [];
    const controller = new AdminController({
      clinicalReportRepository: {
        async listByUploadedBy(identity) {
          identitiesUsed.push(identity);
          return repository.listByUploadedBy(identity);
        },
      },
    });
    const fromEmail = await invoke(controller.listMyReports, { user: { role: 'admin', email: 'operator@example.test' } });
    assert.equal(fromEmail.error, undefined);
    assert.deepEqual(fromEmail.body.data.reports.map((report) => report.id), [own.id]);

    const fromLogin = await invoke(controller.listMyReports, { user: { role: 'admin', login: 'other@example.test' } });
    assert.deepEqual(fromLogin.body.data.reports.map((report) => report.id), [anotherAdminsPrivateReport.id]);

    const beforeMissingIdentity = identitiesUsed.length;
    const missingIdentity = await invoke(controller.listMyReports, { user: { role: 'admin' } });
    assert.deepEqual(missingIdentity.body.data.reports, []);
    assert.equal(identitiesUsed.length, beforeMissingIdentity);
  } finally {
    store.clinicalReports = store.clinicalReports.filter((report) => ![own.id, anotherAdminsPrivateReport.id].includes(report.id));
  }
});
