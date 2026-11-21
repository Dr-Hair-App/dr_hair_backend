import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setStorageBindings, clearStorageBindings } from '../src/shared/storage/runtime.js';
import { hasSafeImageDimensions, optimizeImageForStorage, R2MediaStorage, verifyPrivateMediaSignature } from '../src/modules/media/infrastructure/R2MediaStorage.js';
import { R2ImageStorage as ImageStorage } from '../src/modules/media/infrastructure/R2ImageStorage.js';

const pngHeader = (width = 1, height = 1) => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

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
    const uploaded = await storage.uploadImage(Buffer.concat([pngHeader(), Buffer.from('test-image')]), 'user-42/assessment', undefined, { deliveryType: 'authenticated', contentType: 'image/png' });
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

test('profile image references and orphan deletion verify owner metadata', async () => {
  const objects = new Map();
  const key = 'drhair/images/user-42/profile/avatar.webp';
  objects.set(key, {
    customMetadata: { ownerId: '42', purpose: 'profile', visibility: 'public' },
  });
  setStorageBindings({ MEDIA_BUCKET: {
    async put() {},
    async head(objectKey) { return objects.get(objectKey) || null; },
    async delete(objectKey) { objects.delete(objectKey); },
  } });

  try {
    const images = new ImageStorage();
    assert.equal(await images.hasOwnedProfileImage(key, 42), true);
    assert.equal(await images.hasOwnedProfileImage(key, 41), false);

    const media = new R2MediaStorage();
    await assert.rejects(
      media.deleteOwnedOrphan({ publicId: key, resourceType: 'image', ownerId: 41, isAdmin: false }),
      /Only your unattached media/,
    );
    assert.equal(objects.has(key), true);
    await media.deleteOwnedOrphan({ publicId: key, resourceType: 'image', ownerId: 42, isAdmin: false });
    assert.equal(objects.has(key), false);
  } finally {
    clearStorageBindings();
  }
});

test('R2 media upload validates image bytes and stores the original without gzip', async () => {
  let stored;
  setStorageBindings({ MEDIA_BUCKET: {
    async put(key, value, options) {
      assert.equal(Buffer.isBuffer(value), true, 'R2 receives a known-length Buffer');
      stored = { key, value, options };
    },
  } });

  try {
    const storage = new R2MediaStorage();
    const original = Buffer.concat([pngHeader(), Buffer.from('media-content-'.repeat(300))]);
    const result = await new Promise((resolve, reject) => {
      storage._handleFile({
        headers: { 'x-media-purpose': 'product', 'x-media-compression': 'lossless' },
        user: { id: 7, role: 'admin' },
      }, {
        mimetype: 'image/png',
        stream: Readable.from([original]),
      }, (error, file) => error ? reject(error) : resolve(file));
    });

    assert.equal(stored.key, result.key);
    assert.match(stored.key, /^drhair\/images\/admin\/product\/.*\.png$/);
    assert.equal(stored.options.customMetadata.compression, undefined);
    assert.equal(result.compressed, false);
    assert.equal(result.originalBytes, original.length);
    assert.equal(result.bytes, original.length);
    assert.deepEqual(stored.value, original);
    assert.equal(result.mimetype, 'image/png');
    assert.equal(result.sha256.length, 64);
  } finally {
    clearStorageBindings();
  }
});

test('R2 media upload stores the smaller lossless WebP returned by the shared backend optimizer', async () => {
  let stored;
  const webp = Buffer.alloc(16);
  webp.write('RIFF', 0);
  webp.write('WEBP', 8);
  setStorageBindings({
    MEDIA_BUCKET: {
      async put(key, value, options) { stored = { key, value: Buffer.from(value), options }; },
    },
    IMAGES: {
      input(bytes) {
        assert.ok(Buffer.isBuffer(bytes));
        return { output: async (options) => {
          assert.deepEqual(options, { format: 'image/webp', quality: 100 });
          return { response: async () => new Response(webp) };
        } };
      },
    },
  });

  try {
    const original = Buffer.concat([pngHeader(), Buffer.from('image-pixels-'.repeat(20))]);
    const result = await new Promise((resolve, reject) => {
      new R2MediaStorage()._handleFile({
        headers: { 'x-media-purpose': 'content' },
        user: { id: 7, role: 'admin' },
      }, { mimetype: 'image/png', stream: Readable.from([original]) },
      (error, file) => error ? reject(error) : resolve(file));
    });

    assert.equal(result.compressed, true);
    assert.equal(result.processingStatus, 'lossless_webp');
    assert.equal(result.originalBytes, original.length);
    assert.equal(result.bytes, webp.length);
    assert.equal(result.mimetype, 'image/webp');
    assert.match(stored.key, /\.webp$/);
    assert.deepEqual(stored.value, webp);
    assert.equal(stored.options.customMetadata.originalBytes, String(original.length));
  } finally {
    clearStorageBindings();
  }
});

