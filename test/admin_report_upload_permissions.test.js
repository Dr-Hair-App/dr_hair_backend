import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAnyPermission } from '../src/shared/middlewares/admin.middleware.js';
import { clinicalReportListPermissions, clinicalReportMinePermissions, clinicalReportReadPermissions, clinicalReportUploadPermissions } from '../src/modules/admin/presentation/admin.routes.js';

const authorize = (middleware, permissions) => {
  let error;
  middleware({ user: { role: 'admin', permissions } }, {}, (nextError) => { error = nextError; });
  return error;
};

test('clinical report upload permission contract is narrow and does not grant report reads', () => {
  const uploadGate = requireAnyPermission(...clinicalReportUploadPermissions);
  const mineGate = requireAnyPermission(...clinicalReportMinePermissions);
  const listGate = requireAnyPermission(...clinicalReportListPermissions);
  const readGate = requireAnyPermission(...clinicalReportReadPermissions);

  assert.equal(authorize(uploadGate, ['hair-tests.upload']), undefined);
  assert.equal(authorize(uploadGate, ['documents.upload']), undefined);
  assert.equal(authorize(uploadGate, ['reports.approve']), undefined);
  assert.equal(authorize(uploadGate, ['documents.view'])?.statusCode, 403);

  assert.equal(authorize(mineGate, ['hair-tests.upload']), undefined);
  assert.equal(authorize(mineGate, ['documents.view'])?.statusCode, 403);
  assert.equal(authorize(mineGate, ['content.edit'])?.statusCode, 403);

  assert.equal(authorize(listGate, ['reports.share']), undefined);
  assert.equal(authorize(listGate, ['documents.share']), undefined);
  assert.equal(authorize(listGate, ['hair-tests.view'])?.statusCode, 403);

  assert.equal(authorize(readGate, ['hair-tests.upload'])?.statusCode, 403);
  assert.equal(authorize(readGate, ['reports.share'])?.statusCode, 403);
  assert.equal(authorize(readGate, ['documents.share'])?.statusCode, 403);
  assert.equal(authorize(readGate, ['documents.view']), undefined);
  assert.equal(authorize(readGate, ['reports.approve']), undefined);
});
