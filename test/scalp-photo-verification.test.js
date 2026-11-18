import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SubmitHairTestUseCase } from '../src/modules/hair_test/application/SubmitHairTestUseCase.js';
import {
  buildScalpPhotoVerificationUpdate,
  HairTestRepository,
} from '../src/modules/hair_test/infrastructure/HairTestRepository.js';
import { store } from '../src/shared/database/store.js';

describe('assessment scalp photo verification', () => {
  it('builds stable-key D1 photo updates without replacing the photo array', () => {
    const update = buildScalpPhotoVerificationUpdate([
      {
        file_name: 'drhair/images/user-1/assessment/front.webp',
        status: 'hairDetected',
        confidence: 1.2,
        message: 'Visible scalp.',
      },
      {
        file_name: 'drhair/images/user-1/assessment/top.webp',
        status: 'verificationUnavailable',
        confidence: 0,
        details: 'Provider unavailable.',
      },
      {
        file_name: 'drhair/images/user-1/assessment/ignored.webp',
        status: 'unknown',
      },
    ]);

    assert.equal(update.arrayFilters.length, 2);
    assert.deepEqual(update.arrayFilters, [
      { 'photo0.file_name': 'drhair/images/user-1/assessment/front.webp' },
      { 'photo1.file_name': 'drhair/images/user-1/assessment/top.webp' },
    ]);
    assert.equal(
      update.set['scalp_photos.$[photo0].verification_status'],
      'hairDetected',
    );
    assert.equal(
      update.set['scalp_photos.$[photo0].verification_confidence'],
      1,
    );
    assert.equal(
      update.set['scalp_photos.$[photo1].verification_status'],
      'verificationUnavailable',
    );
    assert.equal(Object.hasOwn(update.set, 'scalp_photos'), false);
  });

  it('returns and persists each visual verdict by stable R2 file key', async () => {
    const userId = 74021;
    const repository = new HairTestRepository();
    const fileName = 'drhair/images/user-74021/assessment/front.webp';
    const aiAssessment = {
      ai_status: 'available',
      summary: 'A cautious screening summary.',
      scalp_photo_verification: [{
        file_name: fileName,
        angle: 'front',
        status: 'hairDetected',
        is_hair: true,
        confidence: 0.91,
        message: 'Scalp and hair are visually present.',
        details: 'Visual check only.',
      }],
    };
    const useCase = new SubmitHairTestUseCase({
      hairTestRepository: repository,
      imageStorage: {
        async getAuthenticatedImage(publicId) {
          return {
            public_id: publicId,
            type: 'authenticated',
            secure_url: `https://api.drhair.local/api/v1/media/assets/${encodeURIComponent(publicId)}?sig=test`,
            format: 'webp',
            bytes: 400,
          };
        },
        async deleteImage() {},
      },
      geminiAiService: {
        async generateHairTestAssessment(patientData) {
          assert.equal(patientData.scalp_photos[0].file_name, fileName);
          return aiAssessment;
        },
      },
    });

    const result = await useCase.execute({
      userId: String(userId),
      formData: { full_name: 'Synthetic Patient' },
      files: { photo_front: [{ publicId: fileName }] },
    });

    try {
      assert.equal(result.ai_assessment.scalp_photo_verification[0].file_name, fileName);
      assert.equal(result.test.scalp_photos[0].verification_status, 'hairDetected');
      assert.equal(result.test.scalp_photos[0].verification_confidence, 0.91);
      const history = await repository.findByUserId(userId);
      const reloaded = history.find((item) => item.reference_no === result.reference_no);
      assert.equal(reloaded.scalp_photos[0].file_name, fileName);
      assert.equal(reloaded.scalp_photos[0].verification_status, 'hairDetected');
    } finally {
      const index = store.hairTests.findIndex((item) => item.reference_no === result.reference_no);
      if (index >= 0) store.hairTests.splice(index, 1);
    }
  });

  it('marks pending photos unavailable after terminal failure and allows a retry to replace that status', async () => {
    const repository = new HairTestRepository();
    const referenceNo = `HT-VERIFY-FAIL-${Date.now()}`;
    const fileName = 'drhair/images/user-74022/assessment/front.webp';
    store.hairTests.push({
      reference_no: referenceNo,
      userId: 74022,
      status: 'active',
      ai_assessment_status: 'processing',
      scalp_photos: [{ file_name: fileName, angle: 'front', verification_status: 'pending' }],
    });

    try {
      const failed = await repository.markAiAssessmentFailed(referenceNo, 'provider_timeout');
      assert.equal(failed.scalp_photos[0].verification_status, 'verificationUnavailable');
      assert.match(failed.scalp_photos[0].verification_message, /could not be completed/i);

      store.hairTests.find((item) => item.reference_no === referenceNo).ai_assessment_status = 'processing';
      const retried = await repository.saveAiAssessment(referenceNo, {
        ai_status: 'available',
        scalp_photo_verification: [{
          file_name: fileName,
          angle: 'front',
          status: 'hairDetected',
          is_hair: true,
          confidence: 0.88,
          message: 'Scalp and hair are visually present.',
          details: 'Visual check only.',
        }],
      });
      assert.equal(retried.scalp_photos[0].verification_status, 'hairDetected');
    } finally {
      const index = store.hairTests.findIndex((item) => item.reference_no === referenceNo);
      if (index >= 0) store.hairTests.splice(index, 1);
    }
  });
});
