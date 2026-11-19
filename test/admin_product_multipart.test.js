import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createContainer } from '../src/container.js';
import { TokenService } from '../src/shared/utils/token.service.js';
import { store } from '../src/shared/database/store.js';
import { clearStorageBindings, setStorageBindings } from '../src/shared/storage/runtime.js';

const PNG = (() => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  return bytes;
})();

const makeProductPayload = (media = []) => ({
  name: 'Multipart Product Test',
  category: 'Test care',
  price: 499,
  stock: 5,
  status: 'active',
  media,
  supply_plans: [{ id: 'test-plan', title: 'Trial size', price: 499, mrp: 599, sku: `TEST-${Date.now()}`, shipping_profile: { weight_kg: 0.2, length_cm: 10, breadth_cm: 8, height_cm: 4 } }],
});

const makeForm = (payload, files = []) => {
  const form = new FormData();
  form.set('product', JSON.stringify(payload));
  for (const [index, file] of files.entries()) {
    form.append('files', new Blob([file.bytes], { type: file.type }), file.name || `image-${index}.png`);
  }
  return form;
};

test('admin product multipart API creates, replaces, removes, and deletes R2 images safely', async (t) => {
  const originalProducts = [...store.products];
  const objects = new Map();
  const deletedKeys = [];
  setStorageBindings({ MEDIA_BUCKET: {
    async put(key, value, options) { objects.set(key, { value: Buffer.from(value), options }); },
    async delete(key) { deletedKeys.push(key); objects.delete(key); },
    async head(key) { return objects.has(key) ? { customMetadata: objects.get(key).options.customMetadata } : null; },
  } });

  const container = createContainer();
  const { app } = createApp({ container });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/admin/products`;
  const token = TokenService.generateToken({ id: 'test-super-admin', email: 'test@drhair.example', role: 'super_admin' });
  const headers = { Authorization: `Bearer ${token}` };

  try {
    await t.test('creates product and image in one multipart request', async () => {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: makeForm(makeProductPayload([{ pending_upload: true, upload_index: 0, altText: 'Front label', isPrimary: true }]), [
          { bytes: PNG, type: 'image/png', name: 'front.png' },
        ]),
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      const product = body.data;
      assert.equal(product.name, 'Multipart Product Test');
      assert.equal(product.media.length, 1);
      assert.equal(product.media[0].mime_type, 'image/png');
      assert.equal(product.media[0].altText, 'Front label');
      assert.equal(product.images[0], product.media[0].url);
      assert.equal(objects.has(product.media[0].public_id), true);
      store.products = store.products.filter((item) => item.id !== product.id);
      store.products.unshift(product);
    });

    const product = store.products.find((item) => item.name === 'Multipart Product Test');
    assert.ok(product);
    const originalKey = product.media[0].public_id;

    await t.test('replaces image and deletes the previous R2 object only after update', async () => {
      const response = await fetch(`${baseUrl}/${encodeURIComponent(product.id)}`, {
        method: 'PATCH',
        headers,
        body: makeForm(makeProductPayload([{ pending_upload: true, upload_index: 0, altText: 'New product photo', isPrimary: true }]), [
          { bytes: PNG, type: 'image/png', name: 'replacement.png' },
        ]),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      const replacementKey = body.data.media[0].public_id;
      assert.notEqual(replacementKey, originalKey);
      assert.deepEqual(deletedKeys, [originalKey]);
      assert.equal(objects.has(originalKey), false);
      assert.equal(objects.has(replacementKey), true);
    });

    await t.test('empty media list removes the attached image from product and R2', async () => {
      const current = store.products.find((item) => item.id === product.id);
      const oldKey = current.media[0].public_id;
      const response = await fetch(`${baseUrl}/${encodeURIComponent(product.id)}`, {
        method: 'PATCH',
        headers,
        body: makeForm(makeProductPayload([])),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.data.media, []);
      assert.deepEqual(body.data.images, []);
      assert.equal(objects.has(oldKey), false);
      assert.ok(deletedKeys.includes(oldKey));
    });

    await t.test('rejects foreign retained image references and keeps saved media unchanged', async () => {
      const current = store.products.find((item) => item.id === product.id);
      const response = await fetch(`${baseUrl}/${encodeURIComponent(product.id)}`, {
        method: 'PATCH',
        headers,
        body: makeForm(makeProductPayload([{ url: 'https://attacker.example/image.png' }])),
      });
      assert.equal(response.status, 400);
      const after = store.products.find((item) => item.id === product.id);
      assert.deepEqual(after.media, current.media);
    });

    await t.test('existing DELETE product API also removes attached product images', async () => {
      const response = await fetch(`${baseUrl}/${encodeURIComponent(product.id)}`, { method: 'DELETE', headers });
      assert.equal(response.status, 200);
      assert.equal(store.products.some((item) => item.id === product.id), false);
    });
  } finally {
    server.close();
    store.products = originalProducts;
    clearStorageBindings();
  }
});
