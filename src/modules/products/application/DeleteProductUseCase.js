import { NotFoundError } from '../../../shared/errors/index.js';
import { getProductR2MediaKeys } from '../domain/productMedia.js';

export class DeleteProductUseCase {
  constructor({ productRepository, imageStorage, mediaReferenceRepository }) {
    this.productRepository = productRepository;
    this.imageStorage = imageStorage;
    this.mediaReferenceRepository = mediaReferenceRepository;
  }

  async execute({ id }) {
    if (!id) {
      throw new NotFoundError('Product ID is required.');
    }
    const existing = await this.productRepository.findById(id);
    if (!existing) {
      throw new NotFoundError('Product not found.');
    }
    const deleted = await this.productRepository.delete(id);
    if (deleted && this.imageStorage && this.mediaReferenceRepository) {
      await Promise.all(getProductR2MediaKeys(existing).map(async (key) => {
        if (await this.mediaReferenceRepository.isReferenced(key)) return;
        try {
          await this.imageStorage.deleteImage(key);
        } catch (error) {
          console.warn('[media-cleanup] Deleted product image could not be removed from R2.', {
            errorType: error instanceof Error ? error.constructor?.name || 'Error' : 'UnknownError',
          });
        }
      }));
    }
    return { success: deleted };
  }
}
