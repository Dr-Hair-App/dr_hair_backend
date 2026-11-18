import { NotFoundError, BadRequestError } from '../../../shared/errors/index.js';

const ownedProfilePublicId = (url, userId) => {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    const marker = '/api/v1/media/assets/';
    if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.pathname.includes(marker)) return null;
    const key = parsed.pathname.slice(parsed.pathname.indexOf(marker) + marker.length).split('/').map(decodeURIComponent).join('/');
    return key.startsWith(`drhair/images/profiles/user-${userId}.`)
      || key.startsWith(`drhair/images/user-${userId}/profile/`) ? key : null;
  } catch {
    return null;
  }
};

export class UpdateProfilePictureUseCase {
  constructor({ userRepository, imageStorage }) {
    this.userRepository = userRepository;
    this.imageStorage = imageStorage;
  }

  async execute({ userId, file, action }) {
    if (!userId) {
      throw new BadRequestError('User ID is required');
    }

    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found.');
    }

    if (action === 'remove') {
      const publicId = ownedProfilePublicId(user.profile_url, userId);
      const updatedUser = await this.userRepository.updateAvatar(userId, null);
      if (publicId) await this.imageStorage.deleteImage(publicId);
      return {
        profileUrl: null,
        user: updatedUser,
        message: 'Profile photo removed successfully.',
      };
    }

    if (action !== 'upload') {
      throw new BadRequestError('action must be upload or remove.');
    }

    if (!file) {
      throw new BadRequestError('Profile image file is required');
    }

    // Relative path stored in database (e.g. 'uploads/profiles/filename.jpg')
    const stored = await this.imageStorage.uploadImage(
      file.buffer,
      'profiles',
      'user-' + userId,
      { contentType: file.mimetype || 'image/jpeg' },
    );
    let updatedUser;
    try {
      updatedUser = await this.userRepository.updateAvatar(userId, stored.secureUrl);
    } catch (error) {
      await this.imageStorage.deleteImage(stored.publicId).catch(() => null);
      throw error;
    }

    return {
      profileUrl: stored.secureUrl,
      user: updatedUser,
      message: 'Profile photo updated successfully.',
    };
  }
}

