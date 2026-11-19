import { sendSuccess } from '../../../shared/utils/response.js';
import { BadRequestError } from '../../../shared/errors/index.js';
import { cleanupUploadedProductFiles } from '../application/product-media-input.js';

function getProductPayload(req) {
  if (!req.is('multipart/form-data')) return req.body || {};
  const raw = req.body?.product;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new BadRequestError('Include product metadata in the multipart "product" field.');
  }
  let payload;
  try { payload = JSON.parse(raw); } catch {
    throw new BadRequestError('The multipart "product" field must contain valid JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BadRequestError('The multipart "product" field must contain a JSON object.');
  }
  return payload;
}

const uploadedImagesFrom = (req) => Array.isArray(req.files?.files) ? req.files.files : [];

export class ProductController {
  constructor({
    listProductsUseCase,
    getProductByIdUseCase,
    createProductUseCase,
    updateProductUseCase,
    deleteProductUseCase,
    listCategoriesUseCase,
    imageStorage,
  }) {
    this.listProductsUseCase = listProductsUseCase;
    this.getProductByIdUseCase = getProductByIdUseCase;
    this.createProductUseCase = createProductUseCase;
    this.updateProductUseCase = updateProductUseCase;
    this.deleteProductUseCase = deleteProductUseCase;
    this.listCategoriesUseCase = listCategoriesUseCase;
    this.imageStorage = imageStorage;
  }

  listCategories = async (req, res, next) => {
    try {
      if (this.listCategoriesUseCase) {
        const result = await this.listCategoriesUseCase.execute({ type: 'products' });
        return sendSuccess(res, result.products || [], 'Product categories retrieved successfully.');
      }
      return sendSuccess(res, [], 'Product categories retrieved successfully.');
    } catch (error) {
      next(error);
    }
  };

  list = async (req, res, next) => {
    try {
      const {
        category,
        root_cause,
        rootCause,
        search,
        q,
        in_stock,
        inStock,
        status,
        page,
        limit,
      } = req.query;

      const result = await this.listProductsUseCase.execute({
        category,
        rootCause: root_cause || rootCause,
        search: search || q,
        inStock: in_stock !== undefined ? in_stock === 'true' : inStock !== undefined ? inStock === 'true' : undefined,
        status: status || 'active',
        page,
        limit,
      });

      return sendSuccess(res, {
        message: 'Products retrieved successfully.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  listAdmin = async (req, res, next) => {
    try {
      const {
        category,
        rootCause,
        search,
        status,
        page,
        limit,
      } = req.query;

      const result = await this.listProductsUseCase.execute({
        category,
        rootCause,
        search,
        status: status || 'all',
        page,
        limit,
      });

      return sendSuccess(res, {
        message: 'Admin products catalog retrieved successfully.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  getById = async (req, res, next) => {
    try {
      const { id } = req.params;
      const product = await this.getProductByIdUseCase.execute({ id });
      return sendSuccess(res, {
        message: 'Product retrieved successfully.',
        data: product,
      });
    } catch (error) {
      next(error);
    }
  };

  create = async (req, res, next) => {
    const files = uploadedImagesFrom(req);
    const multipart = req.is('multipart/form-data');
    let delegatedToUseCase = false;
    try {
      const payload = getProductPayload(req);
      delegatedToUseCase = true;
      const product = await this.createProductUseCase.execute(payload, { uploadedFiles: files, replaceMedia: multipart });
      return sendSuccess(res, {
        message: 'Product created successfully.',
        data: product,
        statusCode: 201,
      });
    } catch (error) {
      if (!delegatedToUseCase) await cleanupUploadedProductFiles(files, this.imageStorage);
      next(error);
    }
  };

  update = async (req, res, next) => {
    const files = uploadedImagesFrom(req);
    let delegatedToUseCase = false;
    try {
      const { id } = req.params;
      const payload = getProductPayload(req);
      delegatedToUseCase = true;
      const product = await this.updateProductUseCase.execute(
        { id, ...payload },
        { uploadedFiles: files, replaceMedia: req.is('multipart/form-data') },
      );
      return sendSuccess(res, {
        message: 'Product updated successfully.',
        data: product,
      });
    } catch (error) {
      if (!delegatedToUseCase) await cleanupUploadedProductFiles(files, this.imageStorage);
      next(error);
    }
  };

  delete = async (req, res, next) => {
    try {
      const { id } = req.params;
      await this.deleteProductUseCase.execute({ id });
      return sendSuccess(res, {
        message: 'Product deleted successfully.',
      });
    } catch (error) {
      next(error);
    }
  };
}
