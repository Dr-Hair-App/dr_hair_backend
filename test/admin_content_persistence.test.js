import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';

// Force the backend's non-production in-memory repositories for this isolated
// HTTP integration test; never target a configured D1/R2/production service.
process.env.NODE_ENV = 'test';
process.env.DRHAIR_DEPLOYMENT_ENV = '';
process.env.JWT_SECRET ||= `admin-content-test-${randomUUID()}-only-local`;

const [{ createApp }, { TokenService }] = await Promise.all([
  import('../src/app.js'),
  import('../src/shared/utils/token.service.js'),
]);

const { app, container } = createApp();
let server;
let baseUrl;
const accounts = new Map();

async function createTestAccount(key, permissions) {
  const email = `admin-content-${key}-${randomUUID()}@example.test`;
  const account = await container.repositories.adminAccountRepository.create({
    name: `Test ${key}`,
    email,
    passwordHash: 'test-only-not-a-login-hash',
    role: 'admin',
    roleTemplate: 'custom-admin',
    permissions,
  });
  const token = TokenService.generateToken({ id: account.id, email, role: 'admin' });
  accounts.set(key, { email, token });
}

async function api(path, { actor, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) headers.Authorization = `Bearer ${accounts.get(actor).token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

before(async () => {
  await createTestAccount('editor', ['content.edit']);
  await createTestAccount('publisher', ['content.edit', 'content.publish']);
  await createTestAccount('publisher-only', ['content.publish']);
  await createTestAccount('unprivileged', []);
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe('Admin content persistence and permissions', () => {
  it('requires an authenticated content permission to read admin content', async () => {
    const anonymous = await api('/admin/content');
    assert.equal(anonymous.response.status, 401);

    const unprivileged = await api('/admin/content', { actor: 'unprivileged' });
    assert.equal(unprivileged.response.status, 403);
  });

  it('validates banner requirements and persists draft create/edit/delete', async () => {
    const invalid = await api('/admin/content', {
      actor: 'editor',
      method: 'POST',
      body: { type: 'banner', title: 'Needs an image', status: 'draft' },
    });
    assert.equal(invalid.response.status, 400);

    const created = await api('/admin/content', {
      actor: 'editor',
      method: 'POST',
      body: {
        type: 'banner',
        title: 'QA banner before edit',
        imageUrl: 'https://example.test/banner.webp',
        actionUrl: '/assessment',
        placement: 'home',
        status: 'draft',
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.data.status, 'draft');
    const id = created.payload.data.id;
    assert.ok(id);

    const loaded = await api('/admin/content?type=banner&status=draft', { actor: 'editor' });
    assert.equal(loaded.response.status, 200);
    assert.ok(loaded.payload.data.items.some((item) => item.id === id));

    const updated = await api(`/admin/content/${encodeURIComponent(id)}`, {
      actor: 'editor',
      method: 'PUT',
      body: { title: 'QA banner edited' },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.data.title, 'QA banner edited');

    const editorPublish = await api(`/admin/content/${encodeURIComponent(id)}/status`, {
      actor: 'editor',
      method: 'PATCH',
      body: { status: 'published' },
    });
    assert.equal(editorPublish.response.status, 403);

    const deleted = await api(`/admin/content/${encodeURIComponent(id)}`, {
      actor: 'editor',
      method: 'DELETE',
    });
    assert.equal(deleted.response.status, 200);
    const afterDelete = await api(`/admin/content?type=banner&status=draft`, { actor: 'editor' });
    assert.equal(afterDelete.payload.data.items.some((item) => item.id === id), false);
  });

  it('requires the publish permission and explicit consent before a patient story goes live', async () => {
    const missingConsent = await api('/admin/content', {
      actor: 'publisher',
      method: 'POST',
      body: { type: 'story', title: 'Patient story', status: 'published' },
    });
    assert.equal(missingConsent.response.status, 400);

    const created = await api('/admin/content', {
      actor: 'editor',
      method: 'POST',
      body: { type: 'story', title: 'Patient story draft', status: 'draft' },
    });
    assert.equal(created.response.status, 201);
    const id = created.payload.data.id;

    const publisherOnlyCannotEdit = await api(`/admin/content/${encodeURIComponent(id)}`, {
      actor: 'publisher-only',
      method: 'PUT',
      body: { title: 'Should be forbidden' },
    });
    assert.equal(publisherOnlyCannotEdit.response.status, 403);

    const publishWithoutConsent = await api(`/admin/content/${encodeURIComponent(id)}/status`, {
      actor: 'publisher',
      method: 'PATCH',
      body: { status: 'published' },
    });
    assert.equal(publishWithoutConsent.response.status, 400);

    const publishWithConsent = await api(`/admin/content/${encodeURIComponent(id)}/status`, {
      actor: 'publisher',
      method: 'PATCH',
      body: { status: 'published', patient_consent_confirmed: true },
    });
    assert.equal(publishWithConsent.response.status, 200);
    assert.equal(publishWithConsent.payload.data.status, 'published');
    assert.equal(publishWithConsent.payload.data.provenance.consent_verified, true);

    await api(`/admin/content/${encodeURIComponent(id)}`, { actor: 'editor', method: 'DELETE' });
  });
});

describe('Admin review persistence and publication consent', () => {
  it('persists review drafts and separates content edit from publishing rights', async () => {
    const created = await api('/admin/reviews', {
      actor: 'editor',
      method: 'POST',
      body: {
        name: 'QA reviewer',
        rating: 5,
        category: 'Clinic',
        message: 'Test-only review for isolated API verification.',
        status: 'draft',
      },
    });
    assert.equal(created.response.status, 201);
    const id = created.payload.data.id;
    assert.equal(created.payload.data.is_verified, false);

    const loaded = await api('/admin/reviews?status=draft', { actor: 'editor' });
    assert.equal(loaded.response.status, 200);
    assert.ok(loaded.payload.data.items.some((item) => String(item.id) === String(id)));

    const edit = await api(`/admin/reviews/${id}`, {
      actor: 'editor',
      method: 'PUT',
      body: { message: 'Edited test-only review.' },
    });
    assert.equal(edit.response.status, 200);
    assert.equal(edit.payload.data.message, 'Edited test-only review.');

    const cannotPublish = await api('/admin/reviews/status', {
      actor: 'editor',
      method: 'PATCH',
      body: { id, status: 'active' },
    });
    assert.equal(cannotPublish.response.status, 403);

    const needsConsent = await api('/admin/reviews/status', {
      actor: 'publisher',
      method: 'PATCH',
      body: { id, status: 'active' },
    });
    assert.equal(needsConsent.response.status, 400);

    const confirmConsent = await api(`/admin/reviews/${id}`, {
      actor: 'publisher',
      method: 'PUT',
      body: { patient_consent_confirmed: true },
    });
    assert.equal(confirmConsent.response.status, 200);
    assert.equal(confirmConsent.payload.data.consent_verified, true);

    const publish = await api('/admin/reviews/status', {
      actor: 'publisher',
      method: 'PATCH',
      body: { id, status: 'active' },
    });
    assert.equal(publish.response.status, 200);
    assert.equal(publish.payload.data.status, 'active');
    assert.equal(publish.payload.data.is_verified, false);

    const editorDelete = await api(`/admin/reviews/${id}`, { actor: 'editor', method: 'DELETE' });
    assert.equal(editorDelete.response.status, 403);
    const remove = await api(`/admin/reviews/${id}`, { actor: 'publisher', method: 'DELETE' });
    assert.equal(remove.response.status, 200);
  });
});
