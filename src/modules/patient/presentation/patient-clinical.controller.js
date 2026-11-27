import { createHash } from 'node:crypto';
import { AppError, BadRequestError, NotFoundError } from '../../../shared/errors/index.js';
import { sendSuccess } from '../../../shared/utils/response.js';
import { createClinicalReportDownloadUrl } from '../../admin/infrastructure/ClinicalReportStorage.js';
import { progressCheckInResponse } from '../../../shared/utils/progress-checkin-response.js';
import { normalizePatientDietSuggestions } from '../../treatment/domain/patient-diet-suggestion.js';

const toTimestamp = (value) => {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

const computeClinicalRecordEtag = ({ userId, assessments, carePlans, reports, appointments }) => {
  const fingerprint = {
    userId: String(userId ?? ''),
    assessments: (assessments || []).map((a) => [
      a.id ?? '',
      a.reference_no ?? '',
      a.status ?? '',
      toTimestamp(a.updated_at),
      toTimestamp(a.reviewed_at),
      toTimestamp(a.created_at),
      Array.isArray(a.scalp_photos) ? a.scalp_photos.filter((p) => !p.deleted_at).length : 0,
    ]),
    carePlans: (carePlans || []).map((p) => [
      p.id ?? '',
      p.reference_no ?? '',
      toTimestamp(p.updated_at),
      toTimestamp(p.created_at),
      toTimestamp(p.date),
    ]),
    reports: (reports || []).map((r) => [
      r.id ?? '',
      toTimestamp(r.updated_at),
      toTimestamp(r.created_at),
    ]),
    appointments: (appointments || []).map((apt) => [
      apt.id ?? '',
      apt.status ?? '',
      toTimestamp(apt.updated_at),
      toTimestamp(apt.created_at),
    ]),
  };
  const digest = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 32);
  return `"clinical-${digest}"`;
};

