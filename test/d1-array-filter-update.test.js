import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { D1Model } from '../src/shared/database/D1Model.js';

describe('D1 positional array updates', () => {
  it('updates an array entry by stable key and does not recreate a removed entry', async () => {
    const model = new D1Model(`d1_array_filter_${Date.now()}`);
    const documentId = `assessment-${Date.now()}`;
    await model.create({
      _id: documentId,
      scalp_photos: [
        { file_name: 'front.webp', verification_status: 'pending' },
        { file_name: 'top.webp', verification_status: 'pending' },
      ],
    });

    const updated = await model.findOneAndUpdate(
      { _id: documentId },
      { $set: { 'scalp_photos.$[photo0].verification_status': 'hairDetected' } },
      { new: true, arrayFilters: [{ 'photo0.file_name': 'front.webp' }] },
    );
    assert.equal(updated.scalp_photos[0].verification_status, 'hairDetected');
    assert.equal(updated.scalp_photos[1].verification_status, 'pending');

    await model.findOneAndUpdate(
      { _id: documentId },
      { $pull: { scalp_photos: { file_name: 'front.webp' } } },
      { new: true },
    );
    const afterRemoval = await model.findOneAndUpdate(
      { _id: documentId },
      { $set: { 'scalp_photos.$[photo0].verification_status': 'notHair' } },
      { new: true, arrayFilters: [{ 'photo0.file_name': 'front.webp' }] },
    );
    assert.deepEqual(afterRemoval.scalp_photos, [
      { file_name: 'top.webp', verification_status: 'pending' },
    ]);
  });
});
