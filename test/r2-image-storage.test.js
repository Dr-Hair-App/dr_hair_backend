import test from 'node:test';
import assert from 'node:assert/strict';
import { setStorageBindings, clearStorageBindings } from '../src/shared/storage/runtime.js';
import { verifyPrivateMediaSignature } from '../src/modules/media/infrastructure/R2MediaStorage.js';
import { R2ImageStorage as ImageStorage } from '../src/modules/media/infrastructure/R2ImageStorage.js';

test('R2 stores clinical images privately and returns a bounded signed API URL', async () => {
  const objects = new Map();
  setStorageBindings({ MEDIA_BUCKET: {
    async put(key, value, options) {
      const data = Buffer.from(value);
      objects.set(key, { data, options, size: data.length, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return { ...value, body: new ReadableStream({ start(controller) { controller.enqueue(value.data); controller.close(); } }), httpMetadata: value.options.httpMetadata, customMetadata: value.options.customMetadata };
    },
    async delete(key) { objects.delete(key); },
  } });

  try {
    const storage = new ImageStorage();
    const uploaded = await storage.uploadImage(Buffer.from('test-image'), 'user-42/assessment', undefined, { deliveryType: 'authenticated', contentType: 'image/png' });
    assert.match(uploaded.publicId, /^drhair\/images\/user-42\/assessment\/[a-f0-9-]+\.png$/);
    assert.equal(objects.get(uploaded.publicId).options.customMetadata.visibility, 'private');
    assert.equal(objects.get(uploaded.publicId).options.customMetadata.purpose, 'assessment');
    assert.match(uploaded.secureUrl, /\/api\/v1\/media\/assets\/.*\?exp=/);

    const image = await storage.getAuthenticatedImage(uploaded.publicId);
    assert.equal(image.public_id, uploaded.publicId);
    assert.equal(image.type, 'authenticated');
    assert.equal(image.format, 'png');
    const url = new URL(image.secure_url);
    const key = decodeURIComponent(url.pathname.split('/api/v1/media/assets/')[1]);
    assert.equal(verifyPrivateMediaSignature(key, url.searchParams.get('exp'), false, url.searchParams.get('sig')), true);
    assert.equal(verifyPrivateMediaSignature(key, Number(url.searchParams.get('exp')) + 4000, false, url.searchParams.get('sig')), false);
  } finally {
    clearStorageBindings();
  }
});
