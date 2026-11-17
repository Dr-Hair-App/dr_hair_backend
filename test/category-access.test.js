import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';

test('category mutations and the admin category route reject anonymous requests', async (t) => {
  const { app } = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const path of ['/api/v1/categories', '/categories', '/api/v1/admin/categories']) {
    const response = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Unauthorized category', type: 'videos' }),
    });
    assert.equal(response.status, 401, `${path} should reject anonymous writes`);
  }

  const adminList = await fetch(baseUrl + '/api/v1/admin/categories');
  assert.equal(adminList.status, 401, 'the admin category listing should require an admin session');
});
