import { NotFoundError } from '../../../shared/errors/index.js';
import { Product } from '../domain/Product.js';
import { getProductR2MediaKeys } from '../domain/productMedia.js';
import { cleanupUploadedProductFiles, resolveProductMediaInput } from './product-media-input.js';

export class UpdateProductUseCase {
  constructor({ productRepository, imageStorage, mediaReferenceRepository }) {
    this.productRepository = productRepository;
    this.imageStorage = imageStorage;
    this.mediaReferenceRepository = mediaReferenceRepository;
  }

  async execute({ id, ...payload }, { uploadedFiles = [], replaceMedia = false } = {}) {
    if (!id) {
      await cleanupUploadedProductFiles(uploadedFiles, this.imageStorage);
      throw new NotFoundError('Product ID is required.');
    }
    let existing;
    let updated;
    try {
      existing = await this.productRepository.findById(id);
      if (!existing) throw new NotFoundError('Product not found.');
      const resolvedPayload = resolveProductMediaInput(payload, uploadedFiles, existing, { replaceMedia });
      const merged = { ...existing, ...resolvedPayload };
      const validated = Product.fromPayload(merged, id);
      updated = await this.productRepository.update(id, validated.toJSON());
      if (!updated) throw new NotFoundError('Product not found.');
    } catch (error) {
      await cleanupUploadedProductFiles(uploadedFiles, this.imageStorage);
      throw error;
    }

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