const etagMatches = (clientHeader, serverEtag) => {
  if (!clientHeader || !serverEtag) return false;
  const target = serverEtag.replace(/^W\//, '').trim();
  return String(clientHeader)
    .split(',')
    .some((tag) => {
      const clean = tag.trim();
      return clean === '*' || clean === serverEtag || clean.replace(/^W\//, '') === target;
    });
};

const publicReport = (report) => ({
  id: report.id,
  title: report.title,
  file_name: report.file_name,
  mime_type: report.mime_type,
  format: report.format,
  bytes: report.bytes,
  created_at: report.created_at,
});

export class PatientClinicalController {
  constructor({
    hairTestRepository,
    treatmentRepository,
    clinicalReportRepository,
    appointmentRepository,
    progressCheckInRepository,
    patientCareEventRepository,
    patientActivityRepository,
    imageStorage,
    submitHairTestUseCase,
    featureFlagRepository,
    assessmentProductAvailabilityService,
  }) {
    this.hairTestRepository = hairTestRepository;
    this.treatmentRepository = treatmentRepository;
    this.clinicalReportRepository = clinicalReportRepository;
    this.appointmentRepository = appointmentRepository;
    this.progressCheckInRepository = progressCheckInRepository;
    this.patientCareEventRepository = patientCareEventRepository;
    this.patientActivityRepository = patientActivityRepository;
    this.imageStorage = imageStorage;
    this.submitHairTestUseCase = submitHairTestUseCase;
    this.featureFlagRepository = featureFlagRepository;
    this.assessmentProductAvailabilityService = assessmentProductAvailabilityService;
  }

  getClinicalRecord = async (req, res, next) => {
    try {
      const userId = req.user.id;
      const [assessments, carePlans, reports, appointments] = await Promise.all([
        this.hairTestRepository?.findByUserId ? this.hairTestRepository.findByUserId(userId) : [],
        this.treatmentRepository?.findByUserId ? this.treatmentRepository.findByUserId(userId) : [],
        this.clinicalReportRepository?.listSharedByUserId
          ? this.clinicalReportRepository.listSharedByUserId(userId)
          : this.clinicalReportRepository?.listByUserId
            ? this.clinicalReportRepository.listByUserId(userId)
            : [],
        this.appointmentRepository?.listByPatient ? this.appointmentRepository.listByPatient(userId) : [],
      ]);
      const submittedAssessments = (assessments || []).filter((assessment) => assessment.status !== 'draft');
      const sharedReports = (reports || []).filter((r) => r.visibility === 'Shared' && r.scanning_status === 'clean' && !r.deleted_at);
      const etag = computeClinicalRecordEtag({
        userId,
        assessments: submittedAssessments,
        carePlans,
        reports: sharedReports,
        appointments,
      });
      if (typeof res.setHeader === 'function') {
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
      }
      const clientEtag = req.headers?.['if-none-match'] || req.headers?.['If-None-Match'];
      if (etagMatches(clientEtag, etag)) {
        return typeof res.end === 'function' ? res.status(304).end() : res.status(304).json(null);
      }

      return sendSuccess(res, {
        data: {
          assessments: await Promise.all(
            submittedAssessments
              .map(async (assessment) => ({
                ...assessment,
                status: assessment.status || 'submitted',
                status_history: assessment.status_history || [],
                scalp_photos: await Promise.all((assessment.scalp_photos || []).filter((photo) => !photo.deleted_at).map(async (photo) => ({
                  ...photo,
                  url: photo.delivery_type === 'authenticated'
                    ? this.imageStorage.createPrivateDownloadUrl(photo.file_name, photo.format)
                    : photo.url,
                  url_expires_in_seconds: photo.delivery_type === 'authenticated' ? 300 : null,
                }))),
              }))
          ),
          care_plans: carePlans.map((plan) => ({ ...(typeof plan.toResponse === 'function' ? plan.toResponse() : plan), reference_no: plan.reference_no })),
          reports: sharedReports.map(publicReport),
          appointments,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  listCareEvents = async (req, res, next) => {
    try {
      const from = String(req.query?.from || '');
      const to = String(req.query?.to || '');
      const isDateKey = (value) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const parsed = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      };
      if (!isDateKey(from) || !isDateKey(to) || from > to) {
        throw new BadRequestError('from and to must be valid YYYY-MM-DD dates with from on or before to.');
      }
      const dayCount = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
      if (dayCount > 93) throw new BadRequestError('Care event history range cannot exceed 93 days.');
      const items = await this.patientCareEventRepository?.listByUserId?.(req.user.id, { from, to }) || [];
      return sendSuccess(res, { data: { items } });
    } catch (error) { next(error); }
  };

  saveCareEvent = async (req, res, next) => {
    try {
      const body = req.body || {};
      const event_type = String(body.event_type || '');
      const event_key = String(body.event_key || '').trim();
      const event_date = String(body.event_date || '');
      const status = String(body.status || '');
      const value = body.value == null ? null : Number(body.value);
      const isDateKey = /^\d{4}-\d{2}-\d{2}$/.test(event_date) && new Date(`${event_date}T00:00:00Z`).toISOString().slice(0, 10) === event_date;
      if (!isDateKey) throw new BadRequestError('event_date must use a valid YYYY-MM-DD date.');
      if (!['routine', 'diet', 'water', 'symptom'].includes(event_type)) throw new BadRequestError('event_type is invalid.');
      if (!/^[a-zA-Z0-9_:.\-]{1,160}$/.test(event_key)) throw new BadRequestError('event_key must be a stable identifier.');
      if ((event_type === 'routine' || event_type === 'diet') && !['pending', 'completed', 'skipped'].includes(status)) {
        throw new BadRequestError('Routine and diet events must be pending, completed, or skipped.');
      }
      if ((event_type === 'water' || event_type === 'symptom') && status !== 'logged') {
        throw new BadRequestError('Water and symptom events must use logged status.');
      }
      if (event_type === 'water' && (!Number.isInteger(value) || value < 0 || value > 20)) {
        throw new BadRequestError('Water value must be a whole number from 0 to 20.');
      }
      const severity = String(body.severity || '');
      if (event_type === 'symptom' && !['mild', 'moderate', 'severe'].includes(severity)) {
        throw new BadRequestError('Symptom severity must be mild, moderate, or severe.');
      }
      const validSymptoms = new Set(['itching', 'pain', 'burning', 'redness', 'sores', 'increased_shedding', 'other']);
      const symptoms = Array.isArray(body.symptoms)
        ? [...new Set(body.symptoms.map((item) => String(item).toLowerCase()))]
        : [];
      if (event_type === 'symptom' && (symptoms.length === 0 || symptoms.length > 7 || symptoms.some((item) => !validSymptoms.has(item)))) {
        throw new BadRequestError('Choose one to seven supported symptom labels.');
      }
      const note = String(body.note || '').trim();
      if (['routine', 'diet'].includes(event_type) && status === 'skipped' && note.length > 240) throw new BadRequestError('Skip reason must be 240 characters or fewer.');
      if (event_type === 'symptom' && note.length > 1000) throw new BadRequestError('Symptom note must be 1000 characters or fewer.');

      const event = await this.patientCareEventRepository.upsert({
        userId: Number(req.user.id), event_date, event_type, event_key, status,
        value: event_type === 'water' ? value : null,
        severity: event_type === 'symptom' ? severity : '',
        symptoms: event_type === 'symptom' ? symptoms : [],
        note: ['routine', 'diet', 'symptom'].includes(event_type) ? note : '',
      });
      const clinicianContactRecommended = event_type === 'symptom' && (
        severity === 'severe' || symptoms.some((item) => ['pain', 'burning', 'sores'].includes(item))
      );
      return sendSuccess(res, {
        message: 'Daily care check-in saved.',
        data: {
          item: event,
          clinician_contact_recommended: clinicianContactRecommended,
          next_step: clinicianContactRecommended ? 'contact_clinic' : 'continue_plan',
        },
      });
    } catch (error) { next(error); }
  };

  savePatientDietSuggestions = async (req, res, next) => {
    try {
      const userId = Number(req.user?.id);
      const referenceNo = String(req.body?.reference_no || '').trim();
      if (!referenceNo || referenceNo.length > 100) {
        throw new BadRequestError('A valid assessment reference is required.');
      }
      const assessment = await this.hairTestRepository?.findByReferenceNo?.(referenceNo);
      if (!assessment || Number(assessment.userId) !== userId) {
        throw new NotFoundError('Assessment not found.');
      }
      const suggestions = normalizePatientDietSuggestions(req.body?.suggestions);
      const updated = await this.treatmentRepository.updatePatientDietSuggestions(
        userId,
        referenceNo,
        suggestions,
      );
      return sendSuccess(res, {
        message: 'Food suggestions saved to your diet plan.',
        data: { patient_diet_suggestions: updated.patient_diet_suggestions || [] },
      });
    } catch (error) {
      next(error);
    }
  };

  getHomeSummary = async (req, res, next) => {
    try {
      const userId = req.user.id;
      const [assessments, draft, carePlans, reports, appointments, shopFlag, aptFlag] = await Promise.all([
        this.hairTestRepository?.findByUserId ? this.hairTestRepository.findByUserId(userId) : [],
        this.hairTestRepository?.getDraft ? this.hairTestRepository.getDraft(userId) : null,
        this.treatmentRepository?.findByUserId ? this.treatmentRepository.findByUserId(userId) : [],
        this.clinicalReportRepository?.listSharedByUserId
          ? this.clinicalReportRepository.listSharedByUserId(userId)
          : this.clinicalReportRepository?.listByUserId
            ? this.clinicalReportRepository.listByUserId(userId)
            : [],
        this.appointmentRepository?.listByPatient ? this.appointmentRepository.listByPatient(userId) : [],
        this.featureFlagRepository?.evaluate
          ? Promise.resolve(this.featureFlagRepository.evaluate('shop', { platform: 'patient' })).catch(() => null)
          : null,
        this.featureFlagRepository?.evaluate
          ? Promise.resolve(this.featureFlagRepository.evaluate('clinic_appointment', { platform: 'patient' })).catch(() => null)
          : null,
      ]);

      const shopEnabled = shopFlag ? shopFlag.enabled !== false : true;
      const clinicAppointmentEnabled = aptFlag && aptFlag.enabled === false ? false : true;

      const submittedAssessments = (assessments || [])
        .filter((a) => a.status !== 'draft')
        .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      const latestAssessment = submittedAssessments[0] || null;

      const sharedReports = (reports || [])
        .filter((r) => r.visibility === 'Shared' && r.scanning_status === 'clean' && !r.deleted_at)
        .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      const latestSharedReport = sharedReports[0] || null;

      const activeCarePlans = (carePlans || [])
        .sort((a, b) => new Date(b.created_at || b.date || 0).getTime() - new Date(a.created_at || a.date || 0).getTime());
      const latestCarePlan = activeCarePlans[0] || null;

      const actionCards = [];

      // Check clinical urgency / next step from assessment
      const aiAssessment = latestAssessment?.ai_assessment || null;
      const nextStep = aiAssessment?.next_step_recommendation;
      const nextStepType = nextStep?.type || (
        /stage\s*[- ]?\s*[45]|patchy/i.test(latestAssessment?.hair_loss_stage || '') ? 'doctor_appointment' : ''
      );
      const isClinicianRequired =
        aiAssessment?.ai_status === 'clinician_review_required' ||
        aiAssessment?.requiresClinician === true ||
        nextStepType === 'doctor_appointment' ||
        /stage\s*[- ]?\s*[45]|patchy/i.test(latestAssessment?.hair_loss_stage || '');

      // PRIORITY 1: Clinician-required / urgent next step
      if (isClinicianRequired) {
        actionCards.push({
          id: 'card_clinician_urgent',
          type: 'clinician_urgent',
          priority: 1,
          title: 'Clinician Consultation Recommended',
          body: nextStep?.reason || 'Based on your clinical assessment answers and hair loss pattern, a consultation with a clinical doctor is advised before starting care.',
          action_label: clinicAppointmentEnabled ? 'Book Clinic Visit' : 'Contact Clinic',
          destination: {
            type: 'route',
            route: clinicAppointmentEnabled ? '/clinic-appointment' : '/contact',
            fallback: 'whatsapp',
          },
          why_shown: 'Authoritative recommendation based on your hair assessment',
          created_at: latestAssessment?.created_at || new Date().toISOString(),
        });
      }

      // PRIORITY 2: Pending user actions
      // A. Incomplete assessment draft
      const draftFormData = draft?.formData || draft || {};
      const hasDraftData = Object.keys(draftFormData).length > 0 && !latestAssessment;
      if (hasDraftData) {
        actionCards.push({
          id: 'card_pending_assessment',
          type: 'pending_assessment',
          priority: 2,
          title: 'Complete Your Hair Assessment',
          body: 'You have an assessment in progress. Finish answering the questions to receive your clinical evaluation.',
          action_label: 'Continue Assessment',
          destination: {
            type: 'route',
            route: '/hair-test',
          },
          why_shown: 'Unfinished assessment draft found in your account',
          created_at: draft?.updated_at || new Date().toISOString(),
        });
      }

      // B. Appointment awaiting user action
      const pendingAppointments = (appointments || []).filter((apt) =>
        ['pending', 'payment_pending', 'awaiting_confirmation', 'action_required'].includes(String(apt.status || '').toLowerCase())
      );
      if (pendingAppointments.length > 0) {
        const apt = pendingAppointments[0];
        actionCards.push({
          id: `card_pending_appointment_${apt.id}`,
          type: 'pending_appointment',
          priority: 2,
          title: 'Appointment Awaiting Confirmation',
          body: `Your clinic appointment for ${apt.reason || 'Consultation'} is pending confirmation.`,
          action_label: 'View Appointment',
          destination: {
            type: 'route',
            route: '/appointments',
            entity_id: String(apt.id),
          },
          entity_id: String(apt.id),
          why_shown: 'Scheduled appointment requires your attention',
          created_at: apt.created_at || new Date().toISOString(),
        });
      }

      // PRIORITY 3: Newly shared admin report
      if (sharedReports.length > 0) {
        const latestReport = sharedReports[0];
        actionCards.push({
          id: `card_shared_report_${latestReport.id}`,
          type: 'shared_report',
          priority: 3,
          title: 'New Report from Clinic',
          body: `${latestReport.title} is available in your clinical record. Tap to view your verified results.`,
          action_label: 'Open Report',
          destination: {
            type: 'report',
            route: '/treatment-details',
            entity_id: String(latestReport.id),
          },
          entity_id: String(latestReport.id),
          why_shown: 'Uploaded and shared by your clinical team',
          created_at: latestReport.created_at || new Date().toISOString(),
        });
      }

      // PRIORITY 4: Actual doctor-authored care plan
      if (latestCarePlan) {
        actionCards.push({
          id: `card_care_plan_${latestCarePlan.id}`,
          type: 'care_plan',
          priority: 4,
          title: 'Your Care Plan',
          body: latestCarePlan.treatment_name || 'Your personalized treatment plan from your clinician.',
          action_label: 'View Plan',
          destination: {
            type: 'route',
            route: '/treatment-details',
            entity_id: String(latestCarePlan.id),
          },
          entity_id: String(latestCarePlan.id),
          why_shown: latestCarePlan.doctor_name ? `Prescribed by ${latestCarePlan.doctor_name}` : 'Prescribed by your clinician',
          created_at: latestCarePlan.created_at || latestCarePlan.date || new Date().toISOString(),
        });
      }

      // PRIORITY 5: Assessment-specific product suggestions
      // Only when shop is enabled, NOT clinician priority, and available products present
      let availableProducts = Array.isArray(aiAssessment?.available_products) ? aiAssessment.available_products : [];
      if (shopEnabled && !isClinicianRequired && availableProducts.length > 0) {
        actionCards.push({
          id: 'card_product_suggestions',
          type: 'product_suggestions',
          priority: 5,
          title: 'Recommended Care Products',
          body: 'Targeted products selected to support your specific hair profile.',
          action_label: 'View Products',
          destination: {
            type: 'route',
            route: '/products',
          },
          products: availableProducts,
          why_shown: 'Matched to your hair assessment answers',
          created_at: latestAssessment?.created_at || new Date().toISOString(),
        });
      }

      // PRIORITY 6: Appointment suggestion
      // Only when recommendation calls for it, clinic appointments are enabled, and not already clinician_urgent
      if (clinicAppointmentEnabled && !isClinicianRequired && nextStepType === 'doctor_appointment') {
        actionCards.push({
          id: 'card_appointment_suggestion',
          type: 'appointment_suggestion',
          priority: 6,
          title: 'Book a Clinic Consultation',
          body: nextStep?.reason || 'Consult in-clinic with our medical specialists for an in-depth scalp examination.',
          action_label: 'Book Appointment',
          destination: {
            type: 'route',
            route: '/clinic-appointment',
          },
          why_shown: 'Recommended based on your hair test assessment',
          created_at: latestAssessment?.created_at || new Date().toISOString(),
        });
      }

      actionCards.sort((a, b) => a.priority - b.priority);

      const assessmentReviewComplete = Boolean(
        latestAssessment && (
          latestAssessment.status === 'reviewed' ||
          (!isClinicianRequired && latestAssessment.status !== 'under_review')
        )
      );
      const isUnderReview = Boolean(
        latestAssessment && latestAssessment.status === 'under_review'
      );
      const isReviewed = Boolean(
        latestAssessment && latestAssessment.status === 'reviewed'
      );
      const showExpertReviewCard = Boolean(
        latestAssessment && !assessmentReviewComplete
      );
      const showTodayCard = Boolean(
        latestAssessment && assessmentReviewComplete
      );

      // Smart real-time reminders
      const reminders = [];
      if (hasDraftData) {
        reminders.push({
          id: 'rem_pending_draft',
          type: 'assessment_draft',
          title: 'Hair Assessment Pending',
          message: 'Complete your hair assessment to receive your clinical diagnosis.',
          action_route: '/hair-test',
          priority: 'high',
        });
      }
      if (isUnderReview) {
        reminders.push({
          id: 'rem_under_review',
          type: 'assessment_under_review',
          title: 'Assessment Under Review',
          message: 'Our clinical team is reviewing your scalp test photos and answers.',
          action_route: '/assessment-result',
          priority: 'medium',
        });
      }
      if (latestCarePlan) {
        reminders.push({
          id: 'rem_care_plan',
          type: 'care_plan_routine',
          title: 'Daily Care Routine',
          message: `Follow your prescribed care routine: ${latestCarePlan.treatment_name || 'Hair Care Plan'}.`,
          action_route: '/treatment-details',
          priority: 'low',
        });
      }
      if (pendingAppointments.length > 0) {
        const apt = pendingAppointments[0];
        reminders.push({
          id: `rem_apt_${apt.id}`,
          type: 'appointment_pending',
          title: 'Appointment Requires Action',
          message: `Your appointment for ${apt.reason || 'Consultation'} needs confirmation.`,
          action_route: '/appointments',
          priority: 'high',
        });
      }
      if (latestSharedReport) {
        reminders.push({
          id: `rem_rpt_${latestSharedReport.id}`,
          type: 'shared_report',
          title: 'New Clinical Report Available',
          message: `${latestSharedReport.title} is ready to view.`,
          action_route: '/treatment-details',
          priority: 'low',
        });
      }

      return sendSuccess(res, {
        data: {
          action_cards: actionCards,
          assessment: latestAssessment ? {
            id: String(latestAssessment.id),
            reference_no: latestAssessment.reference_no || String(latestAssessment.id),
            status: latestAssessment.status,
            is_reviewed: isReviewed,
            is_under_review: isUnderReview,
            requires_clinician: Boolean(isClinicianRequired),
            doctor_review_complete: isReviewed,
            ai_review_complete: !isClinicianRequired && !isUnderReview,
            assessment_review_complete: assessmentReviewComplete,
            show_expert_review_card: showExpertReviewCard,
            show_today_card: showTodayCard,
            scalp_health_score: aiAssessment?.scalp_health_score ?? null,
            hair_loss_stage: latestAssessment.hair_loss_stage || aiAssessment?.hair_loss_stage || null,
            hair_loss_type: latestAssessment.hair_loss_type || aiAssessment?.hair_loss_type || null,
            doctor_name: latestAssessment.reviewer_name || latestCarePlan?.doctor_name || 'Dr. Jai Bansal',
            doctor_review_note: latestAssessment.reviewer_notes || latestAssessment.review_notes || null,
            created_at: latestAssessment.created_at || null,
            reviewed_at: latestAssessment.reviewed_at || null,
          } : null,
          latest_report: latestSharedReport ? {
            id: String(latestSharedReport.id),
            title: latestSharedReport.title || 'Clinical Report',
            file_name: latestSharedReport.file_name || 'report',
            bytes: latestSharedReport.bytes || 0,
            uploaded_by: latestSharedReport.uploaded_by || 'Dr. Jai Bansal',
            created_at: latestSharedReport.created_at || new Date().toISOString(),
            mime_type: latestSharedReport.mime_type || '',
          } : null,
          reports_summary: {
            total_count: (reports || []).length,
            shared_count: sharedReports.length,
            latest_shared_id: latestSharedReport ? String(latestSharedReport.id) : null,
            latest_shared_title: latestSharedReport?.title || null,
            latest_shared_at: latestSharedReport?.created_at || null,
            has_new_report: sharedReports.length > 0,
          },
          reminders,
          patient_status: {
            has_completed_assessment: Boolean(latestAssessment),
            assessment_status: latestAssessment?.status || (hasDraftData ? 'draft' : 'none'),
            is_reviewed: isReviewed,
            is_under_review: isUnderReview,
            show_expert_review_card: showExpertReviewCard,
            show_today_card: showTodayCard,
            doctor_review_complete: isReviewed,
            assessment_review_complete: assessmentReviewComplete,
            has_active_care_plan: Boolean(latestCarePlan),
            shared_reports_count: sharedReports.length,
            upcoming_appointments_count: (appointments || []).filter((a) => !['cancelled', 'completed'].includes(String(a.status).toLowerCase())).length,
          },
          feature_flags: {
            shop_enabled: shopEnabled,
            clinic_appointment_enabled: clinicAppointmentEnabled,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  };

  getAssessmentDraft = async (req, res, next) => {
    try {
      const draft = await this.hairTestRepository.getDraft(req.user.id);
      return sendSuccess(res, { data: { draft } });
    } catch (error) {
      next(error);
    }
  };

  saveAssessmentDraft = async (req, res, next) => {
    try {
      const body = req.body || {};
      const formData = body.formData || body;
      const step = typeof body.step === 'number' ? body.step : 0;
      const draft = await this.hairTestRepository.saveDraft(req.user.id, formData, step);
      return sendSuccess(res, { message: 'Assessment draft saved.', data: { draft } });
    } catch (error) {
      next(error);
    }
  };

  deleteAssessmentDraft = async (req, res, next) => {
    try {
      await this.hairTestRepository.deleteDraft(req.user.id);
      return sendSuccess(res, { message: 'Assessment draft deleted.' });
    } catch (error) {
      next(error);
    }
  };

  submitAssessment = async (req, res, next) => {
    try {
      const userId = req.user.id;
      let formData = req.body || {};
      if ((!formData || Object.keys(formData).length === 0 || formData.use_draft) && this.hairTestRepository?.getDraft) {
        const draft = await this.hairTestRepository.getDraft(userId);
        if (draft?.formData) {
          formData = { ...draft.formData, ...formData };
        }
      }
      if (!this.submitHairTestUseCase) {
        throw new AppError('Assessment submission is currently unavailable.', 503);
      }
      const result = await this.submitHairTestUseCase.execute({
        userId,
        formData,
        files: req.files || {},
      });
      if (this.patientActivityRepository?.record) {
        await this.patientActivityRepository.record({
          userId,
          type: 'assessment',
          title: 'Hair assessment submitted',
          summary: result.reference_no,
          actor: 'Patient app',
          metadata: { reference_no: result.reference_no },
        }).catch(() => null);
      }
      return sendSuccess(res, {
        message: result.message,
        statusCode: 201,
        data: {
          reference_no: result.reference_no,
          test: result.test,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  listProgressCheckIns = async (req, res, next) => {
    try {
      const items = await this.progressCheckInRepository.listByUserId(req.user.id);
      return sendSuccess(res, { data: { items: await Promise.all(items.map((item) => progressCheckInResponse(item, this.imageStorage))) } });
    } catch (error) { next(error); }
  };

  createProgressCheckIn = async (req, res, next) => {
    let cleanPhotos = [];
    let persisted = false;
    try {
      const userId = Number(req.user.id);
      const body = req.body || {};
      const id = String(body.id || '').trim();
      const date = new Date(body.date);
      const photos = body.photos;
      const allowedAngles = new Set(['front', 'top', 'back']);
      if (!/^[a-zA-Z0-9_-]{5,80}$/.test(id)) throw new BadRequestError('A valid progress check-in ID is required.');
      if (!body.date || Number.isNaN(date.getTime())) throw new BadRequestError('A valid check-in date is required.');
      if (!Array.isArray(photos) || photos.length < 1 || photos.length > 3) throw new BadRequestError('Attach one to three progress photos uploaded through the media API.');
      const seenAngles = new Set();
      const ownedPrefix = `drhair/images/user-${userId}/progress/`;
      for (const photo of photos) {
        const angle = String(photo?.angle || '').toLowerCase();
        const publicId = String(photo?.public_id || '').trim();
        if (!allowedAngles.has(angle) || seenAngles.has(angle)) throw new BadRequestError('Each photo needs one unique front, top, or back angle.');
        if (!publicId.startsWith(ownedPrefix) || publicId.includes('..')) {
          throw new BadRequestError('Progress photos must be uploaded to this patient’s progress media folder.');
        }
        let asset = req._directProgressAssets?.get(publicId);
        if (!asset) {
          try { asset = await this.imageStorage.getAuthenticatedImage(publicId); }
          catch { throw new BadRequestError('Progress photos must reference private images uploaded to this patient’s progress media folder.'); }
        }
        if (asset.type !== 'authenticated' || asset.public_id !== publicId || !Number.isFinite(asset.bytes) || asset.bytes <= 0) {
          throw new BadRequestError('Progress photos must reference private images uploaded to this patient’s progress media folder.');
        }
        seenAngles.add(angle);
        cleanPhotos.push({
          angle,
          public_id: publicId,
          url: asset.secure_url,
          delivery_type: 'authenticated',
          format: asset.format,
          file_name: String(photo.file_name || '').trim().slice(0, 180),
          mime_type: `image/${asset.format === 'jpg' ? 'jpeg' : asset.format}`.slice(0, 80),
          bytes: asset.bytes,
        });
      }
      const result = await this.progressCheckInRepository.createOnce({
        id,
        userId,
        date,
        scalp_region: String(body.scalp_region || 'Scalp').trim().slice(0, 100),
        shedding_level: String(body.shedding_level || 'Not recorded').trim().slice(0, 100),
        notes: String(body.notes || '').trim().slice(0, 2000),
        density_rating: Math.max(1, Math.min(5, Number(body.density_rating) || 3)),
        photos: cleanPhotos,
      });
      persisted = true;
      if (result.created) {
        try {
          await this.patientActivityRepository.record({ userId, type: 'progress', title: 'Daily progress photos uploaded', summary: `${cleanPhotos.length} photo${cleanPhotos.length === 1 ? '' : 's'} · ${result.item.scalp_region}`, actor: 'Patient app', metadata: { check_in_id: result.item.id } });
        } catch { /* progress persistence must not fail because an activity event could not be recorded */ }
      } else {
        const retainedIds = new Set((result.item.photos || []).map((photo) => photo.public_id));
        await Promise.all(cleanPhotos
          .filter((photo) => !retainedIds.has(photo.public_id))
          .map((photo) => this.imageStorage.deleteImage(photo.public_id, { deliveryType: photo.delivery_type }).catch(() => null)));
      }
      return sendSuccess(res, { message: 'Progress check-in saved to your clinical record.', statusCode: result.created ? 201 : 200, data: { item: await progressCheckInResponse(result.item, this.imageStorage) } });
    } catch (error) {
      if (!persisted && cleanPhotos.length > 0) {
        await Promise.all(cleanPhotos.map((photo) => this.imageStorage.deleteImage(photo.public_id, { deliveryType: photo.delivery_type }).catch(() => null)));
        if (req._directProgressAssets) {
          req._patientMediaCleanedKeys = new Set(cleanPhotos.map((photo) => photo.public_id));
        }
      }
      next(error);
    }
  };

  deleteProgressPhoto = async (req, res, next) => {
    try {
      const angle = String(req.params.angle || '').toLowerCase();
      if (!['front', 'top', 'back'].includes(angle)) throw new BadRequestError('angle must be front, top, or back.');
      const photo = await this.progressCheckInRepository.removePhoto(req.user.id, req.params.checkInId, angle);
      if (!photo) throw new NotFoundError('Progress photo was not found.');
      try {
        await this.imageStorage.deleteImage(photo.public_id, { deliveryType: photo.delivery_type || 'upload' });
      } catch {
        await this.progressCheckInRepository.restorePhoto(req.user.id, req.params.checkInId, photo);
        throw new AppError('The photo could not be deleted from storage. The clinical record was restored; retry later.', 503);
      }
      return sendSuccess(res, { message: 'Progress photo deleted from storage and the clinical record.' });
    } catch (error) {
      next(error);
    }
  };

  deleteProgressCheckIn = async (req, res, next) => {
    try {
      const userId = Number(req.user.id);
      const checkInId = req.params.checkInId;
      const checkIn = await this.progressCheckInRepository.findById(userId, checkInId);
      if (!checkIn) throw new NotFoundError('Progress check-in not found.');

      if (Array.isArray(checkIn.photos)) {
        await Promise.all(
          checkIn.photos.map((photo) =>
            this.imageStorage.deleteImage(photo.public_id, { deliveryType: photo.delivery_type || 'authenticated' }).catch(() => null)
          )
        );
      }
      await this.progressCheckInRepository.removeCheckIn(userId, checkInId);
      if (this.patientActivityRepository?.record) {
        await this.patientActivityRepository.record({
          userId,
          type: 'progress',
          title: 'Progress check-in deleted',
          summary: `Check-in ${checkInId} removed`,
          actor: 'Patient app',
          metadata: { check_in_id: checkInId },
        }).catch(() => null);
      }
      return sendSuccess(res, { message: 'Progress check-in removed from clinical record.' });
    } catch (error) {
      next(error);
    }
  };

  downloadReport = async (req, res, next) => {
    try {
      const report = await this.clinicalReportRepository.findByUserIdAndId(req.user.id, req.params.reportId);
      if (!report || report.visibility !== 'Shared' || report.scanning_status !== 'clean') throw new NotFoundError('Patient report not found.');
      return sendSuccess(res, {
        data: {
          url: createClinicalReportDownloadUrl(report.public_id, report.format),
          expires_in_seconds: 60,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  getRoutineSteps = async (req, res, next) => {
    try {
      const userId = Number(req.user.id);
      const steps = this.treatmentRepository?.getRoutineSteps
        ? await this.treatmentRepository.getRoutineSteps(userId)
        : [];
      return sendSuccess(res, {
        data: {
          routine_steps: steps,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  addRoutineStep = async (req, res, next) => {
    try {
      const userId = Number(req.user.id);
      const { title, subtitle, category, time_of_day } = req.body || {};
      if (!title || typeof title !== 'string' || !title.trim()) {
        throw new BadRequestError('Care step title is required.');
      }

      const step = {
        title: title.trim().slice(0, 150),
        subtitle: typeof subtitle === 'string' ? subtitle.trim().slice(0, 300) : '',
        category: typeof category === 'string' ? category.trim().slice(0, 80) : 'Lifestyle',
        time_of_day: typeof time_of_day === 'string' ? time_of_day.trim().slice(0, 50) : 'Daily',
        created_by: 'patient',
      };

      const updated = this.treatmentRepository?.addRoutineStep
        ? await this.treatmentRepository.addRoutineStep(userId, step)
        : [step];

      if (this.patientActivityRepository?.record) {
        await this.patientActivityRepository.record({
          userId,
          type: 'routine',
          title: 'Care routine step added',
          summary: step.title,
          actor: 'Patient app',
          metadata: { step_title: step.title },
        }).catch(() => null);
      }

      return sendSuccess(res, {
        message: 'Care routine step added successfully.',
        statusCode: 201,
        data: {
          routine_steps: updated,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  deleteRoutineStep = async (req, res, next) => {
    try {
      const userId = Number(req.user.id);
      const stepIndex = parseInt(req.params.stepIndex, 10);
      if (Number.isNaN(stepIndex) || stepIndex < 0) {
        throw new BadRequestError('A valid step index is required.');
      }

      const updated = this.treatmentRepository?.removeRoutineStep
        ? await this.treatmentRepository.removeRoutineStep(userId, stepIndex)
        : [];

      return sendSuccess(res, {
        message: 'Care routine step removed.',
        data: {
          routine_steps: updated,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  getReminders = async (req, res, next) => {
    try {
      const userId = Number(req.user.id);
      const reminders = this.treatmentRepository?.getReminders
        ? await this.treatmentRepository.getReminders(userId)
        : [];
      return sendSuccess(res, {
        data: {
          reminders,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  saveReminder = async (req, res, next) => {
    try {
      const userId = Number(req.user.id);
      const body = req.body || {};
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) {
        throw new BadRequestError('Care reminder title is required.');
      }

      const reminder = {
        id: String(body.id || `rem_${Date.now()}`),
        title: title.slice(0, 150),
        subtitle: typeof body.subtitle === 'string' ? body.subtitle.trim().slice(0, 300) : '',
        time: typeof body.time === 'string' ? body.time.trim().slice(0, 20) : '20:00',
        hour: typeof body.hour === 'number' ? body.hour : 20,
        minute: typeof body.minute === 'number' ? body.minute : 0,
        isEnabled: body.isEnabled !== false,
        frequency: typeof body.frequency === 'string' ? body.frequency.trim().slice(0, 50) : 'Daily',
        treatmentType: typeof body.treatmentType === 'string' ? body.treatmentType.trim().slice(0, 80) : 'Topical Serum',
        repeatDays: Array.isArray(body.repeatDays) ? body.repeatDays.map(Number).filter((d) => d >= 1 && d <= 7) : [1, 2, 3, 4, 5, 6, 7],
        isCompleted: Boolean(body.isCompleted),
        notes: typeof body.notes === 'string' ? body.notes.trim().slice(0, 500) : '',
        snoozedUntil: body.snoozedUntil || null,
      };

      const updated = this.treatmentRepository?.saveReminder
        ? await this.treatmentRepository.saveReminder(userId, reminder)
        : [reminder];

      return sendSuccess(res, {
        message: 'Care reminder saved successfully.',
        statusCode: 200,
        data: {
          reminder,
          reminders: updated,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  deleteReminder = async (req, res, next) => {
    try {
      const userId = Number(req.user.id);
      const reminderId = String(req.params.reminderId || '').trim();
      if (!reminderId) {
        throw new BadRequestError('A valid reminder ID is required.');
      }

      const updated = this.treatmentRepository?.deleteReminder
        ? await this.treatmentRepository.deleteReminder(userId, reminderId)
        : [];

      return sendSuccess(res, {
        message: 'Care reminder removed.',
        data: {
          reminders: updated,
        },
      });
    } catch (error) {
      next(error);
    }
  };
}
