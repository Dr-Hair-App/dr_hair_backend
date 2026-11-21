import assert from 'node:assert/strict';
import test from 'node:test';
import { DetectScalpImageUseCase } from '../src/modules/hair_test/application/DetectScalpImageUseCase.js';
import { HairTestController } from '../src/modules/hair_test/presentation/hair_test.controller.js';

test('scalp verifier forwards target and same-session reference image to the vision adapter', async () => {
  const target = Buffer.from('synthetic-target');
  const reference = Buffer.from('synthetic-reference');
  let received;
  const useCase = new DetectScalpImageUseCase({
    geminiAiService: {
      async detectHairAndScalpImage(options) {
        received = options;
        return { is_hair: false, status: 'personMismatch', confidence: 0.95, same_person: false };
      },
    },
  });

  const result = await useCase.execute({
    imageBuffer: target,
    mimeType: 'image/jpeg',
    label: 'Crown / Top',
    referenceImageBuffer: reference,
    referenceMimeType: 'image/jpeg',
  });

  assert.equal(received.imageBuffer, target);
  assert.equal(received.referenceImageBuffer, reference);
  assert.equal(received.label, 'Crown / Top');
  assert.equal(result.status, 'personMismatch');
});

test('scalp detector controller reads optional reference image and returns verifier status', async () => {
  const target = { buffer: Buffer.from('synthetic-target'), mimetype: 'image/jpeg' };
  const reference = { buffer: Buffer.from('synthetic-reference'), mimetype: 'image/jpeg' };
  let received;
  const controller = new HairTestController({
    detectScalpImageUseCase: {
      async execute(options) {
        received = options;
        return { is_hair: false, status: 'personMismatch', confidence: 0.95, same_person: false };
      },
    },
  });
  let statusCode;
  let body;
  const response = {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return payload; },
  };

  await controller.detectScalpImage({
    files: { image: [target], reference_image: [reference] },
    body: { label: 'Crown / Top' },
  }, response, (error) => { throw error; });

  assert.equal(statusCode, 200);
  assert.equal(received.imageBuffer, target.buffer);
  assert.equal(received.referenceImageBuffer, reference.buffer);
  assert.equal(received.referenceMimeType, 'image/jpeg');
  assert.equal(body.data.status, 'personMismatch');
});
