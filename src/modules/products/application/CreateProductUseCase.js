import { Product } from '../domain/Product.js';
import { cleanupUploadedProductFiles, resolveProductMediaInput } from './product-media-input.js';

export class CreateProductUseCase {
  constructor({ productRepository, imageStorage }) {
    this.productRepository = productRepository;
    this.imageStorage = imageStorage;
  }

  async execute(payload = {}, { uploadedFiles = [], replaceMedia = false } = {}) {
    try {
      const resolvedPayload = resolveProductMediaInput(payload, uploadedFiles, null, { replaceMedia });
      const product = Product.fromPayload(resolvedPayload);
      return await this.productRepository.create(product.toJSON());
    } catch (error) {
      await cleanupUploadedProductFiles(uploadedFiles, this.imageStorage);
      throw error;
    }
  }
}
