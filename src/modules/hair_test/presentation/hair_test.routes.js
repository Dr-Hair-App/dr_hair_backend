import { Router } from 'express';
import { authenticateToken } from '../../../shared/middlewares/auth.middleware.js';
import { requireRegisteredUser } from '../../../shared/middlewares/registered-user.middleware.js';
import { enforceUploadRequestSize, uploadScalpPhotos, uploadScalpPhotosToR2 } from '../../../shared/middlewares/upload.middleware.js';
import { dailyUsageLimit } from '../../../shared/middlewares/daily-usage-limit.js';

export const createHairTestRouter = ({ hairTestController }) => {
  const router = Router();

  const scalpUploadFields = uploadScalpPhotosToR2.fields([
    { name: 'photo_front', maxCount: 1 },
    { name: 'photo_front_optimized', maxCount: 1 },
    { name: 'photo_top', maxCount: 1 },
    { name: 'photo_top_optimized', maxCount: 1 },
    { name: 'photo_left', maxCount: 1 },
    { name: 'photo_left_optimized', maxCount: 1 },
    { name: 'photo_right', maxCount: 1 },
    { name: 'photo_right_optimized', maxCount: 1 },
    { name: 'photo_back', maxCount: 1 },
    { name: 'photo_back_optimized', maxCount: 1 },
  ]);
  // This route stores patient assessment photos as private, ownership-scoped
  // assets. Do not trust a client supplied purpose header: the streaming R2
  // storage adapter uses this value to select both the object prefix and its
  // visibility metadata.
  const markAssessmentPhotoPurpose = (req, _res, next) => {
    req.headers['x-media-purpose'] = 'assessment';
    next();
  };
  // One inexpensive Durable Object counter protects the R2 and Gemini work
  // from repeated submissions while leaving ample room for legitimate retests.
  const assessmentSubmitDailyLimit = dailyUsageLimit({
    feature: 'hair_assessment_submit',
    defaultLimit: 10,
    subject: (req) => `patient:${req.user?.id}`,
  });

  // Legacy & Flutter App routes:
  // POST /HairTest/submit_form
  router.post('/submit_form', authenticateToken, requireRegisteredUser, enforceUploadRequestSize, assessmentSubmitDailyLimit, markAssessmentPhotoPurpose, scalpUploadFields, hairTestController.submitForm);

  // POST /HairTest/hair_test
  router.post('/hair_test', authenticateToken, requireRegisteredUser, hairTestController.getHairTests);

  // AI Assessment routes:
  // POST /HairTest/ai_assessment
  router.post('/ai_assessment', authenticateToken, requireRegisteredUser, hairTestController.generateAiAssessment);

  // POST /HairTest/:referenceNo/ai_assessment
  router.post('/:referenceNo/ai_assessment', authenticateToken, requireRegisteredUser, hairTestController.generateAiAssessment);
  router.get('/:referenceNo/ai_assessment/status', authenticateToken, requireRegisteredUser, hairTestController.getAiAssessmentStatus);
  router.post('/:referenceNo/ai_assessment/retry', authenticateToken, requireRegisteredUser, hairTestController.retryAiAssessment);
  router.post('/:referenceNo/diet_plan', authenticateToken, requireRegisteredUser, hairTestController.generateDietPlan);
  router.post('/:referenceNo/routine', authenticateToken, requireRegisteredUser, hairTestController.generateDailyRoutine);

  // AI Visual Scalp & Hair Image Detection
  // POST /HairTest/detect_scalp_image
  router.post(
    '/detect_scalp_image',
    authenticateToken,
    requireRegisteredUser,
    uploadScalpPhotos.single('image'),
    hairTestController.detectScalpImage,
  );

  return router;
};

