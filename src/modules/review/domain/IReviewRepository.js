/**
 * Review Repository Interface
 */
export class IReviewRepository {
  async findFiltered({ review_type, status, page }) {
    throw new Error('Method not implemented');
  }

  async create(reviewData) {
    throw new Error('Method not implemented');
  }

  async updateAdmin(id, updates) {
    throw new Error('Method not implemented');
  }

  async delete(id) {
    throw new Error('Method not implemented');
  }
}

