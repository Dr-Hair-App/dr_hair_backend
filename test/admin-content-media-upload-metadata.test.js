import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdminContentPayload } from '../src/shared/middlewares/admin-content-media-upload.middleware.js';

const parse = (kind, payload, files) => new Promise((resolve, reject) => {
  const req = { headers: { 'content-type': 'multipart/form-data; boundary=test' }, body: { payload }, files };
  parseAdminContentPayload(kind)(req, {}, (error) => error ? reject(error) : resolve(req.body));
});

test('Admin content upload exposes the processing result of newly optimized images', async () => {
  const body = await parse('content', JSON.stringify({
    title: 'Test content',
    metadata: { mediaAssets: { processingStatus: 'original_preserved' } },
  }), {
    files: [
      { secureUrl: '/media/original.png', key: 'original.png', format: 'png', bytes: 2048, originalBytes: 2048, compressed: false, processingStatus: 'original_preserved' },
      { secureUrl: '/media/optimized.webp', key: 'optimized.webp', format: 'webp', bytes: 900, originalBytes: 2048, compressed: true, processingStatus: 'lossless_webp' },
    ],
  });

  assert.equal(body.imageUrl, '/media/optimized.webp');
  assert.equal(body.metadata.mediaAssets.processingStatus, 'lossless_webp');
  assert.deepEqual(body.metadata.mediaAssets.variants.map(({ format, bytes, originalBytes, compressed, processingStatus }) => ({
    format, bytes, originalBytes, compressed, processingStatus,
  })), [
    { format: 'png', bytes: 2048, originalBytes: 2048, compressed: false, processingStatus: 'original_preserved' },
    { format: 'webp', bytes: 900, originalBytes: 2048, compressed: true, processingStatus: 'lossless_webp' },
  ]);
});

test('review media upload also records the current optimization result', async () => {
  const body = await parse('review', JSON.stringify({
    name: 'Test patient',
    media_assets: { processingStatus: 'old_result' },
  }), {
    files: [
      { secureUrl: '/media/avatar.webp', key: 'avatar.webp', format: 'webp', bytes: 700, originalBytes: 1000, compressed: true, processingStatus: 'lossless_webp' },
    ],
  });

  assert.equal(body.avatar, '/media/avatar.webp');
  assert.equal(body.media_assets.processingStatus, 'lossless_webp');
  assert.equal(body.media_assets.variants[0].compressed, true);
});
