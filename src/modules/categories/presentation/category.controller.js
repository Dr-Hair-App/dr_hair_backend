import { BadRequestError, NotFoundError } from '../../../shared/errors/index.js';
import { sendSuccess } from '../../../shared/utils/response.js';
import { CategoryRepository } from '../infrastructure/CategoryRepository.js';

export class CategoryController {
  constructor({ listCategoriesUseCase, categoryRepository } = {}) {
    this.listCategoriesUseCase = listCategoriesUseCase;
    this.categoryRepository = categoryRepository || new CategoryRepository();
  }

  list = async (req, res, next) => {
    try {
      const { type } = req.query;
      const data = await this.listCategoriesUseCase.execute({ type });
      return sendSuccess(res, data, 'Categories retrieved successfully');
    } catch (error) {
      next(error);
    }
  };

  listProducts = async (req, res, next) => {
    try {
      const result = await this.listCategoriesUseCase.execute({ type: 'products' });
      return sendSuccess(res, result.products || [], 'Product categories retrieved successfully');
    } catch (error) {
      next(error);
    }
  };

  listVideos = async (req, res, next) => {
    try {
      const result = await this.listCategoriesUseCase.execute({ type: 'videos' });
      return sendSuccess(res, result.videos || [], 'Video categories retrieved successfully');
    } catch (error) {
      next(error);
    }
  };

  listServices = async (req, res, next) => {
    try {
      const services = await this.categoryRepository.list({ type: 'services', status: 'active' });
      return sendSuccess(res, services, 'Service categories retrieved successfully');
    } catch (error) {
      next(error);
    }
  };

  listServicesForHome = async (_req, res, next) => {
    try {
      const services = await this.categoryRepository.list({ type: 'services', status: 'active' });
      return res.status(200).json(services.map((service) => ({
        id: String(service.id || service.slug || ''),
        title: service.name,
        description: service.description || '',
        imageUrl: service.imageUrl || '',
        rating: 0,
        reviewsCount: 0,
        price: String(service.price ?? ''),
      })));
    } catch (error) {
      next(error);
    }
  };

  listConcerns = async (req, res, next) => {
    try {
      const result = await this.listCategoriesUseCase.execute({ type: 'concerns' });
      return sendSuccess(res, result.concerns || [], 'Clinical concern categories retrieved successfully');
    } catch (error) {
      next(error);
    }
  };

  create = async (req, res, next) => {
    try {
      const { name, type = 'video', icon, imageUrl, price, badge, description, status = 'active', display_order = 0 } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        throw new BadRequestError('Category name is required.');
      }
      if (name.trim().length > 80) {
        throw new BadRequestError('Category name must be at most 80 characters.');
      }
      if (!['products', 'videos', 'services', 'concerns', 'video', 'product', 'service', 'concern'].includes(type)) {
        throw new BadRequestError('Category type is invalid.');
      }
      if (!['active', 'inactive'].includes(status)) {
        throw new BadRequestError('Category status must be active or inactive.');
      }
      if (icon !== undefined && (typeof icon !== 'string' || icon.length > 80)) {
        throw new BadRequestError('Category icon must be a string of at most 80 characters.');
      }
      if (imageUrl !== undefined && (typeof imageUrl !== 'string' || imageUrl.length > 2048)) {
        throw new BadRequestError('Category imageUrl must be a string of at most 2048 characters.');
      }
      if (price !== undefined && ((typeof price !== 'string' && typeof price !== 'number') || String(price).length > 50 || (typeof price === 'number' && (!Number.isFinite(price) || price < 0)))) {
        throw new BadRequestError('Category price must be a string or number of at most 50 characters.');
      }
      if (badge !== undefined && badge !== null && (typeof badge !== 'string' || badge.length > 80)) {
        throw new BadRequestError('Category badge must be a string of at most 80 characters.');
      }
      if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
        throw new BadRequestError('Category description must be a string of at most 500 characters.');
      }
      const order = Number(display_order);
      if (!Number.isInteger(order) || order < 0 || order > 100000) {
        throw new BadRequestError('Category display_order must be an integer between 0 and 100000.');
      }

      const created = await this.categoryRepository.create({
        name: name.trim(),
        type: type || 'video',
        icon: icon || (type === 'video' ? 'film' : 'sparkles'),
        imageUrl: imageUrl || '',
        price: price ?? '',
        badge: badge || null,
        description: typeof description === 'string' ? description.trim() : '',
        status: status === 'inactive' ? 'inactive' : 'active',
        display_order: order,
      });

      return sendSuccess(res, created, 'Category created successfully', 201);
    } catch (error) {
      next(error);
    }
  };

  update = async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id) {
        throw new BadRequestError('Category ID is required.');
      }
      const existing = await this.categoryRepository.findById(id);
      if (!existing) {
        throw new NotFoundError('Category not found.');
      }

      const input = req.body || {};
      const allowedFields = ['name', 'slug', 'icon', 'imageUrl', 'price', 'badge', 'description', 'status', 'display_order'];
      const unknownFields = Object.keys(input).filter((field) => !allowedFields.includes(field));
      if (unknownFields.length) {
        throw new BadRequestError(`Unsupported category fields: ${unknownFields.join(', ')}.`);
      }
      if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80)) {
        throw new BadRequestError('Category name must contain 1 to 80 characters.');
      }
      if (input.slug !== undefined && (typeof input.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(input.slug.trim()) || input.slug.length > 100)) {
        throw new BadRequestError('Category slug must contain only letters, numbers, and single hyphens.');
      }
      if (input.icon !== undefined && (typeof input.icon !== 'string' || input.icon.length > 80)) {
        throw new BadRequestError('Category icon must be a string of at most 80 characters.');
      }
      if (input.imageUrl !== undefined && (typeof input.imageUrl !== 'string' || input.imageUrl.length > 2048)) {
        throw new BadRequestError('Category imageUrl must be a string of at most 2048 characters.');
      }
      if (input.price !== undefined && ((typeof input.price !== 'string' && typeof input.price !== 'number') || String(input.price).length > 50 || (typeof input.price === 'number' && (!Number.isFinite(input.price) || input.price < 0)))) {
        throw new BadRequestError('Category price must be a string or number of at most 50 characters.');
      }
      if (input.badge !== undefined && input.badge !== null && (typeof input.badge !== 'string' || input.badge.length > 80)) {
        throw new BadRequestError('Category badge must be a string of at most 80 characters.');
      }
      if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) {
        throw new BadRequestError('Category description must be a string of at most 500 characters.');
      }
      if (input.status !== undefined && !['active', 'inactive'].includes(input.status)) {
        throw new BadRequestError('Category status must be active or inactive.');
      }
      if (input.display_order !== undefined && (!Number.isInteger(Number(input.display_order)) || Number(input.display_order) < 0 || Number(input.display_order) > 100000)) {
        throw new BadRequestError('Category display_order must be an integer between 0 and 100000.');
      }
      const updated = await this.categoryRepository.update(id, input);
      return sendSuccess(res, updated, 'Category updated successfully');
    } catch (error) {
      next(error);
    }
  };

  delete = async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id) {
        throw new BadRequestError('Category ID is required.');
      }
      const existing = await this.categoryRepository.findById(id);
      if (!existing) {
        throw new NotFoundError('Category not found.');
      }

      const success = await this.categoryRepository.delete(id);
      return sendSuccess(res, { success: Boolean(success), id }, 'Category deleted successfully');
    } catch (error) {
      next(error);
    }
  };
}
