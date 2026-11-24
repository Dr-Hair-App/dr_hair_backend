import { sendSuccess } from '../../../shared/utils/response.js';

export class ReviewController {
  constructor({ getReviewsUseCase, createReviewUseCase }) {
    this.getReviewsUseCase = getReviewsUseCase;
    this.createReviewUseCase = createReviewUseCase;
  }

  getReviews = async (req, res, next) => {
    try {
      const review_type =
        req.query?.category ||
        req.query?.review_type ||
        req.body?.category ||
        req.body?.review_type;
      const page = req.query?.page || req.body?.page;
      const product_id = req.query?.product_id || req.body?.product_id;
      const params = {};
      if (review_type !== undefined) params.review_type = review_type;
      if (page !== undefined) params.page = page;
      if (product_id !== undefined) params.product_id = product_id;
      const data = await this.getReviewsUseCase.execute(params);

      return sendSuccess(res, { data });
    } catch (err) {
      next(err);
    }
  };

  createReview = async (req, res, next) => {
    try {
      const { name, rating, category, message, avatar, review_type, product_id, page } = req.body;
      const data = await this.createReviewUseCase.execute({
        name,
        rating,
        category,
        message,
        avatar,
        review_type,
        product_id,
        page,
      });

      return sendSuccess(res, {
        message: 'Review created successfully.',
        data,
        statusCode: 201,
      });
    } catch (err) {
      next(err);
    }
  };
}

