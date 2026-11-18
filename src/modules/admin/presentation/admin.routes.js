import { Router } from 'express';
import { authenticateToken } from '../../../shared/middlewares/auth.middleware.js';
import { requireAdmin, requireSuperAdmin, requirePermission, requireAnyPermission } from '../../../shared/middlewares/admin.middleware.js';
import { uploadClinicalReportFile } from '../../../shared/middlewares/clinical-report-upload.middleware.js';
import { validate } from '../../../shared/validators/validate.middleware.js';
import {
  adminReviewIdSchema,
  adminReviewStatusSchema,
  createAdminReviewSchema,
  updateAdminReviewSchema,
} from '../../../shared/validators/review.validator.js';
import {
  adminContentIdSchema,
  createAdminContentSchema,
  updateAdminContentSchema,
  updateAdminContentStatusSchema,
} from '../../../shared/validators/admin-content.validator.js';

export const clinicalReportUploadPermissions = ['documents.upload', 'reports.approve', 'hair-tests.upload'];
export const clinicalReportReadPermissions = ['documents.view', 'reports.approve'];

export const createAdminRouter = ({ adminController, notificationController, videoController, appointmentController, contentController, commerceController, supportController }) => {
  const router = Router();
  router.use(authenticateToken, requireAdmin);

  router.get('/me', adminController.getCurrentAdmin);
  router.get('/dashboard/summary', adminController.getDashboardSummary);
  router.get('/accounts', requireSuperAdmin, adminController.listAdminAccounts);
  router.post('/accounts', requireSuperAdmin, adminController.createAdminAccount);
  router.post('/accounts/invite', requireSuperAdmin, adminController.inviteAdmin);
  router.patch('/accounts/:id/access', requireSuperAdmin, adminController.updateAdminAccess);
  router.put('/accounts/:id/access', requireSuperAdmin, adminController.updateAdminAccess);
  router.patch('/accounts/:id/status', requireSuperAdmin, adminController.setAdminStatus);
  router.post('/accounts/:id/rotate-password', requireSuperAdmin, adminController.rotateAdminPassword);
  router.delete('/accounts/:id', requireSuperAdmin, adminController.deleteAdminAccount);

  // Feature Flags & Releases
  router.get('/features', adminController.listFeatureFlags);
  router.patch('/features/:key', requireSuperAdmin, adminController.updateFeatureFlag);
  router.get('/releases', requireSuperAdmin, adminController.listReleasePolicies);
  router.put('/releases/:platform', requireSuperAdmin, adminController.updateReleasePolicy);

  // Audit Logs & Redacted Exports
  router.get('/audit-logs', requireAnyPermission('audit.view'), adminController.listAuditLogs);
  router.get('/audit-logs/export', requireAnyPermission('audit.view', 'audit.export'), adminController.exportAuditLogs);

  // Operational Exports
  router.get('/exports/patients', requirePermission('patients.export'), adminController.exportPatients);
  router.get('/exports/appointments', requireAnyPermission('bookings.manage', 'appointments.export'), adminController.exportAppointments);

  // Clinic appointments and availability
  router.get('/appointments', requirePermission('bookings.manage'), appointmentController.listAdmin);
  router.post('/appointments', requirePermission('bookings.manage'), appointmentController.createAdmin);
  router.patch('/appointments/:appointmentId', requirePermission('bookings.manage'), appointmentController.updateAdmin);
  router.post('/appointments/:appointmentId/refund', requirePermission('bookings.manage'), appointmentController.refundAdmin);
  router.get('/appointments/schedule', requirePermission('bookings.manage'), appointmentController.getScheduleConfigAdmin);
  router.put('/appointments/schedule', requirePermission('bookings.manage'), appointmentController.updateScheduleConfigAdmin);
  router.get('/appointments/closed-dates', requirePermission('bookings.manage'), appointmentController.listClosedDates);
  router.post('/appointments/closed-dates', requirePermission('bookings.manage'), appointmentController.createClosedDate);
  router.delete('/appointments/closed-dates/:date', requirePermission('bookings.manage'), appointmentController.deleteClosedDate);
  router.get('/appointment-billing', requirePermission('bookings.manage'), appointmentController.getBillingConfigAdmin);
  router.put('/appointment-billing', requirePermission('bookings.manage'), appointmentController.updateBillingConfigAdmin);

  // Payments & Received Financials
  router.get('/payments', requireAnyPermission('bookings.manage', 'orders.manage', 'analytics.view'), adminController.listReceivedPayments);
  if (commerceController) {
    router.get('/commerce/sales-report', requireAnyPermission('orders.manage', 'analytics.view'), (req, res, next) => commerceController.getSalesReport(req, res, next));
  }

  // Patients and clinical directory
  router.get('/users/segments', requireAnyPermission('patients.view', 'patients.lookup'), adminController.getPatientSegments);
  router.get('/users', requireAnyPermission('patients.view', 'patients.lookup'), adminController.listUsers);
  router.get('/users/:userId', requireAnyPermission('patients.view', 'patients.lookup'), adminController.getPatient);
  router.get('/users/:userId/archive', requireSuperAdmin, adminController.getPatientArchive);
  router.patch('/users/:userId', requireSuperAdmin, adminController.updatePatient);
  router.patch('/users/:userId/status', requireSuperAdmin, adminController.setUserStatus);
  router.delete('/users/:userId', requireSuperAdmin, adminController.deleteUser);

  // Clinical reports
  router.get('/reports/mine', requireAnyPermission(...clinicalReportUploadPermissions), adminController.listMyReports);
  router.get('/reports', requireAnyPermission(...clinicalReportReadPermissions), adminController.listAllReports);
  router.post('/users/:userId/reports', requireAnyPermission(...clinicalReportUploadPermissions), uploadClinicalReportFile, adminController.uploadPatientReport);
  router.delete('/users/:userId/reports/:reportId', requireAnyPermission('documents.upload', 'reports.approve'), adminController.deletePatientReport);
  router.post('/users/:userId/reports/:reportId/restore', requireAnyPermission('documents.upload', 'reports.approve'), adminController.restorePatientReport);
  router.patch('/users/:userId/reports/:reportId/visibility', requireAnyPermission('documents.share', 'reports.share'), adminController.updatePatientReportVisibility);
  router.get('/users/:userId/reports/:reportId/download', requireAnyPermission(...clinicalReportReadPermissions), adminController.downloadPatientReport);

  // Clinical check-ins & Scalp photos
  router.patch('/users/:userId/progress-checkins/:checkInId', requireAnyPermission('progress.review', 'care-plans.edit'), adminController.reviewProgressCheckIn);
  router.delete('/users/:userId/assessments/:assessmentId/photos/:photoIndex', requireSuperAdmin, adminController.deletePatientScalpPhoto);

  // Hair tests & Assessments
  router.get('/hair-tests', requireAnyPermission('hair-tests.view', 'assessments.review'), adminController.listHairTests);
  router.get('/hair-tests/:referenceNo', requireAnyPermission('hair-tests.view', 'assessments.review'), adminController.getHairTest);
  router.patch('/hair-tests/:referenceNo/status', requireAnyPermission('assessments.review', 'hair-tests.upload'), adminController.updateHairTestStatus);

  // Care plans / treatments
  router.get('/treatments', requireAnyPermission('care-plans.edit', 'assessments.review'), adminController.listTreatments);
  router.post('/treatments', requireAnyPermission('care-plans.edit', 'assessments.review'), adminController.createTreatment);
  router.post('/users/:userId/diet-plan', requireAnyPermission('care-plans.edit', 'assessments.review'), adminController.updatePatientDietPlan);

  // Support inquiries
  if (supportController) {
    router.get('/support/inquiries', requireAnyPermission('content.edit', 'patients.view'), supportController.listInquiries);
    router.patch('/support/inquiries/:id', requireAnyPermission('content.edit', 'patients.view'), supportController.updateInquiry);
  }

  // Reviews
  router.get('/reviews', requireAnyPermission('content.edit', 'content.publish'), adminController.listReviews);
  router.post('/reviews', requirePermission('content.edit'), validate({ body: createAdminReviewSchema }), adminController.createAdminReview);
  router.put('/reviews/:id', requirePermission('content.edit'), validate({ params: adminReviewIdSchema, body: updateAdminReviewSchema }), adminController.updateAdminReview);
  router.delete('/reviews/:id', requirePermission('content.edit'), validate({ params: adminReviewIdSchema }), adminController.deleteAdminReview);
  router.patch('/reviews/status', requirePermission('content.publish'), validate({ body: adminReviewStatusSchema }), adminController.updateReviewStatus);
  router.post('/notifications/send-to-user', requireAnyPermission('notifications.manage'), notificationController.sendToUser);
  router.post('/notifications/broadcast', requireAnyPermission('notifications.manage'), notificationController.broadcast);
  router.get('/notifications/history', requireAnyPermission('notifications.manage'), notificationController.listCampaigns);
  router.get('/notifications/audience-count', requireAnyPermission('notifications.manage'), notificationController.previewAudience);
  router.post('/notifications/campaigns/:id/cancel', requireAnyPermission('notifications.manage'), notificationController.cancelCampaign);
  router.post('/media/videos/youtube', requireAnyPermission('content.edit', 'content.publish'), videoController.addYouTubeVideo);
  router.get('/media/videos', requireAnyPermission('content.edit', 'content.publish', 'media.upload'), videoController.listAdmin);
  router.put('/media/videos/:publicId', requireAnyPermission('content.edit', 'content.publish'), videoController.updateVideo);
  router.patch('/media/videos/:publicId', requireAnyPermission('content.edit', 'content.publish'), videoController.updateVideo);
  router.put('/media/videos', requireAnyPermission('content.edit', 'content.publish'), videoController.updateVideo);
  router.patch('/media/videos', requireAnyPermission('content.edit', 'content.publish'), videoController.updateVideo);
  router.patch('/media/videos/status', requireAnyPermission('content.edit', 'content.publish'), videoController.updateStatus);
  router.delete('/media/videos/:publicId', requireAnyPermission('content.edit', 'content.publish'), videoController.deleteVideo);
  router.delete('/media/videos', requireAnyPermission('content.edit', 'content.publish'), videoController.deleteVideo);

  if (contentController) {
    router.get('/content', requireAnyPermission('content.edit', 'content.publish'), contentController.listAdmin);
    router.post('/content', requirePermission('content.edit'), validate({ body: createAdminContentSchema }), contentController.createContent);
    router.patch('/content/:id/status', requirePermission('content.publish'), validate({ params: adminContentIdSchema, body: updateAdminContentStatusSchema }), contentController.updateStatus);
    router.put('/content/:id', requirePermission('content.edit'), validate({ params: adminContentIdSchema, body: updateAdminContentSchema }), contentController.updateContent);
    router.delete('/content/:id', requirePermission('content.edit'), validate({ params: adminContentIdSchema }), contentController.deleteContent);
  }

  if (commerceController) {
    router.get('/orders', requirePermission('orders.manage'), (req, res, next) => commerceController.listAdminOrders(req, res, next));
    router.get('/orders/:orderId', requirePermission('orders.manage'), (req, res, next) => commerceController.getAdminOrder(req, res, next));
    router.patch('/orders/:orderId/fulfillment', requirePermission('orders.manage'), (req, res, next) => commerceController.updateFulfillment(req, res, next));
    router.post('/orders/:orderId/shiprocket', requirePermission('orders.manage'), (req, res, next) => commerceController.createShiprocketShipment(req, res, next));
    router.post('/orders/:orderId/cancel', requirePermission('orders.manage'), (req, res, next) => commerceController.cancelAdminOrder(req, res, next));
    router.post('/orders/:orderId/refund', requirePermission('orders.manage'), (req, res, next) => commerceController.refundAdminOrder(req, res, next));
    router.post('/products/:productId/inventory', requirePermission('products.manage'), (req, res, next) => commerceController.restockProduct(req, res, next));
    router.get('/products/:productId/inventory', requirePermission('products.manage'), (req, res, next) => commerceController.getProductLedger(req, res, next));
  }

  return router;
};
