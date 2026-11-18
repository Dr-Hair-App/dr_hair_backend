import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { config } from '../src/config/env.js';
import { R2MediaStorage } from '../src/modules/media/infrastructure/R2MediaStorage.js';
import { clearStorageBindings, setStorageBindings } from '../src/shared/storage/runtime.js';

test('R2 storage enforces the cumulative streamed file cap without Content-Length', async () => {
  const originalLimit = config.upload.maxRequestSize;
  config.upload.maxRequestSize = 8;
  let putCalled = false;
  setStorageBindings({ MEDIA_BUCKET: { async put() { putCalled = true; } } });
  const req = {
    headers: { 'x-media-purpose': 'product' },
    user: { id: 7, role: 'admin' },
  };

  try {
    await assert.rejects(new Promise((resolve, reject) => {
      new R2MediaStorage()._handleFile(req, {
        mimetype: 'image/png',
        stream: Readable.from([Buffer.alloc(9)]),
      }, (error, file) => error ? reject(error) : resolve(file));
    }), (error) => error.statusCode === 413 && /complete upload/i.test(error.message));
    assert.equal(req._drHairUploadedFileBytes, 9);
    assert.equal(putCalled, false);
  } finally {
    config.upload.maxRequestSize = originalLimit;
    clearStorageBindings();
  }
});
