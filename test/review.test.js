import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createContainer } from '../src/container.js';
import { AdminController } from '../src/modules/admin/presentation/admin.controller.js';

describe('Review Module - Clean Architecture Tests', () => {
  const container = createContainer();
  const { getReviewsUseCase, createReviewUseCase } = container.useCases;

  it('should fetch active reviews for the home page', async () => {
    const reviews = await getReviewsUseCase.execute({
      review_type: 'doctor',
      status: 'active',
      page: 'home',
    });

    assert.ok(Array.isArray(reviews));
    assert.ok(reviews.length >= 1);
    assert.equal(reviews[0].name, 'Yashveer Soni');
    assert.equal(reviews[0].rating, 5);
    assert.equal(reviews[0].is_verified, true);
  });

  it('should create a new customer review', async () => {
    const newReview = await createReviewUseCase.execute({
      name: 'Amit Patel',
      rating: 5,
      category: 'Regrowth',
      message: 'Great results on my scalp after 90 days!',
    });

    assert.equal(newReview.name, 'Amit Patel');
    assert.equal(newReview.rating, 5);
    assert.equal(newReview.category, 'Regrowth');
  });

  it('associates public product reviews with the requested product only', async () => {
    const { store } = await import('../src/shared/database/store.js');
    const first = {
      id: 940001,
      name: 'Product Patient',
      rating: 5,
      category: 'Product',
      message: 'Verified product review.',
      review_type: 'product',
      product_id: 'product-a',
      status: 'active',
      page: 'home',
      is_verified: false,
      consent_verified: true,
    };
    const second = {
      ...first,
      id: 940002,
      product_id: 'product-b',
    };
    store.reviews.push(first, second);

    try {
      const reviews = await getReviewsUseCase.execute({
        review_type: 'product',
        product_id: 'product-a',
        page: 'home',
      });

      assert.equal(reviews.length, 1);
      assert.equal(reviews[0].product_id, 'product-a');
      assert.equal(reviews[0].is_verified, false);
    } finally {
      store.reviews = store.reviews.filter(
        (review) => ![940001, 940002].includes(review.id),
      );
    }
  });

  it('rejects attaching a product ID to a non-product review', async () => {
    await assert.rejects(
      createReviewUseCase.execute({
        name: 'Patient',
        rating: 5,
        category: 'Hair Fall',
        message: 'A review.',
        review_type: 'doctor',
        product_id: 'product-a',
      }),
      /product IDs can only be attached to product reviews/,
    );
  });

  it('requires a product ID for a product review', async () => {
    await assert.rejects(
      createReviewUseCase.execute({
        name: 'Patient',
        rating: 5,
        category: 'Product',
        message: 'A product review.',
        review_type: 'product',
      }),
      /must include a product ID/,
    );
  });

  it('preserves product association when an admin creates a product review', async () => {
    let storedReview;
    const controller = new AdminController({
      reviewRepository: {
        create: async (review) => {
          storedReview = review;
          return { id: 940003, ...review };
        },
      },
    });
    const response = { statusCode: 200, body: null };
    const res = {
      status(code) {
        response.statusCode = code;
        return this;
      },
      json(body) {
        response.body = body;
        return body;
      },
    };

    await controller.createAdminReview(
      {
        body: {
          name: 'Patient',
          rating: 5,
          category: 'Product',
          message: 'A product review.',
          review_type: 'product',
          product_id: 'product-a',
        },
        user: { email: 'admin@example.test' },
      },
      res,
      (error) => { throw error; },
    );

    assert.equal(response.statusCode, 201);
    assert.equal(storedReview.product_id, 'product-a');
    assert.equal(response.body.data.product_id, 'product-a');
  });
});

