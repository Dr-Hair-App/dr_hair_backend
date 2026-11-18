import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAnyPermission } from '../src/shared/middlewares/admin.middleware.js';
import { clinicalReportReadPermissions, clinicalReportUploadPermissions } from '../src/modules/admin/presentation/admin.routes.js';

const authorize = (middleware, permissions) => {
  let error;
  middleware({ user: { role: 'admin', permissions } }, {}, (nextError) => { error = nextError; });
  return error;
};

test('clinical report upload permission contract is narrow and does not grant report reads', () => {
  const uploadGate = requireAnyPermission(...clinicalReportUploadPermissions);
  const readGate = requireAnyPermission(...clinicalReportReadPermissions);

  assert.equal(authorize(uploadGate, ['hair-tests.upload']), undefined);
  assert.equal(authorize(uploadGate, ['documents.upload']), undefined);
  assert.equal(authorize(uploadGate, ['reports.approve']), undefined);
  assert.equal(authorize(uploadGate, ['documents.view'])?.statusCode, 403);

  assert.equal(authorize(readGate, ['hair-tests.upload'])?.statusCode, 403);
  assert.equal(authorize(readGate, ['documents.view']), undefined);
  assert.equal(authorize(readGate, ['reports.approve']), undefined);
});
