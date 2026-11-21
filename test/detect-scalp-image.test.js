import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DetectScalpImageUseCase } from '../src/modules/hair_test/application/DetectScalpImageUseCase.js';
import { HairTestController } from '../src/modules/hair_test/presentation/hair_test.controller.js';
import { BadRequestError } from '../src/shared/errors/index.js';

describe('Scalp Photo Detection & Cross-Photo Verification Integration Tests', () => {
  it('throws BadRequestError when neither imageBuffer nor base64 is provided to use case', async () => {
    const useCase = new DetectScalpImageUseCase({
      geminiAiService: { detectHairAndScalpImage: async () => ({}) },
    });

    await assert.rejects(
      async () => {
        await useCase.execute({});
      },
      (err) => {
        assert.ok(err instanceof BadRequestError);
        assert.match(err.message, /Image data or upload is required/i);
        return true;
      },
    );
  });

  it('use case passes reference image buffer and base64 to GeminiAiService', async () => {
    let capturedOptions;
    const mockAiService = {
      async detectHairAndScalpImage(options) {
        capturedOptions = options;
        return {
          is_hair: true,
          status: 'hairDetected',
          confidence: 0.95,
          same_person: true,
          detected_angle: options.label,
          message: 'Clear scalp verified.',
          details: 'Matches reference photo.',
        };
      },
    };

    const useCase = new DetectScalpImageUseCase({ geminiAiService: mockAiService });
    const targetBuffer = Buffer.from('target-image-bytes');
    const referenceBuffer = Buffer.from('ref-image-bytes');

    const result = await useCase.execute({
      imageBuffer: targetBuffer,
      label: 'Crown / Top',
      mimeType: 'image/jpeg',
      referenceImageBuffer: referenceBuffer,
      referenceMimeType: 'image/jpeg',
    });

    assert.equal(capturedOptions.label, 'Crown / Top');
    assert.equal(capturedOptions.imageBuffer, targetBuffer);
    assert.equal(capturedOptions.referenceImageBuffer, referenceBuffer);
    assert.equal(result.status, 'hairDetected');
    assert.equal(result.same_person, true);
  });

  it('controller handles multipart file and reference_image file upload and returns HTTP success envelope', async () => {
    const mockUseCase = {
      async execute({ imageBuffer, referenceImageBuffer, label }) {
        assert.ok(imageBuffer);
        assert.ok(referenceImageBuffer);
        assert.equal(label, 'Crown / Top');
        return {
          is_hair: false,
          status: 'personMismatch',
          confidence: 0.96,
          same_person: false,
          detected_angle: label,
          follicle_visibility: 'Clear',
          message: 'Photos appear to be of different people. Please ensure all 3 photos are of the same person.',
          details: 'Hair color does not match reference photo.',
        };
      },
    };

    const controller = new HairTestController({
      detectScalpImageUseCase: mockUseCase,
    });

    let sentStatus;
    let sentPayload;
    const req = {
      files: {
        image: [{ buffer: Buffer.from('target-scalp-bytes'), mimetype: 'image/jpeg' }],
        reference_image: [{ buffer: Buffer.from('reference-scalp-bytes'), mimetype: 'image/jpeg' }],
      },
      body: {
        label: 'Crown / Top',
      },
    };
    const res = {
      status(code) {
        sentStatus = code;
        return this;
      },
      json(payload) {
        sentPayload = payload;
        return this;
      },
    };
    const next = (err) => {
      if (err) throw err;
    };

    await controller.detectScalpImage(req, res, next);

    assert.equal(sentStatus, 200);
    assert.equal(sentPayload.status, 'success');
    assert.equal(sentPayload.data.status, 'personMismatch');
    assert.equal(sentPayload.data.same_person, false);
    assert.equal(sentPayload.data.is_hair, false);
    assert.match(sentPayload.data.message, /different people/i);
  });

  it('controller accepts base64 and reference_base64 from body', async () => {
    let capturedOptions;
    const mockUseCase = {
      async execute(options) {
        capturedOptions = options;
        return {
          is_hair: true,
          status: 'hairDetected',
          confidence: 0.94,
          same_person: true,
          detected_angle: 'Side Profile / Temples',
          message: 'Scalp verified.',
        };
      },
    };

    const controller = new HairTestController({
      detectScalpImageUseCase: mockUseCase,
    });

    let sentStatus;
    let sentPayload;
    const req = {
      body: {
        image_base64: 'dGFyZ2V0LWJhc2U2NA==',
        reference_image_base64: 'cmVmZXJlbmNlLWJhc2U2NA==',
        label: 'Side Profile / Temples',
      },
    };
    const res = {
      status(code) {
        sentStatus = code;
        return this;
      },
      json(payload) {
        sentPayload = payload;
        return this;
      },
    };

    await controller.detectScalpImage(req, res, () => {});

    assert.equal(sentStatus, 200);
    assert.equal(capturedOptions.base64Data, 'dGFyZ2V0LWJhc2U2NA==');
    assert.equal(capturedOptions.referenceBase64, 'cmVmZXJlbmNlLWJhc2U2NA==');
    assert.equal(sentPayload.data.status, 'hairDetected');
  });
});
