import { NotFoundError } from '../../../shared/errors/index.js';
import { Product } from '../domain/Product.js';
import { getProductR2MediaKeys } from '../domain/productMedia.js';

export class UpdateProductUseCase {
  constructor({ productRepository, imageStorage, mediaReferenceRepository }) {
    this.productRepository = productRepository;
    this.imageStorage = imageStorage;
    this.mediaReferenceRepository = mediaReferenceRepository;
  }

  async execute({ id, ...payload }) {
    if (!id) {
      throw new NotFoundError('Product ID is required.');
    }
    const existing = await this.productRepository.findById(id);
    if (!existing) {
      throw new NotFoundError('Product not found.');
    }

    const merged = { ...existing, ...payload };
    const validated = Product.fromPayload(merged, id);
    const updated = await this.productRepository.update(id, validated.toJSON());

    const nextKeys = new Set(getProductR2MediaKeys(updated));
    const removedKeys = getProductR2MediaKeys(existing).filter((key) => !nextKeys.has(key));
    await Promise.all(removedKeys.map(async (key) => {
      if (!this.imageStorage || !this.mediaReferenceRepository) return;
      if (await this.mediaReferenceRepository.isReferenced(key)) return;
      try {
        await this.imageStorage.deleteImage(key);
      } catch (error) {
        console.warn('[media-cleanup] Removed product image could not be deleted from R2.', {
          productId: id,
          key,
          message: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }));
    return updated;
  }
}