test('R2 media rejects a mismatched MIME signature before making an object', async () => {
  let putCalled = false;
  setStorageBindings({ MEDIA_BUCKET: {
    async put() { putCalled = true; },
  } });

  try {
    const storage = new R2MediaStorage();
    await assert.rejects(new Promise((resolve, reject) => {
      storage._handleFile({
        headers: { 'x-media-purpose': 'product' },
        user: { id: 7, role: 'admin' },
      }, {
        mimetype: 'image/png',
        stream: Readable.from([Buffer.from('not a png')]),
      }, (error, file) => error ? reject(error) : resolve(file));
    }), /contents do not match/);
    assert.equal(putCalled, false);
  } finally {
    clearStorageBindings();
  }
});

test('bounded image dimension parsing rejects truncated and decompression-bomb headers', () => {
  assert.equal(hasSafeImageDimensions('image/png', pngHeader(2048, 2048)), true);
  assert.equal(hasSafeImageDimensions('image/png', pngHeader(20_000, 20_000)), false);
  assert.equal(hasSafeImageDimensions('image/png', pngHeader(20_001, 1)), false);
  assert.equal(hasSafeImageDimensions('image/png', pngHeader().subarray(0, 20)), false);
});

test('shared backend image optimizer uses lossless WebP only when smaller and otherwise preserves source bytes', async () => {
  const source = Buffer.from('original image bytes');
  const webp = Buffer.alloc(16);
  webp.write('RIFF', 0);
  webp.write('WEBP', 8);
  const calls = [];
  const binding = {
    input(bytes) {
      calls.push(Buffer.from(bytes));
      return {
        output(options) {
          assert.deepEqual(options, { format: 'image/webp', quality: 100 });
          return Promise.resolve({ response: async () => new Response(webp) });
        },
      };
    },
  };

  const result = await optimizeImageForStorage(source, 'image/jpeg', binding);
  assert.equal(result.compressed, true);
  assert.equal(result.contentType, 'image/webp');
  assert.equal(result.format, 'webp');
  assert.equal(result.originalBytes, source.length);
  assert.deepEqual(result.buffer, webp);
  assert.equal(calls.length, 1);

  const unavailable = await optimizeImageForStorage(source, 'image/jpeg', null);
  assert.equal(unavailable.compressed, false);
  assert.deepEqual(unavailable.buffer, source);

  const bigger = await optimizeImageForStorage(source, 'image/jpeg', {
    input() { return { output: async () => ({ response: async () => new Response(Buffer.alloc(128, 1)) }) }; },
  });
  assert.equal(bigger.compressed, false);
  assert.deepEqual(bigger.buffer, source);
});

test('R2 media streams 5 MiB parts and enforces the 25 MiB file boundary', async () => {
  const { config } = await import('../src/config/env.js');
  const originalLimit = config.upload.maxFileSize;
  config.upload.maxFileSize = 25 * 1024 * 1024;

  const uploadSize = async (size) => {
    let savedBytes = 0;
    let aborted = false;
    const bucket = {
      async put(_key, value) { savedBytes = value.length; },
      async createMultipartUpload() {
        return {
          async uploadPart(_partNumber, value) {
            savedBytes += value.length;
            return { partNumber: _partNumber, etag: `part-${_partNumber}` };
          },
          async complete(parts) { assert.ok(parts.length > 0); },
          async abort() { aborted = true; },
        };
      },
    };
    setStorageBindings({ MEDIA_BUCKET: bucket });
    const storage = new R2MediaStorage();
    async function* chunks() {
      let emitted = 0;
      while (emitted < size) {
        const length = Math.min(1024 * 1024, size - emitted);
        const chunk = Buffer.alloc(length, 0x61);
        if (emitted === 0) pngHeader().copy(chunk);
        emitted += length;
        yield chunk;
      }
    }
    const result = await new Promise((resolve, reject) => {
      storage._handleFile({
        headers: { 'x-media-purpose': 'product' },
        user: { id: 7, role: 'admin' },
      }, {
        mimetype: 'image/png',
        stream: Readable.from(chunks()),
      }, (error, file) => error ? reject(error) : resolve(file));
    });
    return { result, savedBytes, aborted };
  };

  try {
    for (const size of [
      1024,
      5 * 1024 * 1024,
      20 * 1024 * 1024,
      24 * 1024 * 1024,
    ]) {
      const { result, savedBytes, aborted } = await uploadSize(size);
      assert.equal(result.bytes, size);
      assert.equal(savedBytes, size);
      assert.equal(aborted, false);
    }
    const { result, savedBytes } = await uploadSize(25 * 1024 * 1024);
    assert.equal(result.bytes, 25 * 1024 * 1024);
    assert.equal(savedBytes, 25 * 1024 * 1024);

    await assert.rejects(uploadSize(25 * 1024 * 1024 + 1), /configured upload size limit/);
  } finally {
    config.upload.maxFileSize = originalLimit;
    clearStorageBindings();
  }
});
