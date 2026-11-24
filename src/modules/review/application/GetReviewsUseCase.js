export class GetReviewsUseCase {
  constructor({ reviewRepository }) {
    this.reviewRepository = reviewRepository;
  }

  async execute({ review_type = 'doctor', page = 'home', product_id } = {}) {
    const reviews = await this.reviewRepository.findFiltered({
      review_type,
      ...(product_id ? { product_id: String(product_id) } : {}),
      status: 'active',
      page,
      consent_verified: true,
    });

    return reviews.map((r) => r.toPublicResponse());
  }
}

