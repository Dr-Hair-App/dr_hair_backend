import { NotFoundError, BadRequestError, UnauthorizedError } from '../../../shared/errors/index.js';
import { normalizeLogin } from '../../../shared/utils/normalize-login.js';

const validateProfileUrl = (profileUrl, userId) => {
  if (profileUrl === null) return null;
  if (typeof profileUrl !== 'string' || !profileUrl.trim()) {
    throw new BadRequestError('profile_url must be an R2 media URL or null.');
  }

  let parsed;
  try {
    parsed = new URL(profileUrl);
  } catch {
    throw new BadRequestError('profile_url must be a valid R2 media URL.');
  }
  const marker = '/api/v1/media/assets/';
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' || !parsed.pathname.includes(marker)) {
    throw new BadRequestError('profile_url must point to the Dr. Hair R2 media endpoint.');
  }
  const key = parsed.pathname.slice(parsed.pathname.indexOf(marker) + marker.length).split('/').map(decodeURIComponent).join('/');
  if (!key.startsWith(`drhair/images/profiles/user-${userId}.`)) {
    throw new UnauthorizedError('That uploaded profile image does not belong to this account.');
  }
  return profileUrl.trim();
};

export class UpdateProfileUseCase {
  constructor({ userRepository }) {
    this.userRepository = userRepository;
  }

  async execute({ userId, name, email, contact, age, gender, city, occupation, profileUrl, verifiedLogin }) {
    const cleanName = String(name || '').trim();
    const cleanEmail = String(email || '').trim();
    const cleanContact = String(contact || '').trim();
    if (!userId) {
      throw new BadRequestError('User ID is required');
    }

    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found.');
    }

    const identity = normalizeLogin(verifiedLogin || user.phone || user.email || (user.id ? String(user.id) : ''));
    if (!identity) throw new UnauthorizedError('A verified login is required to update this profile.');
    if (
      cleanEmail
      && normalizeLogin(cleanEmail) !== normalizeLogin(user.email)
      && (!identity.includes('@') || normalizeLogin(cleanEmail) !== identity)
    ) {
      throw new UnauthorizedError('Verify the new email address before changing it.');
    }
    if (
      cleanContact
      && normalizeLogin(cleanContact) !== normalizeLogin(user.phone)
      && (identity.includes('@') || normalizeLogin(cleanContact) !== identity)
    ) {
      throw new UnauthorizedError('Verify the new phone number before changing it.');
    }

    const updatePayload = {};
    if (cleanName) updatePayload.name = cleanName;
    if (cleanEmail) updatePayload.email = cleanEmail;
    if (cleanContact) updatePayload.phone = cleanContact;

    if (typeof age !== 'undefined') {
      const cleanAge = age === null || String(age).trim() === '' ? null : Number(age);
      if (cleanAge !== null && (!Number.isInteger(cleanAge) || cleanAge < 1 || cleanAge > 120)) {
        throw new BadRequestError('Age must be a whole number between 1 and 120.');
      }
      updatePayload.age = cleanAge;
    }
    if (typeof gender !== 'undefined') updatePayload.gender = String(gender || '').trim() || null;
    if (typeof city !== 'undefined') updatePayload.city = String(city || '').trim() || null;
    if (typeof occupation !== 'undefined') updatePayload.occupation = String(occupation || '').trim() || null;
    if (typeof profileUrl !== 'undefined') updatePayload.profile_url = validateProfileUrl(profileUrl, userId);

    if (Object.keys(updatePayload).length === 0) {
      throw new BadRequestError('At least one profile field must be provided.');
    }

    const updatedUser = await this.userRepository.update(userId, updatePayload);

    return {
      user: updatedUser,
      message: 'Profile updated successfully.',
    };
  }
}

