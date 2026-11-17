import { Router } from 'express';
import { authenticateToken } from '../../../shared/middlewares/auth.middleware.js';
import { requireAnyPermission } from '../../../shared/middlewares/admin.middleware.js';

export function createCategoryRouter({ categoryController }) {
  const router = Router();

  router.get('/', categoryController.list);
  router.get('/products', categoryController.listProducts);
  router.get('/videos', categoryController.listVideos);
  router.get('/services', categoryController.listServices);
  router.get('/concerns', categoryController.listConcerns);

  const manageCategories = [authenticateToken, requireAnyPermission('products.manage', 'content.edit')];
  router.post('/', ...manageCategories, categoryController.create);
  router.put('/:id', ...manageCategories, categoryController.update);
  router.patch('/:id', ...manageCategories, categoryController.update);
  router.delete('/:id', ...manageCategories, categoryController.delete);

  return router;
}
