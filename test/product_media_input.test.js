import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProductMediaInput, cleanupUploadedProductFiles } from '../src/modules/products/application/product-media-input.js';

const saved = {
  media: [{
    name: 'old.png',
    url: 'https://api.example.test/api/v1/media/assets/drhair/images/admin/product/old.png',
    public_id: 'drhair/images/admin/product/old.png',
    kind: 'image',
    altText: 'Old alt',
    isPrimary: true,
  }],
  images: ['https://api.example.test/api/v1/media/assets/drhair/images/admin/product/old.png'],
};

const uploaded = {
  key: 'drhair/images/admin/product/new.webp',
  publicId: 'drhair/images/admin/product/new.webp',
  secureUrl: 'https://api.example.test/api/v1/media/assets/drhair/images/admin/product/new.webp',
  originalName: 'new.webp',
  mimetype: 'image/webp',
  format: 'webp',
  bytes: 99,
};

test('multipart product media preserves order, saved assets, alt text, and primary state', () => {
  const payload = resolveProductMediaInput({
    media: [
      { pending_upload: true, upload_index: 0, altText: 'New first image', isPrimary: true },
      { ...saved.media[0], altText: 'Existing second image', isPrimary: false },
    ],
  }, [uploaded], saved, { replaceMedia: true });

  assert.deepEqual(payload.images, [uploaded.secureUrl, saved.media[0].url]);
  assert.equal(payload.media[0].public_id, uploaded.key);
  assert.equal(payload.media[0].altText, 'New first image');
  assert.equal(payload.media[0].isPrimary, true);
  assert.equal(payload.media[1].public_id, saved.media[0].public_id);
  assert.equal(payload.media[1].altText, 'Existing second image');
  assert.equal(payload.media[1].isPrimary, false);
});

test('an empty final media list removes all images and arbitrary URLs cannot be retained', () => {
  assert.deepEqual(resolveProductMediaInput({ media: [] }, [], saved, { replaceMedia: true }), { media: [], images: [] });
  assert.throws(
    () => resolveProductMediaInput({ media: [{ url: 'https://attacker.example/image.png' }] }, [], saved, { replaceMedia: true }),
    /must belong to this product/,
  );
});

test('pending file indexes must be one-to-one and at most one image can be primary', () => {
  assert.throws(
    () => resolveProductMediaInput({ media: [
      { pending_upload: true, upload_index: 0 },
      { pending_upload: true, upload_index: 0 },
    ] }, [uploaded], null, { replaceMedia: true }),
    /unique upload_index/,
  );
  assert.throws(
    () => resolveProductMediaInput({ media: [{ pending_upload: true, upload_index: 0 }] }, [], null, { replaceMedia: true }),
    /unique upload_index/,
  );
  assert.throws(
    () => resolveProductMediaInput({ media: [
      { pending_upload: true, upload_index: 0, isPrimary: true },
      { pending_upload: true, upload_index: 1, isPrimary: true },
    ] }, [uploaded, { ...uploaded, key: 'drhair/images/admin/product/second.png', publicId: 'drhair/images/admin/product/second.png' }], null, { replaceMedia: true }),
    /Only one product image/,
  );
});

test('multipart create does not accept client-provided image URLs and legacy JSON edits stay compatible', () => {
  assert.throws(
    () => resolveProductMediaInput({ images: ['https://attacker.example/image.png'] }, [], null, { replaceMedia: true }),
    /must be uploaded as multipart files/,
  );
  const legacyPayload = { images: ['https://cdn.example/legacy.png'] };
  assert.equal(resolveProductMediaInput(legacyPayload, [], saved).images[0], legacyPayload.images[0]);
});

test('failed product writes can clean only new product-owned image objects', async () => {
  const deleted = [];
  await cleanupUploadedProductFiles([
    uploaded,
    { key: 'drhair/images/admin/general/keep.png' },
    uploaded,
  ], { async deleteImage(key) { deleted.push(key); } });
  assert.deepEqual(deleted, [uploaded.key]);
});
