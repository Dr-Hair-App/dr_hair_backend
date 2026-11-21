import { Router } from 'express';
import { authenticateToken } from '../../../shared/middlewares/auth.middleware.js';
import { requireRegisteredUser } from '../../../shared/middlewares/registered-user.middleware.js';
import { enforceUploadRequestSize, parseFormData } from '../../../shared/middlewares/upload.middleware.js';
import {
  cleanupPatientUploadOnError,
  parseProfileUpdateMultipart,
  uploadProfilePhotoForUpdate,
} from '../../../shared/middlewares/patient-media-upload.middleware.js';

export const createUserRouter = ({ userController }) => {
  const router = Router();

  // Legacy & Flutter App routes (Mountable at /Admin or /api/v1/users)
  router.post('/checkUser', authenticateToken, userController.checkUser);
  router.post('/loginSignup', authenticateToken, parseFormData, userController.registerUser);
  router.post('/get_profile', authenticateToken, requireRegisteredUser, parseFormData, userController.getProfile);
  router.post('/updateProfile', authenticateToken, requireRegisteredUser, enforceUploadRequestSize, uploadProfilePhotoForUpdate, parseProfileUpdateMultipart, userController.updateProfile, cleanupPatientUploadOnError);
  router.post('/deleteAccount', authenticateToken, requireRegisteredUser, userController.deleteAccount);
  router.delete('/deleteAccount', authenticateToken, requireRegisteredUser, userController.deleteAccount);
  router.delete('/account', authenticateToken, requireRegisteredUser, userController.deleteAccount);

  return router;
};

