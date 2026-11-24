import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '../../../shared/errors/index.js';
import { sendSuccess } from '../../../shared/utils/response.js';
import { config } from '../../../config/env.js';
import { uploadClinicalReport, createClinicalReportDownloadUrl, deleteClinicalReport } from '../infrastructure/ClinicalReportStorage.js';
import { clinicalReportFormat } from '../infrastructure/R2ClinicalReportUploadStorage.js';
import { MalwareScanner, normalizeScanStatus } from '../infrastructure/MalwareScanner.js';
import { progressCheckInResponse } from '../../../shared/utils/progress-checkin-response.js';
import { normalizePatientDietSuggestions } from '../../treatment/domain/patient-diet-suggestion.js';
import { getEffectivePermissions, hasPermission } from '../../../shared/utils/admin-permissions.js';
import { hashPassword } from '../../../shared/utils/password-hasher.js';
import { sendPushNotification } from '../../notifications/infrastructure/FirebaseAdminMessaging.js';
import { OrderModel, AppointmentModel } from '../../../shared/database/models.js';
import { isDatabaseConnected } from '../../../shared/database/database.js';
import { store } from '../../../shared/database/store.js';

const reportResponse = (report) => ({
  id: report.id,
  userId: report.userId,
  title: report.title,
  file_name: report.file_name,
  mime_type: report.mime_type,
  format: report.format,
  bytes: report.bytes,
  stored_bytes: report.stored_bytes || report.bytes,
  compressed: report.compressed === true,
  sha256: report.sha256 || null,
  scanning_status: report.scanning_status || 'not_scanned',
  uploaded_by: report.uploaded_by,
  visibility: report.visibility === 'Shared' ? 'Shared' : 'Private',
  shared_at: report.shared_at || null,
  visibility_history: (report.visibility_history || []).map((event) => ({
    action: event.action || (event.visibility === 'Shared' ? 'shared' : 'hidden'),
    visibility: event.visibility === 'Shared' ? 'Shared' : 'Private',
    changed_by: event.changed_by || '',
    changed_at: event.changed_at || null,
    patient_consent_confirmed: event.patient_consent_confirmed === true,
  })),
  deleted_at: report.deleted_at || null,
  purge_after: report.purge_after || null,
  deleted_by: report.deleted_by || '',
  created_at: report.created_at,
});

const reportScanBlockedMessage = (status) => {
  if (status === 'not_scanned') {
    return 'This report is still private because malware scanning is not configured. Upload a new copy to share it after security scanning is enabled. A report must pass a clean malware scan before it can be shared with a patient.';
  }
  if (status === 'pending') {
    return 'The report cannot be shared while its security scan is still pending. Wait for the scan to finish. A report must pass a clean malware scan before it can be shared with a patient.';
  }
  if (status === 'infected') {
    return 'This report failed the security scan and was marked infected. A report must pass a clean malware scan before it can be shared with the patient.';
  }
  if (status === 'error') {
    return 'The security scan encountered an error. A report must pass a clean malware scan before it can be shared with a patient.';
  }
  return 'A report must pass a clean malware scan before it can be shared with a patient.';
};

export class AdminController {
  constructor({
    userRepository,
    hairTestRepository,
    treatmentRepository,
    clinicalReportRepository,
    reviewRepository,
    adminAccountRepository,
    createAdminAccountUseCase,
    imageStorage,
    appointmentRepository,
    patientActivityRepository,
    progressCheckInRepository,
    auditEventRepository,
    adminApiTrafficRepository,
    featureFlagRepository,
    appReleasePolicyRepository,
    productRepository,
    orderRepository,
    sessionRepository,
    notificationRepository,
    deviceTokenRepository,
    malwareScanner,
  }) {
    this.userRepository = userRepository;
    this.hairTestRepository = hairTestRepository;
    this.treatmentRepository = treatmentRepository;
    this.clinicalReportRepository = clinicalReportRepository;
    this.reviewRepository = reviewRepository;
    this.adminAccountRepository = adminAccountRepository;
    this.createAdminAccountUseCase = createAdminAccountUseCase;
    this.imageStorage = imageStorage;
    this.appointmentRepository = appointmentRepository;
    this.patientActivityRepository = patientActivityRepository;
    this.progressCheckInRepository = progressCheckInRepository;
    this.auditEventRepository = auditEventRepository;
    this.adminApiTrafficRepository = adminApiTrafficRepository;
    this.featureFlagRepository = featureFlagRepository;
    this.appReleasePolicyRepository = appReleasePolicyRepository;
    this.productRepository = productRepository;
    this.orderRepository = orderRepository;
    this.sessionRepository = sessionRepository;
    this.notificationRepository = notificationRepository;
    this.deviceTokenRepository = deviceTokenRepository;
    this.malwareScanner = malwareScanner || new MalwareScanner();
  }

