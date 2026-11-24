import { Router } from 'express';
import { authenticateToken } from '../../../shared/middlewares/auth.middleware.js';
import { requireRegisteredUser } from '../../../shared/middlewares/registered-user.middleware.js';
import { enforceUploadRequestSize, uploadScalpPhotosToR2 } from '../../../shared/middlewares/upload.middleware.js';
import {
  cleanupPatientUploadOnError,
  parseProgressCheckInMultipart,
  uploadProgressPhotos,
} from '../../../shared/middlewares/patient-media-upload.middleware.js';

export const createPatientClinicalRouter = ({ patientClinicalController, appointmentController, treatmentController }) => {
  const router = Router();
  router.use(authenticateToken, requireRegisteredUser);

  const scalpUploadFields = uploadScalpPhotosToR2.fields([
    { name: 'photo_front', maxCount: 1 },
    { name: 'photo_top', maxCount: 1 },
    { name: 'photo_left', maxCount: 1 },
    { name: 'photo_right', maxCount: 1 },
    { name: 'photo_back', maxCount: 1 },
  ]);
  const markAssessmentPhotoPurpose = (req, _res, next) => {
    req.headers['x-media-purpose'] = 'assessment';
    next();
  };

  router.get('/clinical-record', patientClinicalController.getClinicalRecord);
  router.get('/home-summary', patientClinicalController.getHomeSummary);
  router.get('/care-events', patientClinicalController.listCareEvents);
  router.put('/care-events', patientClinicalController.saveCareEvent);
  if (treatmentController?.getPatientDietPlan) {
    router.get('/diet-plan', treatmentController.getPatientDietPlan);
  }
  router.put('/diet-plan/suggestions', patientClinicalController.savePatientDietSuggestions);
  router.get('/routine-steps', patientClinicalController.getRoutineSteps);
  router.post('/routine-steps', patientClinicalController.addRoutineStep);
  router.delete('/routine-steps/:stepIndex', patientClinicalController.deleteRoutineStep);
  router.get('/reminders', patientClinicalController.getReminders);
  router.post('/reminders', patientClinicalController.saveReminder);
  router.put('/reminders/:reminderId', patientClinicalController.saveReminder);
  router.delete('/reminders/:reminderId', patientClinicalController.deleteReminder);
  router.get('/assessment/draft', patientClinicalController.getAssessmentDraft);
  router.put('/assessment/draft', patientClinicalController.saveAssessmentDraft);
  router.delete('/assessment/draft', patientClinicalController.deleteAssessmentDraft);
  router.post('/assessment/submit', enforceUploadRequestSize, markAssessmentPhotoPurpose, scalpUploadFields, patientClinicalController.submitAssessment, cleanupPatientUploadOnError);

  router.get('/progress-checkins', patientClinicalController.listProgressCheckIns);
  router.post('/progress-checkins', enforceUploadRequestSize, uploadProgressPhotos, parseProgressCheckInMultipart, patientClinicalController.createProgressCheckIn, cleanupPatientUploadOnError);
  router.delete('/progress-checkins/:checkInId', patientClinicalController.deleteProgressCheckIn);
  router.delete('/progress-checkins/:checkInId/photos/:angle', patientClinicalController.deleteProgressPhoto);
  router.get('/reports/:reportId/download', patientClinicalController.downloadReport);
  router.get('/appointments', appointmentController.listPatient);
  router.get('/appointments/billing-config', appointmentController.getBillingConfigPatient);
  router.post('/appointments', appointmentController.createPatient);
  router.post('/appointments/create-payment-intent', appointmentController.createPaymentIntent);
  router.post('/appointments/verify-and-book', appointmentController.verifyAndBook);
  router.patch('/appointments/:appointmentId', appointmentController.updatePatient);
  return router;
};
