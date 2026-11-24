import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError, UnauthorizedError } from '../src/shared/errors/index.js';
import { SubmitHairTestUseCase } from '../src/modules/hair_test/application/SubmitHairTestUseCase.js';

describe('Flutter hair assessment fields', () => {
  it('persists the current mobile questionnaire answers against the authenticated account', async () => {
    let saved;
    const useCase = new SubmitHairTestUseCase({
      hairTestRepository: { create: async (data) => { saved = data; return { ...data, reference_no: 'HT-2026-0001' }; } },
      imageStorage: {},
    });

    const result = await useCase.execute({
      userId: '42',
      formData: {
        full_name: 'Patient Name',
        age: '31',
        gender: 'Female',
        primary_concern: 'Temple thinning',
        stage: 'Stage 2',
        duration: '6 to 12 months',
        dandruff: 'Itchy scalp',
        gut_health: 'Sometimes bloated',
        stress_level: 'High',
        family_history: 'Yes',
      },
    });

    assert.equal(saved.userId, 42);
    assert.equal(saved.full_name, 'Patient Name');
    assert.equal(saved.age, 31);
    assert.equal(saved.gender, 'Female');
    assert.equal(saved.main_concern, 'Temple thinning');
    assert.equal(saved.hair_loss_stage, 'Stage 2');
    assert.equal(saved.duration, '6 to 12 months');
    assert.equal(saved.gut_health, 'Sometimes bloated');
    assert.equal(result.reference_no, 'HT-2026-0001');
  });

  it('persists original and optimized R2 file parts from the combined submit request', async () => {
    let saved;
    const keys = [
      'drhair/images/user-42/assessment/original.jpg',
      'drhair/images/user-42/assessment/optimized.webp',
    ];
    const useCase = new SubmitHairTestUseCase({
      hairTestRepository: {
        create: async (data) => { saved = data; return { ...data, reference_no: 'HT-2026-0002' }; },
      },
      imageStorage: {
        async getAuthenticatedImage(publicId) {
          return {
            public_id: publicId,
            type: 'authenticated',
            secure_url: `https://api.drhair.local/api/v1/media/assets/${encodeURIComponent(publicId)}?sig=test`,
            format: publicId.endsWith('.webp') ? 'webp' : 'jpg',
            bytes: publicId.endsWith('.webp') ? 400 : 2_000_000,
          };
        },
        async deleteImage() {},
      },
    });

    await useCase.execute({
      userId: '42',
      formData: { full_name: 'Patient Name' },
      files: {
        photo_front: [{ publicId: keys[0], sha256: 'a'.repeat(64) }],
        photo_front_optimized: [{ publicId: keys[1], sha256: 'b'.repeat(64) }],
      },
    });

    assert.equal(saved.scalp_photos.length, 1);
    assert.equal(saved.scalp_photos[0].file_name, keys[0]);
    assert.equal(saved.scalp_photos[0].optimized_file_name, keys[1]);
    assert.equal(saved.scalp_photos[0].optimized_format, 'webp');
    assert.equal(saved.scalp_photos[0].optimized_bytes, 400);
    assert.equal(saved.scalp_photos[0].optimized_sha256, 'b'.repeat(64));
  });

  it('persists all five named scalp angles from one assessment request', async () => {
    let saved;
    const angles = ['front', 'top', 'left', 'right', 'back'];
    const useCase = new SubmitHairTestUseCase({
      hairTestRepository: {
        create: async (data) => {
          saved = data;
          return { ...data, reference_no: 'HT-2026-0005' };
        },
      },
      imageStorage: {
        async getAuthenticatedImage(publicId) {
          return {
            public_id: publicId,
            type: 'authenticated',
            secure_url: `https://api.drhair.local/api/v1/media/assets/${encodeURIComponent(publicId)}?sig=test`,
            format: 'jpg',
            bytes: 800_000,
          };
        },
        async deleteImage() {},
      },
    });

    await useCase.execute({
      userId: '42',
      formData: { full_name: 'Synthetic Patient' },
      files: Object.fromEntries(angles.map((angle) => [
        `photo_${angle}`,
        [{ publicId: `drhair/images/user-42/assessment/${angle}.jpg` }],
      ])),
    });

    assert.deepEqual(saved.scalp_photos.map((photo) => photo.angle), angles);
    assert.equal(saved.scalp_photos.length, 5);
  });

  it('rejects a streamed R2 image owned by a different patient', async () => {
    const useCase = new SubmitHairTestUseCase({
      hairTestRepository: { create: async (data) => data },
      imageStorage: {
        async getAuthenticatedImage() { throw new Error('not found'); },
        async deleteImage() {},
      },
    });

    await assert.rejects(useCase.execute({
      userId: '42',
      formData: { full_name: 'Patient Name' },
      files: {
        photo_front: [{ publicId: 'drhair/images/user-43/assessment/other.jpg' }],
      },
    }), UnauthorizedError);
  });

  it('deletes streamed R2 images when questionnaire validation fails before persistence', async () => {
    const deleted = [];
    const useCase = new SubmitHairTestUseCase({
      hairTestRepository: { create: async (data) => data },
      imageStorage: {
        async deleteImage(key, options) { deleted.push({ key, options }); },
      },
    });
    await assert.rejects(useCase.execute({
      userId: '42',
      formData: {
        full_name: 'Patient Name',
        allergy_status: 'Yes, I have allergies',
        allergy_details: '',
      },
      files: { photo_front: [{ publicId: 'drhair/images/user-42/assessment/orphan.jpg' }] },
    }), BadRequestError);
    assert.deepEqual(deleted, [{
      key: 'drhair/images/user-42/assessment/orphan.jpg',
      options: { deliveryType: 'authenticated' },
    }]);
  });
});
