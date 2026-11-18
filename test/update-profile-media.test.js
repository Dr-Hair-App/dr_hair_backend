import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateProfileUseCase } from '../src/modules/users/application/UpdateProfileUseCase.js';
import { config } from '../src/config/env.js';

const profileUrl = (key) => `${config.baseUrl.replace(/\/$/, '')}/api/v1/media/assets/${key.split('/').map(encodeURIComponent).join('/')}`;

test('profile update accepts an uploaded image in the current owner-scoped profile folder', async () => {
  let update;
  const useCase = new UpdateProfileUseCase({
    userRepository: {
      async findById() { return { id: 42, name: 'Patient', email: 'patient@example.com', phone: '9876543210' }; },
      async update(_id, payload) { update = payload; return payload; },
    },
    imageStorage: {
      async hasOwnedProfileImage(key, userId) {
        return key === 'drhair/images/user-42/profile/avatar.webp' && userId === 42;
      },
    },
  });

  await useCase.execute({
    userId: 42,
    name: 'Patient',
    email: 'patient@example.com',
    contact: '9876543210',
    profileUrl: profileUrl('drhair/images/user-42/profile/avatar.webp'),
    verifiedLogin: '9876543210',
  });

  assert.equal(update.profile_url, profileUrl('drhair/images/user-42/profile/avatar.webp'));
});

test('profile update rejects profile URLs for missing or another user’s R2 assets', async () => {
  let updateCalled = false;
  const useCase = new UpdateProfileUseCase({
    userRepository: {
      async findById() { return { id: 42, name: 'Patient', email: 'patient@example.com', phone: '9876543210' }; },
      async update() { updateCalled = true; },
    },
    imageStorage: { async hasOwnedProfileImage() { return false; } },
  });

  await assert.rejects(useCase.execute({
    userId: 42,
    name: 'Patient',
    email: 'patient@example.com',
    contact: '9876543210',
    profileUrl: profileUrl('drhair/images/user-42/profile/not-uploaded.webp'),
    verifiedLogin: '9876543210',
  }), /does not belong to this account/);
  assert.equal(updateCalled, false);
});
