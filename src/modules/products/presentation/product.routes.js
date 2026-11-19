import { Router } from 'express';
import { authenticateToken } from '../../../shared/middlewares/auth.middleware.js';
import { requireAnyPermission } from '../../../shared/middlewares/admin.middleware.js';
import { enforceUploadRequestSize } from '../../../shared/middlewares/upload.middleware.js';
import { uploadProductImages } from './product-image-upload.middleware.js';

export function createProductRouters({ productController }) {
  const publicRouter = Router();
  publicRouter.get('/categories', productController.listCategories);
  publicRouter.get('/', productController.list);
  publicRouter.get('/:id', productController.getById);

  const adminRouter = Router();
  adminRouter.use(authenticateToken, requireAnyPermission('products.manage', 'super_admin'));
  adminRouter.get('/categories', productController.listCategories);
  adminRouter.get('/', productController.listAdmin);
  adminRouter.get('/:id', productController.getById);
  adminRouter.post('/', enforceUploadRequestSize, uploadProductImages, productController.create);
  adminRouter.patch('/:id', enforceUploadRequestSize, uploadProductImages, productController.update);
  adminRouter.delete('/:id', productController.delete);

  return { publicRouter, adminRouter };
}
