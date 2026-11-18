import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { R2MediaStorage } from '../src/modules/media/infrastructure/R2MediaStorage.js';
import { SubmitHairTestUseCase } from '../src/modules/hair_test/application/SubmitHairTestUseCase.js';
import { BadRequestError } from '../src/shared/errors/index.js';
import { clearStorageBindings, setStorageBindings } from '../src/shared/storage/runtime.js';

const pngHeader = (width, height) => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

const uploadThroughStorage = ({ path, fieldname, width, height }) => new Promise((resolve, reject) => {
  new R2MediaStorage()._handleFile({
    route: { path },
    originalUrl: `/api/v1/hair-tests${path}`,
    headers: { 'x-media-purpose': 'assessment' },
    user: { id: 42, role: 'user' },
  }, {
    fieldname,
    mimetype: 'image/png',
    originalname: 'camera.png',
    stream: Readable.from([pngHeader(width, height)]),
  }, (error, file) => error ? reject(error) : resolve(file));
});

test('assessment originals up to 100MP are accepted only on the multipart assessment route', async () => {
  const objects = new Map();
  setStorageBindings({ MEDIA_BUCKET: {
    async put(key, value, options) { objects.set(key, { value, options }); },
  } });
  try {
    const original = await uploadThroughStorage({
      path: '/submit_form', fieldname: 'photo_front', width: 8000, height: 6000,
    });
    assert.equal(original.width, 8000);
    assert.equal(original.height, 6000);
    assert.equal(original.bytes, pngHeader(8000, 6000).length);
    assert.equal(objects.get(original.key).options.customMetadata.visibility, 'private');
  } finally {
    clearStorageBindings();
  }
});

test('48MP images remain rejected on general media uploads and assessment originals stay bounded at 100MP', async () => {
  let stored = false;
  setStorageBindings({ MEDIA_BUCKET: { async put() { stored = true; } } });
  try {
    await assert.rejects(
      uploadThroughStorage({ path: '/upload', fieldname: 'files', width: 8000, height: 6000 }),
      /40 megapixels/,
    );
    await assert.rejects(
      uploadThroughStorage({ path: '/submit_form', fieldname: 'photo_front', width: 20_000, height: 5001 }),
      /100 megapixels/,
    );
    assert.equal(stored, false);
  } finally {
    clearStorageBindings();
  }
});

test('assessment rejects a high-resolution original without a smaller validated derivative', async () => {
  const deleted = [];
  let persisted = false;
  const useCase = new SubmitHairTestUseCase({
    hairTestRepository: { async create(data) { persisted = true; return data; } },
    imageStorage: {
      async deleteImage(key) { deleted.push(key); },
      async getAuthenticatedImage(publicId) {
        return { public_id: publicId, type: 'authenticated', secure_url: 'https://example.test/private', format: 'png', bytes: 100 };
      },
    },
  });

  await assert.rejects(useCase.execute({
    userId: '42',
    formData: { full_name: 'Patient' },
    files: {
      photo_front: [{ key: 'drhair/images/user-42/assessment/front.png', width: 8000, height: 6000 }],
    },
  }), BadRequestError);
  assert.equal(persisted, false);
  assert.deepEqual(deleted, ['drhair/images/user-42/assessment/front.png']);
});

test('assessment accepts a high-resolution original paired with a smaller optimized derivative', async () => {
  let saved;
  const useCase = new SubmitHairTestUseCase({
    hairTestRepository: { async create(data) { saved = data; return data; } },
    imageStorage: {
      async getAuthenticatedImage(publicId) {
        return {
          public_id: publicId,
          type: 'authenticated',
          secure_url: `https://example.test/private/${publicId}`,
          format: publicId.endsWith('.webp') ? 'webp' : 'png',
          bytes: publicId.endsWith('.webp') ? 450_000 : 8_000_000,
        };
      },
    },
  });

  await useCase.execute({
    userId: '42',
    formData: { full_name: 'Patient' },
    files: {
      photo_front: [{ key: 'drhair/images/user-42/assessment/front.png', width: 8000, height: 6000 }],
      photo_front_optimized: [{ key: 'drhair/images/user-42/assessment/front.webp', width: 2560, height: 1920 }],
    },
  });

  assert.equal(saved.scalp_photos[0].file_name, 'drhair/images/user-42/assessment/front.png');
  assert.equal(saved.scalp_photos[0].optimized_file_name, 'drhair/images/user-42/assessment/front.webp');
});