  getCurrentAdmin = async (req, res, next) => {
    try {
      const isSuper = req.user?.role === 'super_admin';
      const account = isSuper
        ? { role: 'super_admin', roleTemplate: 'super-admin' }
        : await this.adminAccountRepository.findByLogin(req.user?.email || req.user?.login);

      const effectivePermissions = getEffectivePermissions(account || req.user);
      return sendSuccess(res, {
        data: {
          id: req.user?.id ? String(req.user.id) : null,
          email: req.user?.login || req.user?.email || null,
          name: req.user?.name || null,
          role: req.user?.role || 'admin',
          roleTemplate: account?.roleTemplate || (isSuper ? 'super-admin' : 'clinical-admin'),
          permissions: effectivePermissions,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  listAuditEvents = async (req, res, next) => {
    try {
      if (!this.auditEventRepository) {
        return sendSuccess(res, { data: { items: [] }, meta: { total: 0 } });
      }
      const { page, limit, action, actorId, target } = req.query;
      const result = await this.auditEventRepository.list({ page, limit, action, actorId, target });
      return sendSuccess(res, { data: { items: result.items }, meta: result.meta });
    } catch (error) {
      next(error);
    }
  };

  listAdminApiTraffic = async (req, res, next) => {
    try {
      if (!this.adminApiTrafficRepository) {
        throw new ServiceUnavailableError('API traffic history is temporarily unavailable.');
      }
      const { page, limit, window, statusClass, surface, scope } = req.query;
      const result = await this.adminApiTrafficRepository.list({ page, limit, window, statusClass, surface, scope });
      return sendSuccess(res, { data: { items: result.items }, meta: result.meta });
    } catch (error) {
      next(error);
    }
  };

  listAdminAccounts = async (_req, res, next) => {
    try {
      const accounts = await this.adminAccountRepository.list();
      return sendSuccess(res, { data: { items: accounts } });
    } catch (error) {
      next(error);
    }
  };

  createAdminAccount = async (req, res, next) => {
    try {
      const result = await this.createAdminAccountUseCase.execute(req.body || {});
      return sendSuccess(res, {
        message: result.isCustomPassword
          ? 'Admin account created successfully with the provided credentials.'
          : 'Admin account created. Copy its generated password now; it will not be shown again.',
        data: {
          admin: result.account,
          credentials: {
            login_id: result.account.email,
            password: result.generatedPassword,
          },
        },
        statusCode: 201,
      });
    } catch (error) {
      next(error);
    }
  };

  listUsers = async (req, res, next) => {
    try {
      const result = await this.userRepository.list({
        page: req.query.page,
        limit: req.query.limit,
        search: req.query.search,
        segment: req.query.segment,
      });
      return sendSuccess(res, {
        data: {
          ...result,
          items: result.items.map((user) => ({
            ...user.toPublicProfile(),
            role: user.role,
            created_at: user.created_at,
            has_completed_assessment: Boolean(user.has_completed_assessment),
          })),
          segment: result.segment,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  getPatientSegments = async (req, res, next) => {
    try {
      const data = await this.userRepository.getSegmentSummary();
      return sendSuccess(res, { data });
    } catch (error) {
      next(error);
    }
  };

  searchUsers = async (req, res, next) => {
    try {
      const search = String(req.query.q || req.query.query || req.query.search || '').trim();
      const result = await this.userRepository.list({
        page: req.query.page,
        limit: req.query.limit,
        search,
        segment: req.query.segment,
      });
      return sendSuccess(res, {
        data: {
          ...result,
          items: result.items.map((user) => ({
            ...user.toPublicProfile(),
            role: user.role,
            created_at: user.created_at,
            has_completed_assessment: Boolean(user.has_completed_assessment),
          })),
          segment: result.segment,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  lookupPatient = async (req, res, next) => {
    try {
      const patient = await this.userRepository.findById(req.params.userId);
      if (!patient || patient.role !== 'user') throw new NotFoundError('Patient not found.');
      return sendSuccess(res, {
        data: {
          patient: {
            id: patient.id,
            patient_code: patient.patient_code,
            name: patient.name,
            phone: patient.phone,
            email: patient.email,
            age: patient.age,
            gender: patient.gender,
            city: patient.city,
            occupation: patient.occupation,
            created_at: patient.created_at,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  };

  getPatient = async (req, res, next) => {
    try {
      if (!req.user || (req.user.role !== 'super_admin' && !hasPermission(req.user, 'patients.view'))) {
        throw new ForbiddenError("Permission 'patients.view' is required for full clinical detail.");
      }
      const patient = await this.userRepository.findById(req.params.userId);
      if (!patient || patient.role !== 'user') throw new NotFoundError('Patient not found.');
      const assessments = await this.hairTestRepository.findByUserId(patient.id, { includeArchived: true });
      const treatmentsByAssessment = await Promise.all(assessments.map((assessment) =>
        this.treatmentRepository.findByTestIdentifier(assessment.reference_no, { userId: patient.id }),
      ));
      const [reports, archivedReports, appointments, activity, progressCheckIns] = await Promise.all([
        this.clinicalReportRepository.listByUserId(patient.id),
        this.clinicalReportRepository.listArchivedByUserId(patient.id),
        this.appointmentRepository.listByPatient(patient.id),
        this.patientActivityRepository.listByPatient(patient.id),
        this.progressCheckInRepository.listByUserId(patient.id),
      ]);
      const safeAssessments = await Promise.all(assessments.map(async (assessment) => ({
        ...assessment,
        scalp_photos: await Promise.all((assessment.scalp_photos || []).filter((photo) => !photo.deleted_at).map(async (photo) => ({
          ...photo,
          url: photo.delivery_type === 'authenticated'
            ? this.imageStorage.createPrivateDownloadUrl(photo.file_name, photo.format)
            : photo.url,
          url_expires_in_seconds: photo.delivery_type === 'authenticated' ? 300 : null,
        }))),
      })));
      return sendSuccess(res, {
        data: {
          patient: { ...patient.toPublicProfile(), created_at: patient.created_at, updated_at: patient.updated_at },
          assessments: safeAssessments,
          treatments: treatmentsByAssessment.flat().map((treatment) => ({ ...treatment.toResponse(), reference_no: treatment.reference_no })),
          reports: reports.map(reportResponse),
          archived_reports: archivedReports.map(reportResponse),
          appointments,
          activity,
          progress_checkins: await Promise.all(progressCheckIns.map((item) => progressCheckInResponse(item, this.imageStorage))),
        },
      });
    } catch (error) {
      next(error);
    }
  };

  getPatientArchive = async (req, res, next) => {
    try {
      const patient = await this.userRepository.findById(req.params.userId);
      if (!patient || patient.role !== 'user') throw new NotFoundError('Patient not found.');
      const reports = await this.clinicalReportRepository.listArchivedByUserId(patient.id);
      return sendSuccess(res, { data: { reports: reports.map(reportResponse) } });
    } catch (error) { next(error); }
  };

  updatePatient = async (req, res, next) => {
    try {
      const patientId = req.params.userId;
      const current = await this.userRepository.findById(patientId);
      if (!current || current.role !== 'user') throw new NotFoundError('Patient not found.');

      const isSuperAdmin = req.user?.role === 'super_admin';
      const hasEditPerm = isSuperAdmin || hasPermission(req.user, 'patients.edit');
      const hasClinicalPerm = isSuperAdmin || hasPermission(req.user, 'care-plans.edit') || hasPermission(req.user, 'patients.view');
      const body = req.body || {};

      // Reject unauthorized contact edits & client override bypass attempts
      if (body.phone !== undefined || body.email !== undefined) {
        if (!hasEditPerm) {
          throw new ForbiddenError("Permission 'patients.edit' is required to update patient contact details. Client override flags are not permitted.");
        }
      }
      if (body.admin_override && !isSuperAdmin) {
        throw new ForbiddenError("Permission 'patients.edit' is required for admin overrides.");
      }
      if (!hasClinicalPerm && body.medical_conditions !== undefined) {
        throw new ForbiddenError("Permission 'care-plans.edit' is required to update medical conditions.");
      }

      const baseFields = ['name', 'age', 'gender', 'city', 'occupation'];
      const allowedFields = [
        ...baseFields,
        ...(hasClinicalPerm ? ['medical_conditions'] : []),
        ...(hasEditPerm ? ['phone', 'email'] : []),
      ];
      const metaKeys = ['allow_contact_updates', 'confirm_contact_change', 'admin_override'];

      const unknownFields = Object.keys(body).filter((field) => !allowedFields.includes(field) && !metaKeys.includes(field));
      if (unknownFields.length) {
        if (!hasEditPerm && (body.phone !== undefined || body.email !== undefined)) {
          throw new ForbiddenError("Permission 'patients.edit' is required to update patient contact details.");
        }
        throw new BadRequestError(`Unsupported patient fields: ${unknownFields.join(', ')}.`);
      }
      const dataKeys = Object.keys(body).filter((k) => !metaKeys.includes(k));
      if (!dataKeys.length) throw new BadRequestError('Provide at least one profile field to update.');
      const update = {};
      for (const field of allowedFields) {
        if (!(field in body)) continue;
        const value = body[field];
        if (field === 'age') {
          if (value !== null && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 120)) {
            throw new BadRequestError('age must be a whole number between 1 and 120, or null.');
          }
          update.age = value !== null ? Number(value) : null;
          continue;
        }
        if (field === 'medical_conditions') {
          if (Array.isArray(value)) {
            update.medical_conditions = value.map((c) => String(c).trim()).filter(Boolean);
          } else if (typeof value === 'string') {
            update.medical_conditions = value.split(',').map((c) => c.trim()).filter(Boolean);
          } else if (value === null) {
            update.medical_conditions = [];
          } else {
            throw new BadRequestError('medical_conditions must be an array of strings or comma-separated text.');
          }
          continue;
        }
        if (field === 'phone') {
          if (value !== null && typeof value === 'string') {
            const digits = value.replace(/\D/g, '');
            if (digits.length < 10 || digits.length > 15) {
              throw new BadRequestError('Phone number must contain between 10 and 15 digits.');
            }
            if (this.userRepository.findByPhone) {
              const existingPhoneUser = await this.userRepository.findByPhone(digits);
              if (existingPhoneUser && Number(existingPhoneUser.id) !== Number(current.id)) {
                throw new ConflictError('This phone number is already registered to another patient.');
              }
            }
            update.phone = value.trim();
          } else if (value === null) {
            update.phone = null;
          } else {
            throw new BadRequestError('phone must be a string or null.');
          }
          continue;
        }
        if (field === 'email') {
          if (value !== null && typeof value === 'string') {
            const trimmed = value.trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
              throw new BadRequestError('email must be a valid email address.');
            }
            if (this.userRepository.findByEmail) {
              const existingEmailUser = await this.userRepository.findByEmail(trimmed);
              if (existingEmailUser && Number(existingEmailUser.id) !== Number(current.id)) {
                throw new ConflictError('This email is already registered to another patient.');
              }
            }
            update.email = trimmed;
          } else if (value === null) {
            update.email = null;
          } else {
            throw new BadRequestError('email must be a valid email string or null.');
          }
          continue;
        }
        if (value !== null && (typeof value !== 'string' || value.trim().length > 120)) {
          throw new BadRequestError(`${field} must be a text value of at most 120 characters, or null.`);
        }
        const normalized = typeof value === 'string' ? value.trim() : null;
        if (field === 'name' && !normalized) throw new BadRequestError('name cannot be empty.');
        update[field] = normalized || (field === 'name' ? '' : null);
      }
      const updated = await this.userRepository.update(patientId, update);
      await this.patientActivityRepository?.record({
        userId: current.id,
        patientCode: current.patient_code,
        type: 'profile',
        title: 'Patient profile updated',
        summary: Object.keys(update).join(', '),
        actor: String(req.user?.email || req.user?.login || 'Admin'),
      });
      return sendSuccess(res, {
        message: 'Patient profile updated.',
        data: { ...updated.toPublicProfile(), updated_at: updated.updated_at },
      });
    } catch (error) {
      next(error);
    }
  };

  setUserStatus = async (req, res, next) => {
    try {
      const patientId = req.params.userId;
      const current = await this.userRepository.findById(patientId);
      if (!current || current.role !== 'user') throw new NotFoundError('Patient not found.');

      const { is_blocked, status, reason } = req.body || {};
      const shouldBlock = is_blocked !== undefined ? Boolean(is_blocked) : status === 'blocked';
      const newStatus = status || (shouldBlock ? 'blocked' : 'active');

      const updated = await this.userRepository.setStatus(patientId, {
        is_blocked: shouldBlock,
        status: newStatus,
        blocked_reason: reason || (shouldBlock ? 'Administrative suspension' : null),
      });

      if (shouldBlock && this.sessionRepository?.revokeAllForUser) {
        await this.sessionRepository.revokeAllForUser(current.id, 'ACCOUNT_BLOCKED');
      }

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor: String(req.user?.name || req.user?.email || 'Super Admin'),
          action: shouldBlock ? 'user.blocked' : 'user.unblocked',
          target: current.patient_code || `patient_${current.id}`,
          targetType: 'User',
          details: {
            patientId: current.id,
            name: current.name,
            phone: current.phone,
            is_blocked: shouldBlock,
            status: newStatus,
            reason: reason || null,
          },
        });
      }

      return sendSuccess(res, {
        message: shouldBlock ? 'Patient account has been blocked.' : 'Patient account has been unblocked.',
        data: updated ? updated.toPublicProfile() : null,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteUser = async (req, res, next) => {
    try {
      const patientId = req.params.userId;
      const current = await this.userRepository.findById(patientId);
      if (!current || current.role !== 'user') throw new NotFoundError('Patient not found.');

      const deleted = await this.userRepository.deleteAccount(patientId);
      if (!deleted) throw new NotFoundError('Patient account could not be found or was already deleted.');

      if (this.sessionRepository?.revokeAllForUser) {
        await this.sessionRepository.revokeAllForUser(current.id, 'ACCOUNT_DELETED');
      }

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor: String(req.user?.name || req.user?.email || 'Super Admin'),
          action: 'user.deleted',
          target: current.patient_code || `patient_${current.id}`,
          targetType: 'User',
          details: {
            patientId: current.id,
            name: current.name,
            phone: current.phone,
          },
        });
      }

      return sendSuccess(res, {
        message: 'Patient account has been permanently deleted.',
        data: { id: current.id, patient_code: current.patient_code },
      });
    } catch (error) {
      next(error);
    }
  };

  notifyPatientReportShared = async (patient, report) => {
    if (!this.notificationRepository) return { inboxCreated: false, pushSent: 0, pushFailed: 0, pushStatus: 'unavailable' };
    let notification;
    try {
      const reportTitle = typeof report.title === 'string' && report.title.trim() ? report.title.trim() : 'Clinical report';
      notification = await this.notificationRepository.create({
        userId: Number(patient.id),
        title: 'New Clinical Report Available',
        body: `Your clinic shared "${reportTitle}" in your care records. Tap to view.`,
        type: 'report',
        destination: { type: 'report', entityId: report.id },
        data: { destination_type: 'report', report_id: report.id },
      });
      if (!this.deviceTokenRepository) return { inboxCreated: true, pushSent: 0, pushFailed: 0, pushStatus: 'unavailable' };
      const tokenRows = await this.deviceTokenRepository.listByUserId(patient.id);
      const tokens = [...new Set((tokenRows || []).map((row) => row?.token).filter((token) => typeof token === 'string' && token.length > 0))];
      if (!tokens.length) return { inboxCreated: true, pushSent: 0, pushFailed: 0, pushStatus: 'no_devices' };
      const results = await Promise.allSettled(tokens.map((token) => sendPushNotification({
        token,
        title: notification.title,
        body: notification.body,
        data: {
          notification_id: notification.id,
          destination_type: 'report',
          report_id: report.id,
        },
      })));
      const pushSent = results.filter((result) => result.status === 'fulfilled').length;
      const pushFailed = results.length - pushSent;
      return { inboxCreated: true, pushSent, pushFailed, pushStatus: pushSent > 0 ? 'sent' : 'failed' };
    } catch {
      // Report access and any persisted inbox record stay authoritative if FCM is unavailable.
      return { inboxCreated: Boolean(notification), pushSent: 0, pushFailed: 0, pushStatus: notification ? 'unavailable' : 'not_created' };
    }
  };

  notifyPatientRoutineAdded = async (patientId, { updated = false } = {}) => {
    if (!this.notificationRepository) return { inboxCreated: false, pushSent: 0, pushFailed: 0, pushStatus: 'unavailable' };
    let notification;
    try {
      notification = await this.notificationRepository.create({
        userId: Number(patientId),
        title: updated ? 'Your daily routine was updated' : 'Your daily routine is ready',
        body: updated
          ? 'Your clinic updated care steps in your daily routine. Open the tracker to review the latest steps.'
          : 'Your clinic added care steps to your daily routine. Open the tracker to review and mark them complete.',
        type: 'reminder',
        destination: { type: 'screen', screen: 'routine' },
        data: { destination_type: 'screen', screen: 'routine' },
      });
      if (!this.deviceTokenRepository) return { inboxCreated: true, pushSent: 0, pushFailed: 0, pushStatus: 'unavailable' };
      const tokenRows = await this.deviceTokenRepository.listByUserId(patientId);
      const tokens = [...new Set((tokenRows || []).map((row) => row?.token).filter((token) => typeof token === 'string' && token.length > 0))];
      if (!tokens.length) return { inboxCreated: true, pushSent: 0, pushFailed: 0, pushStatus: 'no_devices' };
      const results = await Promise.allSettled(tokens.map((token) => sendPushNotification({
        token,
        title: notification.title,
        body: notification.body,
        data: {
          notification_id: notification.id,
          type: 'reminder',
          destination_type: 'screen',
          screen: 'routine',
        },
      })));
      const pushSent = results.filter((result) => result.status === 'fulfilled').length;
      const pushFailed = results.length - pushSent;
      return { inboxCreated: true, pushSent, pushFailed, pushStatus: pushSent > 0 ? 'sent' : 'failed' };
    } catch {
      // Persisted care plans and any inbox notification stay authoritative if FCM is unavailable.
      return { inboxCreated: Boolean(notification), pushSent: 0, pushFailed: 0, pushStatus: notification ? 'unavailable' : 'not_created' };
    }
  };

  uploadPatientReport = async (req, res, next) => {
    let uploadedAsset = req.file?.key ? { public_id: req.file.key } : null;
    let reportPersisted = false;
    try {
      const patient = await this.userRepository.findById(req.params.userId);
      if (!patient || patient.role !== 'user') throw new NotFoundError('Patient not found.');
      if (!req.file) throw new BadRequestError('Choose a report file to upload.');
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      if (!title || title.length > 160) throw new BadRequestError('Report title is required and must be at most 160 characters.');
      const visibility = req.body?.visibility === undefined ? 'Private' : req.body.visibility;
      if (!['Private', 'Shared'].includes(visibility)) throw new BadRequestError('visibility must be either Private or Shared.');
      const patientConsentConfirmed = req.body?.patient_consent_confirmed === 'true';
      if (visibility === 'Shared' && !patientConsentConfirmed) {
        throw new BadRequestError('Confirm patient consent before uploading a report directly to the patient app.');
      }
      if (visibility === 'Shared' && !hasPermission(req.user, 'documents.share') && !hasPermission(req.user, 'reports.share')) {
        throw new ForbiddenError('Permission documents.share or reports.share is required to share a patient report.');
      }
      uploadedAsset = await uploadClinicalReport(req.file, patient.id, {
        compress: req.body?.compress_losslessly !== 'false',
      });
      const scanResult = await this.malwareScanner.scanClinicalReport({
        key: uploadedAsset.public_id,
        mimeType: req.file.mimetype,
        size: req.file.size,
        patientId: patient.id,
      });
      const scanningStatus = normalizeScanStatus(scanResult);
      if (scanningStatus === 'infected' || scanningStatus === 'error') {
        throw new BadRequestError('The report could not be accepted because its security scan did not pass.');
      }
      if (visibility === 'Shared' && scanningStatus !== 'clean') {
        throw new BadRequestError(reportScanBlockedMessage(scanningStatus));
      }
      const uploadedBy = String(req.user?.email || req.user?.login || 'Super Admin');
      const sharedAt = visibility === 'Shared' ? new Date() : null;
      const report = await this.clinicalReportRepository.create({
        id: uploadedAsset.id,
        userId: patient.id,
        title,
        file_name: String(req.file.originalname || 'report').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 180),
        mime_type: req.file.mimetype,
        format: clinicalReportFormat(req.file.mimetype),
        bytes: req.file.size,
        stored_bytes: uploadedAsset.stored_bytes,
        compressed: uploadedAsset.compressed,
        sha256: uploadedAsset.sha256 || req.file.sha256,
        scanning_status: scanningStatus,
        public_id: uploadedAsset.public_id,
        uploaded_by: uploadedBy,
        visibility,
        shared_at: sharedAt,
        visibility_history: [
          { action: 'uploaded', visibility: 'Private', changed_by: uploadedBy, changed_at: new Date() },
          ...(visibility === 'Shared' ? [{ action: 'shared', visibility: 'Shared', changed_by: uploadedBy, changed_at: sharedAt, patient_consent_confirmed: true }] : []),
        ],
      });
      reportPersisted = true;
      await this.patientActivityRepository?.record({
        userId: patient.id,
        patientCode: patient.patient_code,
        type: 'report',
        title: visibility === 'Shared' ? 'Report uploaded and shared' : 'Report uploaded',
        summary: title,
        actor: uploadedBy,
        metadata: { report_id: report.id, visibility, patient_consent_confirmed: visibility === 'Shared' },
      }).catch(() => null);
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor: uploadedBy,
          action: 'report.uploaded',
          target: `patient:${patient.id}`,
          metadata: { report_id: report.id, title, visibility, patient_consent_confirmed: visibility === 'Shared' },
        }).catch(() => null);
      }
      const notificationDelivery = visibility === 'Shared'
        ? await this.notifyPatientReportShared(patient, report)
        : null;
      return sendSuccess(res, {
        message: visibility === 'Shared' ? 'Patient report uploaded and shared.' : 'Private patient report uploaded.',
        data: { ...reportResponse(report), ...(notificationDelivery ? { notification_delivery: notificationDelivery } : {}) },
        statusCode: 201,
      });
    } catch (error) {
      if (uploadedAsset?.public_id && !reportPersisted) {
        try { await deleteClinicalReport(uploadedAsset.public_id); } catch { /* best-effort cleanup after metadata failure */ }
      }
      next(error);
    }
  };

  updatePatientReportVisibility = async (req, res, next) => {
    try {
      const patient = await this.userRepository.findById(req.params.userId);
      if (!patient || patient.role !== 'user') throw new NotFoundError('Patient not found.');
      const visibility = req.body?.visibility;
      if (!['Private', 'Shared'].includes(visibility)) throw new BadRequestError('visibility must be either Private or Shared.');
      if (visibility === 'Shared' && req.body?.patient_consent_confirmed !== true) throw new BadRequestError('Confirm that the patient agreed to view this report before sharing it.');
      if (visibility === 'Shared') {
        const reportToShare = await this.clinicalReportRepository.findByUserIdAndId(patient.id, req.params.reportId);
        if (!reportToShare) throw new NotFoundError('Patient report not found.');
        if (normalizeScanStatus({ status: reportToShare.scanning_status }) !== 'clean') {
          throw new BadRequestError(reportScanBlockedMessage(reportToShare.scanning_status));
        }
      }
      const changedBy = String(req.user?.email || req.user?.login || 'Super Admin');
      const result = await this.clinicalReportRepository.updateVisibilityWithResult
        ? await this.clinicalReportRepository.updateVisibilityWithResult(patient.id, req.params.reportId, visibility, changedBy, visibility === 'Shared')
        : { report: await this.clinicalReportRepository.updateVisibility(patient.id, req.params.reportId, visibility, changedBy, visibility === 'Shared'), changed: true };
      const report = result.report;
      if (!report) throw new NotFoundError('Patient report not found.');
      if (visibility === 'Shared' && normalizeScanStatus({ status: report.scanning_status }) !== 'clean') {
        throw new BadRequestError(reportScanBlockedMessage(report.scanning_status));
      }
      if (!result.changed) return sendSuccess(res, { message: 'Report visibility is already up to date.', data: reportResponse(report) });
      await this.patientActivityRepository?.record({ userId: patient.id, patientCode: patient.patient_code, type: 'report', title: visibility === 'Shared' ? 'Report shared with patient' : 'Report hidden from patient', summary: report.title, actor: changedBy, metadata: { report_id: report.id, patient_consent_confirmed: visibility === 'Shared' } }).catch(() => null);
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor: changedBy,
          action: visibility === 'Shared' ? 'report.shared' : 'report.hidden',
          target: `patient:${patient.id}`,
          metadata: { report_id: report.id, visibility, patient_consent_confirmed: visibility === 'Shared' },
        }).catch(() => null);
      }

      const notificationDelivery = visibility === 'Shared'
        ? await this.notifyPatientReportShared(patient, report)
        : null;

      return sendSuccess(res, {
        message: visibility === 'Shared' ? 'Report is now visible to the patient.' : 'Report is now hidden from the patient.',
        data: { ...reportResponse(report), ...(notificationDelivery ? { notification_delivery: notificationDelivery } : {}) },
      });
    } catch (error) {
      next(error);
    }
  };

  listMyReports = async (req, res, next) => {
    try {
      const identity = String(req.user?.email || req.user?.login || '').trim();
      const reports = identity ? await this.clinicalReportRepository.listByUploadedBy(identity) : [];
      return sendSuccess(res, { data: { reports: reports.map(reportResponse) } });
    } catch (error) {
      next(error);
    }
  };

  listAllReports = async (req, res, next) => {
    try {
      const reports = await this.clinicalReportRepository.listAll();
      return sendSuccess(res, { data: { reports: reports.map(reportResponse) } });
    } catch (error) {
      next(error);
    }
  };

  deletePatientReport = async (req, res, next) => {
    try {
      const patient = await this.userRepository.findById(req.params.userId);
      if (!patient || patient.role !== 'user') throw new NotFoundError('Patient not found.');
      const report = await this.clinicalReportRepository.findByUserIdAndId(patient.id, req.params.reportId);
      if (!report) throw new NotFoundError('Patient report not found.');

      const actor = String(req.user?.email || req.user?.login || 'Super Admin');
      const archived = await this.clinicalReportRepository.archiveByUserIdAndId(patient.id, report.id, actor);
      if (!archived) throw new NotFoundError('Patient report was already archived. Refresh the patient record.');
      await this.patientActivityRepository.record({ userId: patient.id, patientCode: patient.patient_code, type: 'report', title: 'Report archived for 30 days', summary: report.title, actor, metadata: { report_id: report.id, purge_after: archived.purge_after } });
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'report.archived',
          target: `patient:${patient.id}`,
          metadata: { report_id: report.id, title: report.title, purge_after: archived.purge_after },
        }).catch(() => null);
      }

      return sendSuccess(res, {
        message: 'Report moved to the recovery archive for 30 days.',
        data: reportResponse(archived),
      });
    } catch (error) {
      next(error);
    }
  };

  deletePatientScalpPhoto = async (req, res, next) => {
    try {
      const patient = await this.userRepository.findById(req.params.userId);
      if (!patient || patient.role !== 'user') throw new NotFoundError('Patient not found.');
      const assessmentId = Number(req.params.assessmentId);
      const photoIndex = Number(req.params.photoIndex);
      if (!Number.isSafeInteger(assessmentId) || assessmentId < 1 || !Number.isInteger(photoIndex) || photoIndex < 0) {
        throw new BadRequestError('A valid assessment and photo index are required.');
      }
      const assessment = await this.hairTestRepository.findByIdAndUserId(assessmentId, patient.id);
      const photo = assessment?.scalp_photos?.[photoIndex];
      if (!photo || typeof photo.url !== 'string' || typeof photo.file_name !== 'string') throw new NotFoundError('Scalp photo not found.');

      const allowedFolders = [
        `user-${patient.id}/assessment/`,
        'scalp/',
      ];
      if (!allowedFolders.some((folder) => photo.file_name.startsWith(folder)) || photo.file_name.includes('..')) {
        throw new BadRequestError('This scalp photo is not stored in an approved patient-upload folder.');
      }

      const removed = await this.hairTestRepository.removeScalpPhoto(patient.id, assessmentId, photoIndex, photo.url);
      if (!removed) throw new NotFoundError('Scalp photo was already removed. Refresh the patient record.');
      try {
        await this.imageStorage.deleteImage(photo.file_name, { deliveryType: photo.delivery_type || 'upload' });
      } catch {
        await this.hairTestRepository.restoreScalpPhoto(patient.id, assessmentId, photoIndex, removed);
        throw new AppError('The photo could not be deleted from storage. The assessment reference was restored; retry later.', 503);
      }
      const actor = String(req.user?.email || req.user?.login || 'Super Admin');
      await this.patientActivityRepository.record({ userId: patient.id, patientCode: patient.patient_code, type: 'assessment', title: 'Scalp photo permanently deleted', summary: assessment.reference_no || `Assessment ${assessmentId}`, actor, metadata: { assessment_id: assessmentId, file_name: photo.file_name } });
      return sendSuccess(res, {
        message: 'Scalp photo and database reference permanently deleted.',
        data: { assessment_id: assessmentId, file_name: photo.file_name },
      });
    } catch (error) {
      next(error);
    }
  };

  restorePatientReport = async (req, res, next) => {
    try {
      const patient = await this.userRepository.findById(req.params.userId);
      if (!patient || patient.role !== 'user') throw new NotFoundError('Patient not found.');
      const report = await this.clinicalReportRepository.restoreByUserIdAndId(patient.id, req.params.reportId);
      if (!report) throw new NotFoundError('Archived report was not found or its 30-day recovery window has ended.');
      const actor = String(req.user?.email || req.user?.login || 'Super Admin');
      await this.patientActivityRepository.record({ userId: patient.id, patientCode: patient.patient_code, type: 'report', title: 'Archived report restored', summary: report.title, actor, metadata: { report_id: report.id } });
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'report.restored',
          target: `patient:${patient.id}`,
          metadata: { report_id: report.id, title: report.title },
        }).catch(() => null);
      }
      return sendSuccess(res, { message: 'Report restored to the patient record as private.', data: reportResponse(report) });
    } catch (error) { next(error); }
  };

  downloadPatientReport = async (req, res, next) => {
    try {
      const patient = await this.userRepository.findById(req.params.userId);
      if (!patient || patient.role !== 'user') throw new NotFoundError('Patient not found.');
      const report = await this.clinicalReportRepository.findByUserIdAndId(patient.id, req.params.reportId);
      if (!report) throw new NotFoundError('Patient report not found.');
      const inline = req.query?.inline === 'true';
      return sendSuccess(res, {
        data: {
          url: createClinicalReportDownloadUrl(report.public_id, report.format, { attachment: !inline }),
          expires_in_seconds: 60,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  reviewProgressCheckIn = async (req, res, next) => {
    try {
      const patient = await this.userRepository.findById(req.params.userId);
      if (!patient || patient.role !== 'user') throw new NotFoundError('Patient not found.');
      const checkInId = req.params.checkInId;
      const { doctor_note, is_doctor_reviewed = true } = req.body || {};
      if (doctor_note !== undefined && (typeof doctor_note !== 'string' || doctor_note.length > 2000)) {
        throw new BadRequestError('doctor_note must be text with at most 2000 characters.');
      }
      const existing = await this.progressCheckInRepository.findById(patient.id, checkInId);
      if (!existing) throw new NotFoundError('Progress check-in not found.');
      const updated = await this.progressCheckInRepository.updateReview(patient.id, checkInId, {
        doctor_note,
        is_doctor_reviewed,
      });
      const actor = String(req.user?.email || req.user?.login || 'Clinician');
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'progress_checkin.reviewed',
          target: `patient:${patient.id}`,
          metadata: { checkin_id: checkInId, is_doctor_reviewed: Boolean(is_doctor_reviewed), doctor_note: (doctor_note || '').slice(0, 100) },
        }).catch(() => null);
      }
      await this.patientActivityRepository?.record({
        userId: patient.id,
        patientCode: patient.patient_code,
        type: 'care_plan',
        title: 'Daily progress reviewed',
        summary: doctor_note ? doctor_note.slice(0, 120) : 'Progress check-in reviewed by clinician',
        actor,
        metadata: { checkin_id: checkInId },
      }).catch(() => null);

      return sendSuccess(res, {
        message: 'Progress check-in reviewed.',
        data: { item: await progressCheckInResponse(updated, this.imageStorage) },
      });
    } catch (error) {
      next(error);
    }
  };

  listHairTests = async (req, res, next) => {
    try {
      const result = await this.hairTestRepository.list({
        page: req.query.page,
        limit: req.query.limit,
      });
      const items = await Promise.all(result.items.map(async (assessment) => ({
        ...assessment,
        scalp_photos: await Promise.all((assessment.scalp_photos || []).filter((photo) => !photo.deleted_at).map(async (photo) => ({
          ...photo,
          url: photo.delivery_type === 'authenticated'
            ? this.imageStorage.createPrivateDownloadUrl(photo.file_name, photo.format)
            : photo.url,
          url_expires_in_seconds: photo.delivery_type === 'authenticated' ? 300 : null,
        }))),
      })));
      return sendSuccess(res, { data: { ...result, items } });
    } catch (error) {
      next(error);
    }
  };

  getHairTest = async (req, res, next) => {
    try {
      const { referenceNo } = req.params;
      const assessment = await this.hairTestRepository.findByReferenceNo(referenceNo);
      if (!assessment) throw new NotFoundError('Assessment not found.');
      const patient = assessment.userId ? await this.userRepository.findById(assessment.userId) : null;
      const scalpPhotos = await Promise.all((assessment.scalp_photos || []).filter((photo) => !photo.deleted_at).map(async (photo) => ({
        ...photo,
        url: photo.delivery_type === 'authenticated'
          ? this.imageStorage.createPrivateDownloadUrl(photo.file_name, photo.format)
          : photo.url,
        url_expires_in_seconds: photo.delivery_type === 'authenticated' ? 300 : null,
      })));
      const publicPatient = patient ? patient.toPublicProfile() : null;
      if (publicPatient && (!publicPatient.medical_conditions || !publicPatient.medical_conditions.length)) {
        if (Array.isArray(assessment.medical_conditions) && assessment.medical_conditions.length) {
          publicPatient.medical_conditions = assessment.medical_conditions;
        }
      }
      return sendSuccess(res, {
        data: {
          assessment: {
            ...assessment,
            clinical_notes: assessment.clinical_notes || null,
            recommended_treatments: assessment.recommended_treatments || null,
            ai_assessment_override: assessment.ai_assessment_override || null,
            scalp_photos: scalpPhotos,
          },
          patient: publicPatient ? {
            ...publicPatient,
            patient_code: patient.patient_code,
            created_at: patient.created_at,
          } : null,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  listTreatments = async (req, res, next) => {
    try {
      const result = await this.treatmentRepository.list({
        page: req.query.page,
        limit: req.query.limit,
      });
      return sendSuccess(res, { data: result });
    } catch (error) {
      next(error);
    }
  };

  createTreatment = async (req, res, next) => {
    try {
      const {
        reference_no,
        treatment_name,
        duration = '',
        instructions = '',
        doctor_name = '',
        medications = [],
        diagnosis = '',
        stage = '',
        next_review_date = '',
        routine_steps = [],
        diet_meals = [],
        patient_diet_suggestions = [],
        date,
      } = req.body || {};
      if (typeof reference_no !== 'string' || !reference_no.trim()) {
        throw new BadRequestError('reference_no is required.');
      }
      if (typeof treatment_name !== 'string' || !treatment_name.trim()) {
        throw new BadRequestError('treatment_name is required.');
      }
      if ([duration, instructions, doctor_name, diagnosis, stage, next_review_date].some((value) => typeof value !== 'string')) {
        throw new BadRequestError('Treatment plan text fields must be strings.');
      }
      if (diagnosis.length > 500 || stage.length > 120 || next_review_date.length > 10) throw new BadRequestError('Diagnosis, stage, or review date exceeds its allowed length.');
      if (next_review_date && !/^\d{4}-\d{2}-\d{2}$/.test(next_review_date)) throw new BadRequestError('next_review_date must use YYYY-MM-DD format.');
      if (!Array.isArray(medications) || medications.length > 25) {
        throw new BadRequestError('medications must be a list of up to 25 selected medicines or care products.');
      }
      const normalizedMedications = medications.map((medicine) => {
        if (!medicine || typeof medicine !== 'object' || Array.isArray(medicine)) {
          throw new BadRequestError('Each prescribed medicine must be an object.');
        }
        const fields = ['catalog_id', 'name', 'category', 'form', 'dose', 'frequency', 'duration', 'instructions'];
        for (const field of fields) {
          const value = medicine[field];
          if (value !== undefined && (typeof value !== 'string' || value.length > (field === 'instructions' ? 1000 : 240))) {
            throw new BadRequestError(`Medication ${field} must be text with a valid length.`);
          }
        }
        if (!medicine.name?.trim() || !medicine.dose?.trim() || !medicine.frequency?.trim()) {
          throw new BadRequestError('Each prescribed medicine needs a name, dose, and frequency.');
        }
        return Object.fromEntries(fields.map((field) => [field, typeof medicine[field] === 'string' ? medicine[field].trim() : '']));
      });
      if (!Array.isArray(routine_steps) || routine_steps.length > 30) throw new BadRequestError('routine_steps must contain up to 30 care steps.');
      const normalizedRoutineSteps = routine_steps.map((step) => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) throw new BadRequestError('Each routine step must be an object.');
        const fields = { title: 160, subtitle: 500, category: 80, time_of_day: 80 };
        for (const [field, maxLength] of Object.entries(fields)) {
          const value = step[field];
          if (value !== undefined && (typeof value !== 'string' || value.length > maxLength)) throw new BadRequestError(`Routine step ${field} must be text of at most ${maxLength} characters.`);
        }
        if (!step.title?.trim()) throw new BadRequestError('Each routine step needs a title.');
        return Object.fromEntries(Object.keys(fields).map((field) => [field, typeof step[field] === 'string' ? step[field].trim() : '']));
      });
      if (!Array.isArray(diet_meals) || diet_meals.length > 20) throw new BadRequestError('diet_meals must contain up to 20 meal suggestions.');
      const normalizedDietMeals = diet_meals.map((meal) => {
        if (!meal || typeof meal !== 'object' || Array.isArray(meal)) throw new BadRequestError('Each diet meal must be an object.');
        const fields = { type: 60, name: 160, nutrients: 200, benefit: 500 };
        for (const [field, maxLength] of Object.entries(fields)) {
          const value = meal[field];
          if (value !== undefined && (typeof value !== 'string' || value.length > maxLength)) throw new BadRequestError(`Diet meal ${field} must be text of at most ${maxLength} characters.`);
        }
        if (!meal.type?.trim() || !meal.name?.trim()) throw new BadRequestError('Each diet meal needs a meal type and name.');
        return Object.fromEntries(Object.keys(fields).map((field) => [field, typeof meal[field] === 'string' ? meal[field].trim() : '']));
      });
      const normalizedPatientDietSuggestions = normalizePatientDietSuggestions(patient_diet_suggestions);
      const hairTest = await this.hairTestRepository.findByReferenceNo(reference_no.trim());
      if (!hairTest) throw new NotFoundError('Hair test not found for that reference number.');

      const treatment = await this.treatmentRepository.create({
        test_id: hairTest.id,
        reference_no: hairTest.reference_no,
        userId: hairTest.userId,
        treatment_name: treatment_name.trim(),
        duration: duration.trim(),
        instructions: instructions.trim(),
        doctor_name: doctor_name.trim(),
        reviewed_by: String(req.user?.name || '').trim(),
        medications: normalizedMedications,
        diagnosis: diagnosis.trim(),
        stage: stage.trim(),
        next_review_date: next_review_date.trim(),
        routine_steps: normalizedRoutineSteps,
        diet_meals: normalizedDietMeals,
        patient_diet_suggestions: normalizedPatientDietSuggestions,
        ...(date ? { date } : {}),
      });
      // P0 Decoupling: Assigning a care plan updates recommendations, but does NOT mark the assessment reviewed.
      // Explicit clinician review via updateHairTestStatus is required to approve the assessment.
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor: String(req.user?.email || req.user?.login || 'Super Admin'),
          action: 'care_plan.created',
          target: `patient:${hairTest.userId}`,
          metadata: { reference_no: hairTest.reference_no, treatment_name: treatment_name.trim(), treatment_id: treatment.id },
        }).catch(() => null);
      }
      await this.patientActivityRepository?.record({ userId: hairTest.userId, type: 'care_plan', title: 'Care plan added', summary: treatment_name.trim(), actor: String(req.user?.email || req.user?.login || 'Super Admin'), metadata: { reference_no: hairTest.reference_no } });
      if (normalizedRoutineSteps.length > 0) {
        await this.notifyPatientRoutineAdded(hairTest.userId);
      }
      return sendSuccess(res, {
        message: 'Treatment plan created.',
        data: { ...treatment.toResponse(), reference_no: treatment.reference_no },
        statusCode: 201,
      });
    } catch (error) {
      next(error);
    }
  };

  assignTreatmentPlan = this.createTreatment;

  getTreatment = async (req, res, next) => {
    try {
      const treatmentId = req.params.treatmentId;
      const treatment = await this.treatmentRepository.findById(treatmentId);
      if (!treatment) throw new NotFoundError('Care plan not found.');
      return sendSuccess(res, { data: treatment.toResponse() });
    } catch (error) {
      next(error);
    }
  };

  updateTreatment = async (req, res, next) => {
    try {
      const treatmentId = req.params.treatmentId;
      const existing = await this.treatmentRepository.findById(treatmentId);
      if (!existing) throw new NotFoundError('Care plan not found.');

      const body = req.body || {};
      const updateData = {};
      const textFields = ['treatment_name', 'duration', 'instructions', 'doctor_name', 'diagnosis', 'stage', 'next_review_date'];
      for (const field of textFields) {
        if (body[field] !== undefined) {
          if (typeof body[field] !== 'string') throw new BadRequestError(`${field} must be a string.`);
          updateData[field] = body[field].trim();
        }
      }
      if (body.medications !== undefined) {
        if (!Array.isArray(body.medications) || body.medications.length > 25) {
          throw new BadRequestError('medications must be a list of up to 25 selected medicines or care products.');
        }
        updateData.medications = body.medications;
      }
      if (body.routine_steps !== undefined) {
        if (!Array.isArray(body.routine_steps) || body.routine_steps.length > 30) {
          throw new BadRequestError('routine_steps must contain up to 30 care steps.');
        }
        updateData.routine_steps = body.routine_steps;
      }
      if (body.diet_meals !== undefined) {
        if (!Array.isArray(body.diet_meals) || body.diet_meals.length > 20) {
          throw new BadRequestError('diet_meals must contain up to 20 meal suggestions.');
        }
        updateData.diet_meals = body.diet_meals;
      }
      if (body.patient_diet_suggestions !== undefined) {
        updateData.patient_diet_suggestions = normalizePatientDietSuggestions(body.patient_diet_suggestions);
      }

      const updated = await this.treatmentRepository.update(treatmentId, updateData);
      const actor = String(req.user?.email || req.user?.login || 'Super Admin');
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'care_plan.updated',
          target: `patient:${existing.userId}`,
          metadata: { treatment_id: treatmentId, fields: Object.keys(updateData) },
        }).catch(() => null);
      }
      await this.patientActivityRepository?.record({
        userId: existing.userId,
        type: 'care_plan',
        title: 'Care plan updated',
        summary: updated.treatment_name || 'Care plan details modified',
        actor,
        metadata: { treatment_id: treatmentId },
      }).catch(() => null);

      if (updateData.routine_steps !== undefined) {
        await this.notifyPatientRoutineAdded(existing.userId, { updated: true });
      }

      return sendSuccess(res, {
        message: 'Care plan updated successfully.',
        data: updated.toResponse(),
      });
    } catch (error) {
      next(error);
    }
  };

  withdrawTreatment = async (req, res, next) => {
    try {
      const treatmentId = req.params.treatmentId;
      const existing = await this.treatmentRepository.findById(treatmentId);
      if (!existing) throw new NotFoundError('Care plan not found.');

      const reason = String(req.body?.reason || req.body?.withdrawn_reason || 'Withdrawn by clinical admin').trim().slice(0, 500);
      const actor = String(req.user?.email || req.user?.login || 'Super Admin');

      const withdrawn = await this.treatmentRepository.withdraw(treatmentId, { reason, actor });
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'care_plan.withdrawn',
          target: `patient:${existing.userId}`,
          metadata: { treatment_id: treatmentId, reason },
        }).catch(() => null);
      }
      await this.patientActivityRepository?.record({
        userId: existing.userId,
        type: 'care_plan',
        title: 'Care plan withdrawn',
        summary: `Reason: ${reason}`,
        actor,
        metadata: { treatment_id: treatmentId, status: 'withdrawn' },
      }).catch(() => null);

      return sendSuccess(res, {
        message: 'Care plan withdrawn successfully.',
        data: withdrawn.toResponse(),
      });
    } catch (error) {
      next(error);
    }
  };

  updatePatientDietPlan = async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { diet_meals, assessment_id, reference_no } = req.body || {};
      if (!Array.isArray(diet_meals) || diet_meals.length > 20) {
        throw new BadRequestError('diet_meals must contain up to 20 meal suggestions.');
      }
      const normalizedDietMeals = diet_meals.map((meal) => {
        if (!meal || typeof meal !== 'object' || Array.isArray(meal)) {
          throw new BadRequestError('Each diet meal must be an object.');
        }
        const fields = { type: 60, name: 160, nutrients: 200, benefit: 500 };
        for (const [field, maxLength] of Object.entries(fields)) {
          const value = meal[field];
          if (value !== undefined && (typeof value !== 'string' || value.length > maxLength)) {
            throw new BadRequestError(`Diet meal ${field} must be text of at most ${maxLength} characters.`);
          }
        }
        if (!meal.type?.trim() || !meal.name?.trim()) {
          throw new BadRequestError('Each diet meal needs a meal type and name.');
        }
        return Object.fromEntries(Object.keys(fields).map((field) => [field, typeof meal[field] === 'string' ? meal[field].trim() : '']));
      });

      const updated = await this.treatmentRepository.updateDietMeals(userId, normalizedDietMeals);
      const planId = updated?.id ? String(updated.id) : `diet-${userId}`;
      const items = updated?.diet_meals || normalizedDietMeals;
      const actor = String(req.user?.email || req.user?.login || 'Admin');
      await this.auditEventRepository?.record({
        actor,
        action: 'care_plan.diet_updated',
        target: `patient:${userId}`,
        metadata: { plan_id: planId, meal_count: normalizedDietMeals.length, assessment_id, reference_no },
      }).catch(() => null);

      return sendSuccess(res, {
        message: 'Patient diet plan updated successfully.',
        data: {
          plan_id: planId,
          items,
          diet_meals: items,
          updated_at: updated?.updated_at || new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  updateHairTestStatus = async (req, res, next) => {
    try {
      const { referenceNo } = req.params;
      const { status, note } = req.body || {};
      if (!status || typeof status !== 'string') throw new BadRequestError('status is required.');
      const statusNeedsReason = ['archived', 'submitted'].includes(status.trim());
      if (statusNeedsReason && (typeof note !== 'string' || note.trim().length < 8)) {
        throw new BadRequestError('Add a short reason when archiving or restoring an assessment.');
      }
      const isSuper = req.user?.role === 'super_admin';
      const hasReviewPerm = isSuper || hasPermission(req.user, 'assessments.review') || hasPermission(req.user, 'reports.approve');
      const hasSubmitPerm = isSuper || hasPermission(req.user, 'hair-tests.submit') || hasPermission(req.user, 'hair-tests.upload') || hasReviewPerm;
      const targetStatus = status.trim().toLowerCase();

      if (['reviewed', 'approved'].includes(targetStatus)) {
        if (!hasReviewPerm) {
          throw new ForbiddenError("Permission 'assessments.review' is required to approve assessments.");
        }
      } else if (['submitted', 'under_review'].includes(targetStatus)) {
        if (!hasSubmitPerm) {
          throw new ForbiddenError("Permission 'hair-tests.submit' is required to submit assessments for review.");
        }
      } else if (targetStatus === 'archived') {
        if (!hasReviewPerm) {
          throw new ForbiddenError("Permission 'assessments.review' is required to archive assessments.");
        }
      }

      const actor = String(req.user?.email || req.user?.login || 'Admin');
      const updated = await this.hairTestRepository.updateStatus(referenceNo, status.trim(), {
        changed_by: actor,
        note: typeof note === 'string' ? note.trim() : '',
      });
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: status.trim() === 'archived' ? 'assessment.archived' : status.trim() === 'submitted' ? 'assessment.restored' : 'assessment.status_updated',
          target: `assessment:${referenceNo}`,
          metadata: { status: updated.status, reference_no: referenceNo, note: typeof note === 'string' ? note.trim() : '' },
        }).catch(() => null);
      }
      return sendSuccess(res, { message: 'Assessment status updated.', data: updated });
    } catch (error) {
      next(error);
    }
  };

  updateHairTest = async (req, res, next) => {
    try {
      const { referenceNo } = req.params;
      const hairTest = await this.hairTestRepository.findByReferenceNo(referenceNo);
      if (!hairTest) throw new NotFoundError('Assessment not found for that reference number.');

      const {
        clinical_notes,
        recommended_treatments,
        ai_assessment_override,
        status,
        status_note,
      } = req.body || {};

      const isSuper = req.user?.role === 'super_admin';
      const hasReviewPerm = isSuper || hasPermission(req.user, 'assessments.review') || hasPermission(req.user, 'reports.approve');
      const hasCarePlanPerm = isSuper || hasPermission(req.user, 'care-plans.edit');
      const hasSubmitPerm = isSuper || hasPermission(req.user, 'hair-tests.submit') || hasPermission(req.user, 'hair-tests.upload') || hasReviewPerm;

      if (clinical_notes !== undefined) {
        if (!hasReviewPerm) {
          throw new ForbiddenError("Permission 'assessments.review' is required to update clinical notes.");
        }
      }

      if (ai_assessment_override !== undefined) {
        if (!hasReviewPerm) {
          throw new ForbiddenError("Permission 'assessments.review' is required to override AI assessment.");
        }
      }

      if (recommended_treatments !== undefined) {
        if (!hasCarePlanPerm) {
          throw new ForbiddenError("Permission 'care-plans.edit' is required to update treatment recommendations.");
        }
      }

      if (status !== undefined && typeof status === 'string' && status.trim() && status.trim() !== hairTest.status) {
        const targetStatus = status.trim().toLowerCase();
        if (['reviewed', 'approved'].includes(targetStatus)) {
          if (!hasReviewPerm) {
            throw new ForbiddenError("Permission 'assessments.review' is required to approve assessments.");
          }
        } else if (['submitted', 'under_review'].includes(targetStatus)) {
          if (!hasSubmitPerm) {
            throw new ForbiddenError("Permission 'hair-tests.submit' is required to submit assessments for review.");
          }
        } else if (targetStatus === 'archived') {
          if (!hasReviewPerm) {
            throw new ForbiddenError("Permission 'assessments.review' is required to archive assessments.");
          }
        }
      }

      const updateData = {};
      const actor = String(req.user?.name || req.user?.email || req.user?.login || 'Doctor');

      // 1. Clinical Audit Notes
      if (clinical_notes !== undefined) {
        if (typeof clinical_notes === 'string') {
          updateData.clinical_notes = {
            doctor_notes: clinical_notes.trim(),
            diagnosis_insights: hairTest.clinical_notes?.diagnosis_insights || '',
            clinical_recommendations: hairTest.clinical_notes?.clinical_recommendations || '',
            updated_at: new Date().toISOString(),
            updated_by: actor,
          };
        } else if (clinical_notes && typeof clinical_notes === 'object' && !Array.isArray(clinical_notes)) {
          const { doctor_notes, diagnosis_insights, clinical_recommendations } = clinical_notes;
          updateData.clinical_notes = {
            doctor_notes: typeof doctor_notes === 'string' ? doctor_notes.trim() : (hairTest.clinical_notes?.doctor_notes || ''),
            diagnosis_insights: typeof diagnosis_insights === 'string' ? diagnosis_insights.trim() : (hairTest.clinical_notes?.diagnosis_insights || ''),
            clinical_recommendations: typeof clinical_recommendations === 'string' ? clinical_recommendations.trim() : (hairTest.clinical_notes?.clinical_recommendations || ''),
            updated_at: new Date().toISOString(),
            updated_by: actor,
          };
        } else if (clinical_notes === null) {
          updateData.clinical_notes = null;
        } else {
          throw new BadRequestError('clinical_notes must be an object or string.');
        }
      }

      // 2. Treatment Recommendations
      if (recommended_treatments !== undefined) {
        if (recommended_treatments && typeof recommended_treatments === 'object') {
          const isArr = Array.isArray(recommended_treatments);
          const products = isArr ? recommended_treatments : (recommended_treatments.products || recommended_treatments.items || []);
          const appointment = isArr ? null : (recommended_treatments.appointment || null);
          const instructions = isArr ? '' : String(recommended_treatments.instructions || recommended_treatments.notes || '');

          updateData.recommended_treatments = {
            products: Array.isArray(products) ? products : [],
            appointment: appointment && typeof appointment === 'object' ? appointment : null,
            instructions: instructions.trim(),
            updated_at: new Date().toISOString(),
            updated_by: actor,
          };
        } else if (recommended_treatments === null) {
          updateData.recommended_treatments = null;
        } else {
          throw new BadRequestError('recommended_treatments must be an object or array.');
        }
      }

      // 3. AI Result Overrides
      if (ai_assessment_override !== undefined) {
        if (ai_assessment_override && typeof ai_assessment_override === 'object' && !Array.isArray(ai_assessment_override)) {
          const { hair_loss_stage, scalp_score, primary_concern, prognosis, notes } = ai_assessment_override;
          updateData.ai_assessment_override = {
            hair_loss_stage: hair_loss_stage !== undefined ? String(hair_loss_stage).trim() : (hairTest.ai_assessment_override?.hair_loss_stage || ''),
            scalp_score: scalp_score !== undefined ? (scalp_score === null || scalp_score === '' ? null : Number(scalp_score)) : (hairTest.ai_assessment_override?.scalp_score ?? null),
            primary_concern: primary_concern !== undefined ? String(primary_concern).trim() : (hairTest.ai_assessment_override?.primary_concern || ''),
            prognosis: prognosis !== undefined ? String(prognosis).trim() : (hairTest.ai_assessment_override?.prognosis || ''),
            notes: notes !== undefined ? String(notes).trim() : (hairTest.ai_assessment_override?.notes || ''),
            overridden_by: actor,
            overridden_at: new Date().toISOString(),
          };
        } else if (ai_assessment_override === null) {
          updateData.ai_assessment_override = null;
        } else {
          throw new BadRequestError('ai_assessment_override must be an object.');
        }
      }

      // 4. Status update
      let explicitlyReviewed = false;
      let statusChanged = false;
      if (status !== undefined && typeof status === 'string' && status.trim() && status.trim() !== hairTest.status) {
        const newStatus = status.trim();
        statusChanged = true;
        explicitlyReviewed = newStatus === 'reviewed';
        await this.hairTestRepository.updateStatus(referenceNo, newStatus, {
          changed_by: actor,
          note: typeof status_note === 'string' && status_note.trim()
            ? status_note.trim()
            : newStatus === 'reviewed'
              ? 'Assessment explicitly marked reviewed by the care team.'
              : `Assessment status changed to ${newStatus.replaceAll('_', ' ')}.`,
        });
      }

      let updated = null;
      if (Object.keys(updateData).length > 0) {
        updated = await this.hairTestRepository.update(referenceNo, updateData);
      }
      if (!updated) {
        updated = await this.hairTestRepository.findByReferenceNo(referenceNo);
      }

      if (this.auditEventRepository?.record) {
        const assessmentEvents = [];
        if (Object.hasOwn(updateData, 'clinical_notes')) assessmentEvents.push({ action: 'assessment.notes_updated', fields: ['clinical_notes'] });
        if (Object.hasOwn(updateData, 'recommended_treatments')) assessmentEvents.push({ action: 'assessment.recommendations_updated', fields: ['recommended_treatments'] });
        if (Object.hasOwn(updateData, 'ai_assessment_override')) assessmentEvents.push({ action: 'assessment.ai_override_updated', fields: ['ai_assessment_override'] });
        if (explicitlyReviewed) assessmentEvents.push({ action: 'assessment.reviewed', fields: ['status'] });
        else if (statusChanged) {
          assessmentEvents.push({ action: 'assessment.status_changed', fields: ['status'] });
        }
        for (const event of assessmentEvents) {
          await this.auditEventRepository.record({
            actor,
            action: event.action,
            target: `assessment:${referenceNo}`,
            metadata: { reference_no: referenceNo, fields: event.fields },
          }).catch(() => null);
        }
      }

      if (explicitlyReviewed && this.patientActivityRepository?.record && hairTest.userId) {
        await this.patientActivityRepository.record({
          userId: hairTest.userId,
          patientCode: hairTest.patient_code,
          type: 'assessment',
          title: 'Assessment reviewed',
          summary: 'Your assessment has been reviewed by the care team.',
          actor,
          metadata: { reference_no: referenceNo, action: 'explicit_review' },
        }).catch(() => null);
      }

      return sendSuccess(res, {
        message: 'Assessment updated successfully.',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };

  listReviews = async (req, res, next) => {
    try {
      const result = await this.reviewRepository.listAdmin({
        page: req.query.page,
        limit: req.query.limit,
        status: req.query.status,
      });
      return sendSuccess(res, { data: result });
    } catch (error) {
      next(error);
    }
  };

  createAdminReview = async (req, res, next) => {
    try {
      const {
        name, rating, category, message, avatar = '', media_assets = null, treatment = '', duration = '',
        review_type = 'doctor', product_id = '', page = 'home', status = 'draft', patient_consent_confirmed = false,
      } = req.body || {};
      const productId = String(product_id || '').trim();
      if ((review_type === 'product' && !productId) || (productId && review_type !== 'product')) {
        throw new BadRequestError('Product reviews must include a product ID, and product IDs can only be attached to product reviews.');
      }
      if (status === 'active' && !hasPermission(req.user, 'content.publish')) {
        throw new ForbiddenError("Permission 'content.publish' is required to publish a patient story.");
      }
      if (status === 'active' && patient_consent_confirmed !== true) {
        throw new BadRequestError('An authorized admin must confirm documented patient consent before publishing this story.');
      }

      const actor = String(req.user?.email || req.user?.login || 'Admin');
      const review = await this.reviewRepository.create({
        name: name.trim(),
        rating,
        category: category.trim(),
        message: message.trim(),
        avatar,
        media_assets,
        treatment: treatment.trim(),
        duration: duration.trim(),
        review_type,
        product_id: productId,
        page,
        status,
        consent_verified: patient_consent_confirmed === true,
        // Moderation and publishing consent are not proof of patient verification.
        is_verified: false,
        created_by: actor,
        updated_by: actor,
      });
      await this.auditEventRepository?.record?.({
        actor,
        action: 'review.created',
        target: `review:${review.id}`,
        metadata: { id: review.id, status: review.status, patient_consent_confirmed: patient_consent_confirmed === true },
      }).catch(() => null);
      return sendSuccess(res, { message: 'Patient story saved.', data: review, statusCode: 201 });
    } catch (error) {
      next(error);
    }
  };

  updateAdminReview = async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const current = await this.reviewRepository.findById(id);
      if (!current) throw new NotFoundError('Review not found.');
      if (current.status === 'active' && !hasPermission(req.user, 'content.publish')) {
        throw new ForbiddenError("Permission 'content.publish' is required to edit a published patient story.");
      }
      const body = req.body || {};
      const { patient_consent_confirmed, ...updates } = body;
      if (Object.hasOwn(updates, 'product_id') || Object.hasOwn(updates, 'review_type')) {
        const nextType = updates.review_type ?? current.review_type;
        const nextProductId = String(updates.product_id ?? current.product_id ?? '').trim();
        if ((nextType === 'product' && !nextProductId) || (nextProductId && nextType !== 'product')) {
          throw new BadRequestError('Product reviews must include a product ID, and product IDs can only be attached to product reviews.');
        }
      }
      const consentVerified = patient_consent_confirmed === true || current.consent_verified === true;
      if (patient_consent_confirmed === true && !hasPermission(req.user, 'content.publish')) {
        throw new ForbiddenError("Permission 'content.publish' is required to confirm publication consent.");
      }
      if (current.status === 'active' && !consentVerified) {
        throw new BadRequestError('An authorized admin must confirm documented patient consent before saving a published story.');
      }

      const actor = String(req.user?.email || req.user?.login || 'Admin');
      const updated = await this.reviewRepository.updateAdmin(id, {
        ...updates,
        ...(patient_consent_confirmed === true ? { consent_verified: true } : {}),
        updated_by: actor,
      });
      if (!updated) throw new NotFoundError('Review not found.');
      await this.auditEventRepository?.record?.({
        actor,
        action: 'review.updated',
        target: `review:${id}`,
        metadata: { id, patient_consent_confirmed: patient_consent_confirmed === true },
      }).catch(() => null);
      return sendSuccess(res, { message: 'Patient story updated.', data: updated });
    } catch (error) {
      next(error);
    }
  };

  deleteAdminReview = async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const review = await this.reviewRepository.findById(id);
      if (!review) throw new NotFoundError('Review not found.');
      if (review.status === 'active' && !hasPermission(req.user, 'content.publish')) {
        throw new ForbiddenError("Permission 'content.publish' is required to delete a published patient story.");
      }
      const deleted = await this.reviewRepository.delete(id);
      if (!deleted) throw new NotFoundError('Review not found.');
      const actor = String(req.user?.email || req.user?.login || 'Admin');
      await this.auditEventRepository?.record?.({
        actor,
        action: 'review.deleted',
        target: `review:${id}`,
        metadata: { id },
      }).catch(() => null);
      return sendSuccess(res, { message: 'Patient story deleted.' });
    } catch (error) {
      next(error);
    }
  };

  updateReviewStatus = async (req, res, next) => {
    try {
      const { id, status } = req.body || {};
      if (!Number.isInteger(Number(id))) throw new BadRequestError('A numeric review id is required.');
      if (!['draft', 'pending', 'active', 'rejected'].includes(status)) {
        throw new BadRequestError('status must be draft, pending, active, or rejected.');
      }
      const current = await this.reviewRepository.findById(id);
      if (!current) throw new NotFoundError('Review not found.');
      if (status === 'active' && current.consent_verified !== true) {
        throw new BadRequestError('An authorized admin must attest to documented patient consent before publishing this story.');
      }
      const review = await this.reviewRepository.updateStatus(id, status);
      if (!review) throw new NotFoundError('Review not found.');
      const actor = String(req.user?.email || req.user?.login || 'Admin');
      await this.auditEventRepository?.record?.({
        actor,
        action: 'review.status_updated',
        target: `review:${id}`,
        metadata: { id: Number(id), status: review.status },
      }).catch(() => null);
      return sendSuccess(res, { message: 'Review status updated.', data: review });
    } catch (error) {
      next(error);
    }
  };

  getDashboardSummary = async (req, res, next) => {
    try {
      // These sources are independent. Start all reads together so dashboard
      // latency is bounded by the slowest repository call instead of their sum.
      const [patientCountResult, apptMetrics, testSummary, reps, prods, logs] = await Promise.all([
        this.userRepository?.count
          ? this.userRepository.count()
          : this.userRepository?.list
            ? this.userRepository.list({ limit: 1 })
            : Promise.resolve(0),
        this.appointmentRepository?.getDashboardMetrics
          ? this.appointmentRepository.getDashboardMetrics({ timeZone: 'Asia/Kolkata' })
          : (this.appointmentRepository?.list?.({ limit: 500 }) ?? Promise.resolve(null)),
        this.hairTestRepository?.getStatusSummary
          ? this.hairTestRepository.getStatusSummary()
          : (this.hairTestRepository?.listAdmin
            ? this.hairTestRepository.listAdmin({ limit: 100 })
            : (this.hairTestRepository?.list?.({ limit: 100 }) ?? Promise.resolve(null))),
        this.clinicalReportRepository?.listAll?.() ?? Promise.resolve(null),
        this.productRepository?.list?.({ limit: 100 }) ?? Promise.resolve(null),
        this.auditEventRepository?.list?.({ limit: 10 }) ?? Promise.resolve(null),
      ]);

      const totalPatients = typeof patientCountResult === 'number'
        ? patientCountResult
        : (patientCountResult?.total || 0);

      let totalAppointments = 0;
      let todayAppointments = 0;
      let pendingAppointments = 0;
      let confirmedAppointments = 0;
      let completedAppointments = 0;
      if (apptMetrics) {
        if (typeof apptMetrics.total === 'number' && apptMetrics.today !== undefined) {
          totalAppointments = apptMetrics.total;
          todayAppointments = apptMetrics.today;
          pendingAppointments = apptMetrics.pending || 0;
          confirmedAppointments = apptMetrics.confirmed || 0;
          completedAppointments = apptMetrics.completed || 0;
        } else {
          const items = Array.isArray(apptMetrics) ? apptMetrics : (apptMetrics?.items || []);
          totalAppointments = Array.isArray(apptMetrics) ? apptMetrics.length : (apptMetrics?.total || items.length);
          const kolkataDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
          todayAppointments = items.filter(
            (a) => (a.starts_at || '').slice(0, 10) === kolkataDateStr && !['Cancelled', 'No show'].includes(a.status),
          ).length;
          pendingAppointments = items.filter((a) => a.status === 'Pending').length;
          confirmedAppointments = items.filter((a) => a.status === 'Confirmed').length;
          completedAppointments = items.filter((a) => a.status === 'Completed').length;
        }
      }

      let totalAssessments = 0;
      let pendingAssessments = 0;
      if (testSummary) {
        if (typeof testSummary.total === 'number' && (testSummary.submitted !== undefined || testSummary.under_review !== undefined)) {
          totalAssessments = testSummary.total;
          pendingAssessments = (testSummary.submitted || 0) + (testSummary.under_review || 0);
        } else {
          const items = Array.isArray(testSummary) ? testSummary : (testSummary?.items || []);
          totalAssessments = Array.isArray(testSummary) ? testSummary.length : (testSummary?.total || items.length);
          pendingAssessments = items.filter((t) => {
            const st = String(t.status || '').toLowerCase();
            return st === 'submitted' || st === 'under_review' || st === 'review' || !t.reviewed;
          }).length;
        }
      }

      let totalReports = 0;
      let sharedReports = 0;
      if (reps) {
        totalReports = reps.length;
        sharedReports = reps.filter((r) => r.visibility === 'Shared').length;
      }

      let totalProducts = 0;
      let lowStockProducts = 0;
      if (prods) {
        const items = prods?.items || [];
        totalProducts = prods?.total || items.length;
        lowStockProducts = items.filter((p) => (p.stock || p.inventory_count || 0) < 10).length;
      }

      let recentActivity = [];
      if (logs) {
        recentActivity = (logs?.items || []).map((e) => ({
          id: e.id,
          who: e.actor,
          action: e.action,
          target: e.target,
          type: e.targetType || 'System',
          time: e.created_at ? new Date(e.created_at).toISOString() : new Date().toISOString(),
        }));
      }

      return sendSuccess(res, {
        data: {
          patients: { total: totalPatients },
          appointments: {
            total: totalAppointments,
            today: todayAppointments,
            pending: pendingAppointments,
            confirmed: confirmedAppointments,
            completed: completedAppointments,
          },
          assessments: {
            total: totalAssessments,
            pending: pendingAssessments,
          },
          reports: {
            total: totalReports,
            shared: sharedReports,
          },
          catalog: {
            totalProducts,
            lowStockProducts,
          },
          recentActivity,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  inviteAdmin = async (req, res, next) => {
    try {
      const actor = req.user?.email || 'Super Admin';
      const { name, email, roleTemplate, permissions, permissionOverrides } = req.body || {};
      const { account, generatedPassword } = await this.createAdminAccountUseCase.execute({
        name,
        email,
        roleTemplate,
        permissions,
        permissionOverrides,
      });

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'admin.invited',
          target: `admin:${account.email}`,
          metadata: { id: account.id, email: account.email, roleTemplate },
        }).catch(() => null);
      }

      return sendSuccess(res, {
        statusCode: 201,
        message: 'Admin account invited successfully.',
        data: {
          admin: account,
          credentials: {
            login_id: account.email,
            password: generatedPassword,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  };

  updateAdminAccess = async (req, res, next) => {
    try {
      const { id } = req.params;
      const actor = req.user?.email || 'Super Admin';
      const { roleTemplate, permissions, permissionOverrides } = req.body || {};
      const updated = await this.adminAccountRepository.updateAccess(id, {
        roleTemplate,
        permissions,
        permissionOverrides,
      });

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'admin.access_updated',
          target: `admin:${updated.email}`,
          metadata: { id, roleTemplate, permissionsCount: updated.effectivePermissions?.length },
        }).catch(() => null);
      }

      return sendSuccess(res, { message: 'Admin access updated successfully.', data: updated });
    } catch (error) {
      next(error);
    }
  };

  setAdminStatus = async (req, res, next) => {
    try {
      const { id } = req.params;
      const actor = req.user?.email || 'Super Admin';
      let { active, status } = req.body || {};

      if (typeof active !== 'boolean') {
        if (typeof status === 'string') {
          active = status.toLowerCase() === 'active';
        } else {
          throw new BadRequestError('active boolean flag or status ("active" | "suspended") is required.');
        }
      }

      const updated = active
        ? await this.adminAccountRepository.reactivate(id)
        : await this.adminAccountRepository.suspend(id);

      if (!active && this.sessionRepository?.revokeByUserId) {
        await this.sessionRepository.revokeByUserId(id, 'ACCOUNT_SUSPENDED').catch(() => null);
      }

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: active ? 'admin.reactivated' : 'admin.suspended',
          target: `admin:${updated.email}`,
          metadata: { id, active },
        }).catch(() => null);
      }

      return sendSuccess(res, {
        message: active ? 'Admin account reactivated.' : 'Admin account suspended.',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };

  rotateAdminPassword = async (req, res, next) => {
    try {
      const { id } = req.params;
      const actor = req.user?.email || 'Super Admin';
      const { newPassword } = req.body || {};

      if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
        throw new BadRequestError('newPassword must be at least 8 characters long.');
      }

      const passwordHash = await hashPassword(newPassword);
      await this.adminAccountRepository.rotatePassword(id, passwordHash);

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'admin.password_rotated',
          target: `admin:${id}`,
          metadata: { id },
        }).catch(() => null);
      }

      return sendSuccess(res, { message: 'Password rotated successfully.' });
    } catch (error) {
      next(error);
    }
  };

  deleteAdminAccount = async (req, res, next) => {
    try {
      const { id } = req.params;
      const actor = req.user?.email || 'Super Admin';
      const deleted = await this.adminAccountRepository.delete(id);

      if (this.sessionRepository?.revokeByUserId) {
        await this.sessionRepository.revokeByUserId(id, 'ACCOUNT_DELETED').catch(() => null);
      }

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'admin.deleted',
          target: `admin:${deleted.email}`,
          metadata: { id, email: deleted.email },
        }).catch(() => null);
      }

      return sendSuccess(res, {
        message: 'Admin account removed successfully.',
        data: { id, email: deleted.email },
      });
    } catch (error) {
      next(error);
    }
  };

  listFeatureFlags = async (req, res, next) => {
    try {
      if (!this.featureFlagRepository) throw new NotFoundError('Feature flag management is not configured.');
      const flags = await this.featureFlagRepository.list({
        platform: req.query?.platform,
        enabled: req.query?.enabled !== undefined ? req.query.enabled === 'true' : undefined,
      });
      return sendSuccess(res, { data: { items: flags, total: flags.length } });
    } catch (error) {
      next(error);
    }
  };

  updateFeatureFlag = async (req, res, next) => {
    try {
      const { key } = req.params;
      const actor = req.user?.email || 'Super Admin';
      if (!this.featureFlagRepository) throw new NotFoundError('Feature flag management is not configured.');
      const { enabled, rolloutPercentage, effectiveDate, platform, description, title, group } = req.body || {};

      const updated = await this.featureFlagRepository.setFlag(key, {
        enabled,
        rolloutPercentage,
        effectiveDate,
        platform,
        description,
        title,
        group,
        updatedBy: actor,
      });

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'feature_flag.updated',
          target: `flag:${key}`,
          metadata: { key, enabled: updated.enabled, rolloutPercentage: updated.rolloutPercentage },
        }).catch(() => null);
      }

      return sendSuccess(res, { message: 'Feature flag updated successfully.', data: updated });
    } catch (error) {
      next(error);
    }
  };

  listReleasePolicies = async (req, res, next) => {
    try {
      if (!this.appReleasePolicyRepository) throw new NotFoundError('Release policy management is not configured.');
      const policies = await this.appReleasePolicyRepository.list();
      return sendSuccess(res, { data: { items: policies } });
    } catch (error) {
      next(error);
    }
  };

  updateReleasePolicy = async (req, res, next) => {
    try {
      const { platform } = req.params;
      const actor = req.user?.email || 'Super Admin';
      if (!this.appReleasePolicyRepository) throw new NotFoundError('Release policy management is not configured.');
      const { minVersion, minBuild, latestVersion, latestBuild, forceUpdate, enabled, scheduledAt, maintenanceMode, maintenanceMessage, releaseNotes, downloadUrl, updateMessage } = req.body || {};
      if (!['android', 'ios'].includes(String(platform).toLowerCase())) {
        throw new BadRequestError('Platform must be android or ios.');
      }
      const semver = /^\d+\.\d+\.\d+$/;
      if (minVersion !== undefined && !semver.test(String(minVersion))) throw new BadRequestError('Minimum version must use semantic version format, such as 1.2.3.');
      if (latestVersion !== undefined && !semver.test(String(latestVersion))) throw new BadRequestError('Latest version must use semantic version format, such as 1.2.3.');
      for (const [label, value] of [['Minimum build', minBuild], ['Latest build', latestBuild]]) {
        if (value !== undefined && (!/^\d+$/.test(String(value)) || Number(value) < 1)) throw new BadRequestError(`${label} must be a positive whole number.`);
      }
      if (enabled !== undefined && typeof enabled !== 'boolean') throw new BadRequestError('Enabled must be a boolean.');
      if (forceUpdate !== undefined && typeof forceUpdate !== 'boolean') throw new BadRequestError('Force update must be a boolean.');
      if (maintenanceMode !== undefined && typeof maintenanceMode !== 'boolean') throw new BadRequestError('Maintenance mode must be a boolean.');
      if (scheduledAt !== undefined && scheduledAt !== null && scheduledAt !== '') {
        const scheduledTime = new Date(scheduledAt).getTime();
        if (!Number.isFinite(scheduledTime) || scheduledTime <= Date.now()) throw new BadRequestError('Scheduled start must be a valid future date and time.');
      }
      if (minVersion !== undefined && latestVersion !== undefined) {
        const compareVersion = (left, right) => {
          const a = String(left).split('.').map(Number);
          const b = String(right).split('.').map(Number);
          for (let index = 0; index < 3; index += 1) {
            if (a[index] !== b[index]) return a[index] - b[index];
          }
          return 0;
        };
        const versionOrder = compareVersion(minVersion, latestVersion);
        const buildOrder = Number(minBuild ?? 1) - Number(latestBuild ?? Number.MAX_SAFE_INTEGER);
        if (versionOrder > 0 || (versionOrder === 0 && buildOrder > 0)) {
          throw new BadRequestError('Minimum supported version/build cannot be newer than the latest release.');
        }
      }
      if (downloadUrl !== undefined && downloadUrl !== '') {
        let parsedUrl;
        try { parsedUrl = new URL(downloadUrl); } catch { throw new BadRequestError('Store URL must be a valid HTTPS link.'); }
        if (parsedUrl.protocol !== 'https:') throw new BadRequestError('Store URL must be a valid HTTPS link.');
      }
      if (enabled === true && maintenanceMode !== true) {
        const current = await this.appReleasePolicyRepository.getByPlatform(platform);
        const effectiveStoreUrl = downloadUrl === undefined ? current?.downloadUrl : downloadUrl;
        if (!effectiveStoreUrl) throw new BadRequestError('Add a store URL before enabling an update policy.');
        try {
          if (new URL(effectiveStoreUrl).protocol !== 'https:') throw new Error('invalid protocol');
        } catch {
          throw new BadRequestError('Store URL must be a valid HTTPS link.');
        }
      }
      if (updateMessage !== undefined && (typeof updateMessage !== 'string' || updateMessage.trim().length < 8 || updateMessage.trim().length > 160)) {
        throw new BadRequestError('Update message must be between 8 and 160 characters.');
      }
      if (maintenanceMessage !== undefined && (typeof maintenanceMessage !== 'string' || maintenanceMessage.trim().length < 8 || maintenanceMessage.trim().length > 200)) {
        throw new BadRequestError('Maintenance message must be between 8 and 200 characters.');
      }

      const updated = await this.appReleasePolicyRepository.setPolicy(platform, {
        minVersion,
        minBuild: minBuild === undefined ? undefined : String(minBuild),
        latestVersion,
        latestBuild: latestBuild === undefined ? undefined : String(latestBuild),
        forceUpdate,
        enabled,
        scheduledAt: scheduledAt === '' ? null : scheduledAt,
        maintenanceMode,
        maintenanceMessage,
        releaseNotes,
        downloadUrl,
        updateMessage,
        updatedBy: actor,
      });

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'release_policy.updated',
          target: `policy:${platform}`,
          metadata: { platform, minVersion, latestVersion, forceUpdate, maintenanceMode },
        }).catch(() => null);
      }

      return sendSuccess(res, { message: 'Release policy updated successfully.', data: updated });
    } catch (error) {
      next(error);
    }
  };

  getAppConfig = async (req, res, next) => {
    try {
      const platform = String(req.headers?.['x-platform'] || req.query?.platform || 'android').toLowerCase();
      const clientVersion = String(req.headers?.['x-app-version'] || req.query?.version || '1.0.0');
      const clientBuild = String(req.headers?.['x-app-build'] || req.query?.build || '');

      let versionCheck = { updateRequired: false, updateAvailable: false, maintenanceMode: false };
      if (this.appReleasePolicyRepository) {
        versionCheck = await this.appReleasePolicyRepository.checkClientVersion({ platform, clientVersion, clientBuild });
      }

      let flags = {};
      let appointmentBilling = {
        configured: true,
        pay_at_clinic_enabled: true,
        online_pay_enabled: true,
        payment_required: false,
        consultation_fee: 500,
        currency: 'INR',
        first_appointment_free: false,
      };

      if (this.featureFlagRepository) {
        const flagList = await this.featureFlagRepository.list({ platform });
        flags = Object.fromEntries(flagList.map((f) => [f.key, f.enabled]));
        const billingFlag = flagList.find((f) => f.key === 'clinic_appointment_billing');
        if (billingFlag) {
          const rawFee = billingFlag.metadata?.consultation_fee;
          const fee = typeof rawFee === 'number' || (typeof rawFee === 'string' && rawFee.trim() !== '')
            ? Number(rawFee)
            : 500;
          const configured = billingFlag.metadata?.configured !== false && Number.isFinite(fee) && fee >= 0;
          const payAtClinic = billingFlag.metadata?.pay_at_clinic_enabled != null
            ? Boolean(billingFlag.metadata.pay_at_clinic_enabled)
            : (billingFlag.metadata?.payment_required != null ? !billingFlag.metadata.payment_required : true);
          const onlinePay = billingFlag.metadata?.online_pay_enabled != null
            ? Boolean(billingFlag.metadata.online_pay_enabled)
            : (billingFlag.metadata?.payment_required != null ? Boolean(billingFlag.metadata.payment_required) : true);
          appointmentBilling = {
            configured,
            pay_at_clinic_enabled: configured ? (payAtClinic || !onlinePay) : true,
            online_pay_enabled: configured ? onlinePay : true,
            payment_required: configured ? (onlinePay && !payAtClinic) : false,
            consultation_fee: configured ? fee : 500,
            currency: String(billingFlag.metadata?.currency ?? 'INR'),
            first_appointment_free: Boolean(billingFlag.metadata?.first_appointment_free ?? false),
          };
        }
      }

      if (typeof res.setHeader === 'function' && !res.getHeader?.('Cache-Control')) {
        res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120, stale-while-revalidate=300');
      }
      if (typeof res.setHeader === 'function') {
        const existingVary = String(res.getHeader?.('Vary') ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        const varyHeaders = new Set(existingVary.map((value) => value.toLowerCase()));
        for (const header of ['X-Platform', 'X-App-Version', 'X-App-Build']) {
          if (!varyHeaders.has(header.toLowerCase())) existingVary.push(header);
        }
        res.setHeader('Vary', existingVary.join(', '));
      }

      return sendSuccess(res, {
        data: {
          platform,
          version: clientVersion,
          versionCheck,
          features: flags,
          appointment_billing: appointmentBilling,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  listAuditLogs = async (req, res, next) => {
    try {
      const { page, limit, action, actorId, target, query, startDate, endDate } = req.query || {};
      const result = await this.auditEventRepository.list({
        page,
        limit,
        action,
        actorId,
        target,
        query,
        startDate,
        endDate,
      });
      return sendSuccess(res, { data: result });
    } catch (error) {
      next(error);
    }
  };

  exportAuditLogs = async (req, res, next) => {
    try {
      const actor = req.user?.email || 'Super Admin';
      const { action, actorId, target, query, startDate, endDate, format = 'json' } = req.query || {};

      const exported = await this.auditEventRepository.exportLogs({
        action,
        actorId,
        target,
        query,
        startDate,
        endDate,
        format,
      });

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'audit.exported',
          target: 'audit_logs',
          metadata: { count: exported.count, format },
        }).catch(() => null);
      }

      return sendSuccess(res, { message: 'Audit logs exported successfully.', data: exported });
    } catch (error) {
      next(error);
    }
  };

  exportPatients = async (req, res, next) => {
    try {
      const actor = req.user?.email || 'Super Admin';
      const users = await this.userRepository.list({ limit: 1000 });
      const items = (users?.items || []).map((u) => ({
        id: u.id,
        patientCode: u.patient_code,
        name: u.name,
        email: u.email,
        phone: u.phone,
        age: u.age,
        gender: u.gender,
        city: u.city,
        occupation: u.occupation,
        created_at: u.created_at,
      }));

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'patients.exported',
          target: 'patients',
          metadata: { count: items.length },
        }).catch(() => null);
      }

      return sendSuccess(res, {
        message: 'Patients exported successfully.',
        data: { count: items.length, items, exportedAt: new Date().toISOString() },
      });
    } catch (error) {
      next(error);
    }
  };

  exportAppointments = async (req, res, next) => {
    try {
      const actor = req.user?.email || 'Super Admin';
      const appts = await this.appointmentRepository.list({ limit: 1000 });
      const rawList = Array.isArray(appts) ? appts : (appts?.items || []);
      const items = rawList.map((a) => ({
        id: a.id,
        patientId: a.patient_id,
        patientName: a.patient_name,
        doctorName: a.doctor_name,
        startsAt: a.starts_at,
        timeSlot: a.time_slot,
        serviceName: a.service_name,
        status: a.status,
        paymentStatus: a.payment_status,
        consultationFee: a.consultation_fee,
        created_at: a.created_at,
      }));

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'appointments.exported',
          target: 'appointments',
          metadata: { count: items.length },
        }).catch(() => null);
      }

      return sendSuccess(res, {
        message: 'Appointments exported successfully.',
        data: { count: items.length, items, exportedAt: new Date().toISOString() },
      });
    } catch (error) {
      next(error);
    }
  };

  listReceivedPayments = async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
      const search = (req.query.search || '').trim().toLowerCase();
      const typeFilter = (req.query.type || 'all').toLowerCase();
      const statusFilter = (req.query.status || 'all').toLowerCase();

      let orders = [];
      if (typeFilter === 'all' || typeFilter === 'order') {
        if (isDatabaseConnected()) {
          orders = await OrderModel.find({}).sort({ created_at: -1 }).limit(500).lean();
        } else {
          orders = store.orders || [];
        }
      }

      let appointments = [];
      if (typeFilter === 'all' || typeFilter === 'appointment') {
        if (isDatabaseConnected()) {
          appointments = await AppointmentModel.find({}).sort({ created_at: -1 }).limit(500).lean();
        } else {
          appointments = store.appointments || [];
        }
      }

      const orderPayments = orders.map((o) => ({
        id: `PAY-ORD-${o.order_id}`,
        type: 'Order',
        reference_id: o.order_id,
        opd_token: null,
        customer_name: o.customer?.name || 'Customer',
        customer_phone: o.customer?.phone || '',
        customer_email: o.customer?.email || '',
        amount: o.pricing?.total || 0,
        gateway: o.payment?.gateway || 'razorpay',
        method: o.payment?.gateway === 'cod' ? 'Cash on Delivery' : 'Online / UPI',
        status: o.payment?.payment_status || 'Pending',
        transaction_id: o.payment?.transaction_id || null,
        intent_id: o.payment?.payment_intent_id || null,
        refund_status: o.payment?.refund_status || '',
        refund_amount: Number(o.payment?.refund_amount) || 0,
        refund_pending_amount: Number(o.payment?.refund_pending_amount) || 0,
        refunds: o.payment?.refunds || [],
        created_at: o.payment?.paid_at || o.created_at || new Date(),
      }));

      const appointmentPayments = appointments.map((a) => ({
        id: `PAY-APT-${a.id}`,
        type: 'Appointment',
        reference_id: a.id,
        opd_token: a.opd_token || null,
        customer_name: a.patient_code || 'Patient',
        customer_phone: '',
        customer_email: '',
        amount: a.consultation_fee != null ? Number(a.consultation_fee) : (a.payment_status === 'Waived' ? 0 : 0),
        gateway: String(a.payment_method || '').toLowerCase() === 'razorpay' ? 'razorpay' : 'offline',
        method: a.payment_method || (a.payment_transaction_id ? 'Razorpay' : 'Pay at clinic'),
        status: a.payment_status || 'Pending',
        transaction_id: a.payment_transaction_id || null,
        intent_id: null,
        refund_status: a.refund_status || '',
        refund_amount: Number(a.refund_amount) || 0,
        refund_pending_amount: Number(a.refund_pending_amount) || 0,
        refunds: a.refunds || [],
        created_at: a.payment_time || a.created_at || new Date(),
      }));

      if (appointmentPayments.length > 0 && this.userRepository) {
        try {
          const userIds = [...new Set(appointments.map((a) => a.userId).filter(Boolean))];
          const usersMap = {};
          const users = this.userRepository.findByIds
            ? await this.userRepository.findByIds(userIds)
            : await Promise.all(userIds.map((uid) => this.userRepository.findById(uid)));
          for (const user of users) {
            if (user) usersMap[user.id] = user;
          }
          for (let i = 0; i < appointments.length; i++) {
            const apt = appointments[i];
            const u = usersMap[apt.userId];
            if (u && appointmentPayments[i]) {
              appointmentPayments[i].customer_name = u.name || apt.patient_code || 'Patient';
              appointmentPayments[i].customer_phone = u.phone || '';
              appointmentPayments[i].customer_email = u.email || '';
            }
          }
        } catch (_) {}
      }

      let allPayments = [...orderPayments, ...appointmentPayments];

      if (statusFilter !== 'all') {
        allPayments = allPayments.filter((p) => String(p.status).toLowerCase() === statusFilter);
      }

      if (search) {
        allPayments = allPayments.filter((p) =>
          String(p.reference_id || '').toLowerCase().includes(search) ||
          String(p.customer_name || '').toLowerCase().includes(search) ||
          String(p.customer_phone || '').toLowerCase().includes(search) ||
          (p.transaction_id && String(p.transaction_id).toLowerCase().includes(search)) ||
          (p.opd_token && String(p.opd_token).toLowerCase().includes(search))
        );
      }

      allPayments.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      const netAmount = (payment) => Math.max(0, (Number(payment.amount) || 0) - (Number(payment.refund_amount) || 0));
      const collected = allPayments.filter((p) => ['Paid', 'Partially refunded'].includes(p.status));
      const total_collected = collected.reduce((sum, p) => sum + netAmount(p), 0);
      const order_revenue = collected
        .filter((p) => p.type === 'Order')
        .reduce((sum, p) => sum + netAmount(p), 0);
      const appointment_revenue = collected
        .filter((p) => p.type === 'Appointment')
        .reduce((sum, p) => sum + netAmount(p), 0);
      const paid_count = allPayments.filter((p) => p.status === 'Paid').length;

      const total = allPayments.length;
      const startIndex = (page - 1) * limit;
      const items = allPayments.slice(startIndex, startIndex + limit);

      return sendSuccess(res, {
        data: {
          items,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
          },
          summary: {
            total_collected,
            order_revenue,
            appointment_revenue,
            paid_count,
            total_transactions: total,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  };
}
