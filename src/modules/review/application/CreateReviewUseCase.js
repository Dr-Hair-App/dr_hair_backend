import { BadRequestError } from '../../../shared/errors/index.js';

export class CreateReviewUseCase {
  constructor({ reviewRepository }) {
    this.reviewRepository = reviewRepository;
  }

  async execute({ name, rating, category, message, avatar, review_type = 'doctor', product_id, page = 'home' }) {
    const cleanName = typeof name === 'string' ? name.trim() : '';
    const cleanMessage = typeof message === 'string' ? message.trim() : '';
    const cleanCategory = typeof category === 'string' ? category.trim() : 'Hair Treatment';
    const cleanType = String(review_type || 'doctor').trim().toLowerCase();
    const cleanProductId = String(product_id || '').trim();
    const cleanPage = String(page || 'home').trim().toLowerCase();
    const numericRating = Number(rating ?? 5);
    if (!cleanName || cleanName.length > 80 || !cleanMessage || cleanMessage.length > 1500) {
      throw new BadRequestError('Name (1–80 characters) and review message (1–1500 characters) are required.');
    }
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      throw new BadRequestError('Rating must be a whole number from 1 to 5.');
    }
    if (cleanCategory.length > 80 || !['doctor', 'product', 'clinic'].includes(cleanType) || !['home', 'reels'].includes(cleanPage)) {
      throw new BadRequestError('Choose a valid review category and destination.');
    }
    if (
      cleanProductId.length > 100 ||
      (cleanProductId && cleanType !== 'product') ||
      (cleanType === 'product' && !cleanProductId)
    ) {
      throw new BadRequestError(
        'Product reviews must include a product ID, and product IDs can only be attached to product reviews.',
      );
    }

    const review = await this.reviewRepository.create({
      name: cleanName,
      rating: numericRating,
      category: cleanCategory || 'Hair Treatment',
      message: cleanMessage,
      avatar: '',
      is_verified: false,
      review_type: cleanType,
      product_id: cleanProductId,
      status: 'pending',
      page: cleanPage,
    });

    return review.toPublicResponse();
  }
}

