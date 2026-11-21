import test from 'node:test';
import assert from 'node:assert/strict';
import { clearStorageBindings, getBucketsForKey, getMediaBucket, getUploadBucket, setStorageBindings } from '../src/shared/storage/runtime.js';

test('new split bindings route admin and patient uploads to separate buckets', (t) => {
  const admin = { put() {} };
  const user = { put() {} };
  setStorageBindings({ ADMIN_MEDIA_BUCKET: admin, USER_MEDIA_BUCKET: user });
  t.after(clearStorageBindings);

  assert.equal(getUploadBucket({ isAdmin: true }), admin);
  assert.equal(getUploadBucket({ isAdmin: false }), user);
  assert.equal(getMediaBucket(), user);
  assert.deepEqual(getBucketsForKey('drhair/images/admin/product/example.png'), [admin]);
  assert.deepEqual(getBucketsForKey('drhair/images/user-42/assessment/example.png'), [user]);
  assert.deepEqual(getBucketsForKey('drhair/private-reports/user-42/report.pdf'), [user]);
});

test('legacy MEDIA_BUCKET remains a fallback only when explicitly bound', (t) => {
  const admin = { put() {} };
  const user = { put() {} };
  const legacy = { put() {} };
  setStorageBindings({ ADMIN_MEDIA_BUCKET: admin, USER_MEDIA_BUCKET: user, MEDIA_BUCKET: legacy });
  t.after(clearStorageBindings);

  assert.deepEqual(getBucketsForKey('drhair/images/admin/content/old.png'), [admin, legacy]);
  assert.deepEqual(getBucketsForKey('drhair/images/user-42/profile/old.jpg'), [user, legacy]);
});
