import { IReviewRepository } from '../domain/IReviewRepository.js';
import { Review } from '../domain/Review.js';
import { store } from '../../../shared/database/store.js';
import { isDatabaseConnected } from '../../../shared/database/database.js';
import { ReviewModel, nextId } from '../../../shared/database/models.js';

const toReview = (record) => {
  if (!record) return null;
  const plain = typeof record.toObject === 'function' ? record.toObject() : record;
  if (plain.created_at instanceof Date) plain.created_at = plain.created_at.toISOString();
  return new Review(plain);
};

export class ReviewRepository extends IReviewRepository {
  async findFiltered({ review_type, status, page, consent_verified } = {}) {
    if (isDatabaseConnected()) {
      const filter = {};
      if (review_type) filter.review_type = review_type;
      if (status) filter.status = status;
      if (page) filter.page = page;
      if (consent_verified === true) filter.consent_verified = true;
      const records = await ReviewModel.find(filter).sort({ created_at: -1 }).lean();
      return records.map(toReview);
    }
    let results = [...store.reviews];

    if (review_type) {
      results = results.filter((r) => !r.review_type || r.review_type === review_type);
    }

    if (status) {
      results = results.filter((r) => !r.status || r.status === status);
    }

    if (page) {
      results = results.filter((r) => !r.page || r.page === page);
    }

    if (consent_verified === true) results = results.filter((r) => r.consent_verified === true);

    return results.map((r) => new Review(r));
  }

  async create(reviewData) {
    if (isDatabaseConnected()) {
      return toReview(
        await ReviewModel.create({
          ...reviewData,
          id: await nextId('reviews'),
          created_at: new Date(),
        }),
      );
    }
    const newId = store.reviews.length > 0 ? Math.max(...store.reviews.map((r) => r.id)) + 1 : 1;
    const newRecord = {
      ...reviewData,
      id: newId,
      created_at: new Date().toISOString(),
    };

    store.reviews.push(newRecord);
    return new Review(newRecord);
  }

  async updateStatus(id, status) {
    const numericId = Number(id);
    if (isDatabaseConnected()) {
      return toReview(
        await ReviewModel.findOneAndUpdate(
          { id: numericId },
          { status, updated_at: new Date() },
          { new: true, runValidators: true },
        ).lean(),
      );
    }
    const review = store.reviews.find((record) => record.id === numericId);
    if (!review) return null;
    review.status = status;
    review.updated_at = new Date().toISOString();
    return new Review(review);
  }

  async findById(id) {
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId) || numericId < 1) return null;
    if (isDatabaseConnected()) return toReview(await ReviewModel.findOne({ id: numericId }).lean());
    const review = store.reviews.find((record) => Number(record.id) === numericId);
    return toReview(review);
  }

  async updateAdmin(id, updates = {}) {
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId) || numericId < 1) return null;
    const safeUpdates = { ...updates, updated_at: new Date().toISOString() };
    if (isDatabaseConnected()) {
      return toReview(await ReviewModel.findOneAndUpdate(
        { id: numericId },
        { $set: safeUpdates },
        { new: true, runValidators: true },
      ).lean());
    }
    const review = store.reviews.find((record) => Number(record.id) === numericId);
    if (!review) return null;
    Object.assign(review, safeUpdates);
    return toReview(review);
  }

  async delete(id) {
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId) || numericId < 1) return false;
    if (isDatabaseConnected()) {
      const result = await ReviewModel.deleteOne({ id: numericId });
      return result.deletedCount > 0;
    }
    const index = store.reviews.findIndex((record) => Number(record.id) === numericId);
    if (index < 0) return false;
    store.reviews.splice(index, 1);
    return true;
  }

  async listAdmin({ page = 1, limit = 25, status } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    if (isDatabaseConnected()) {
      const filter = status ? { status } : {};
      const [records, total] = await Promise.all([
        ReviewModel.find(filter).sort({ created_at: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
        ReviewModel.countDocuments(filter),
      ]);
      return { items: records.map(toReview), total, page: safePage, limit: safeLimit };
    }
    const matched = status ? store.reviews.filter((record) => record.status === status) : store.reviews;
    const start = (safePage - 1) * safeLimit;
    return {
      items: matched.slice(start, start + safeLimit).map(toReview),
      total: matched.length,
      page: safePage,
      limit: safeLimit,
    };
  }
}

