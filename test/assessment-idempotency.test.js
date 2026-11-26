import test from 'node:test';
import assert from 'node:assert/strict';
import { SubmitHairTestUseCase } from '../src/modules/hair_test/application/SubmitHairTestUseCase.js';
import { HairTestRepository } from '../src/modules/hair_test/infrastructure/HairTestRepository.js';
import { store } from '../src/shared/database/store.js';

const key = 'a'.repeat(64);
const hash = 'b'.repeat(64);
const userId = 98765431;
const file = (suffix) => ({ photo_front: [{ publicId: `drhair/images/user-${userId}/assessment/${suffix}.jpg`, sha256: hash }] });

test('assessment retry and simultaneous submission reuse the patient-scoped result', async (t) => {
  t.after(() => { store.hairTests = store.hairTests.filter((item) => item.userId !== userId); });
  const deleted = [];
  const useCase = new SubmitHairTestUseCase({
    hairTestRepository: new HairTestRepository(),
    imageStorage: {
      async getAuthenticatedImage(publicId) { return { public_id: publicId, type: 'authenticated', secure_url: 'https://example.test/photo', format: 'jpg', bytes: 10 }; },
      async deleteImage(publicId) { deleted.push(publicId); },
    },
  });
  const data = { full_name: 'Synthetic patient', submission_key: key, duration: '6 - 12 months' };
  const [first, second] = await Promise.all([
    useCase.execute({ userId, formData: data, files: file('one') }),
    useCase.execute({ userId, formData: data, files: file('two') }),
  ]);
  assert.equal(first.reference_no, second.reference_no);
  assert.equal(store.hairTests.filter((item) => item.userId === userId).length, 1);
  assert.equal(deleted.length, 1);
  assert.equal(first.test.request_fingerprint, undefined);
  await assert.rejects(useCase.execute({ userId, formData: { ...data, duration: '1 - 3 years' }, files: file('three') }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'CONFLICT');
    assert.equal(error.details.reason, 'ASSESSMENT_ALREADY_SUBMITTED');
    assert.equal(error.details.reference_no, first.reference_no);
    return true;
  });
  assert.equal(store.hairTests.filter((item) => item.userId === userId).length, 1);
});

test('a failed submission does not delete previously uploaded legacy references', async () => {
  const deleted = [];
  const publicId = `drhair/images/user-${userId}/assessment/existing.jpg`;
  const useCase = new SubmitHairTestUseCase({
    hairTestRepository: { async create() { throw new Error('synthetic database failure'); } },
    imageStorage: {
      async getAuthenticatedImage(key) { return { public_id: key, type: 'authenticated', secure_url: 'https://example.test/photo' }; },
      async deleteImage(key) { deleted.push(key); },
    },
  });
  await assert.rejects(useCase.execute({ userId, formData: { full_name: 'Synthetic patient', photo_front_id: publicId } }));
  assert.deepEqual(deleted, []);
});

test('the same submission key does not reveal or reuse another patient assessment', async (t) => {
  const firstPatient = 98765433;
  const secondPatient = 98765434;
  t.after(() => { store.hairTests = store.hairTests.filter((item) => ![firstPatient, secondPatient].includes(item.userId)); });
  const useCase = new SubmitHairTestUseCase({ hairTestRepository: new HairTestRepository(), imageStorage: {} });
  const formData = { full_name: 'Synthetic patient', submission_key: 'd'.repeat(64) };
  const first = await useCase.execute({ userId: firstPatient, formData });
  const second = await useCase.execute({ userId: secondPatient, formData });
  assert.notEqual(first.reference_no, second.reference_no);
  assert.equal(first.test.userId, firstPatient);
  assert.equal(second.test.userId, secondPatient);
});
