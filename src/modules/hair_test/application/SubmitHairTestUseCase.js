import { createHash } from 'node:crypto';
import { BadRequestError, ConflictError, UnauthorizedError } from '../../../shared/errors/index.js';
import { getExecutionContext } from '../../../shared/runtime/execution-context.js';

const fingerprintSubmission = (formData, files) => {
  const fields = Object.entries(formData).filter(([key]) => key !== 'submission_key')
    .sort(([a], [b]) => a.localeCompare(b));
  const images = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, entries]) => [
    name, entries.map((file) => {
      const digest = file.sha256 || (file.buffer && createHash('sha256').update(file.buffer).digest('hex'));
      if (!digest || !/^[a-f0-9]{64}$/i.test(digest)) {
        throw new BadRequestError('Unable to verify the uploaded image for a safe submission retry.');
      }
      return digest.toLowerCase();
    }),
  ]);
  return createHash('sha256').update(JSON.stringify({ fields, images })).digest('hex');
};

const publicAssessment = (test) => {
  const { submission_key: _key, request_fingerprint: _fingerprint, ...assessment } = test;
  return assessment;
};

export class SubmitHairTestUseCase {
  constructor({ hairTestRepository, imageStorage, geminiAiService, assessmentProductAvailabilityService, processQueuedAiAssessmentUseCase }) {
    this.hairTestRepository = hairTestRepository;
    this.imageStorage = imageStorage;
    this.geminiAiService = geminiAiService;
    this.assessmentProductAvailabilityService = assessmentProductAvailabilityService;
    this.processQueuedAiAssessmentUseCase = processQueuedAiAssessmentUseCase;
  }

  scheduleAssessment(referenceNo) {
    const context = getExecutionContext();
    if (!context?.waitUntil || !this.processQueuedAiAssessmentUseCase) return false;
    try {
      context.waitUntil(this.processQueuedAiAssessmentUseCase.processOne({ referenceNo }).catch(() => {
        console.error('Unable to start queued assessment; scheduled recovery remains available.');
      }));
      return true;
    } catch {
      return false;
    }
  }

  async execute(input) {
    try {
      return await this._execute(input);
    } catch (error) {
      const userPrefix = `drhair/images/user-${Number(input?.userId)}/assessment/`;
      const uploaded = Object.values(input?.files || {}).flat().filter((file) =>
        (file?.publicId || file?.key || '').startsWith(userPrefix));
      if (typeof this.imageStorage?.deleteImage === 'function') {
        await Promise.all(uploaded.map((file) => this.imageStorage.deleteImage(
          file.publicId || file.key,
          { deliveryType: 'authenticated' },
        ).catch(() => null)));
      }
      throw error;
    }
  }

  async _execute({ userId, formData, files = {} }) {
    if (!formData.full_name && !formData.name) {
      throw new BadRequestError('Full name is required.');
    }
    const submissionKey = formData.submission_key || null;
    if (submissionKey && (typeof submissionKey !== 'string' || !/^[a-f0-9]{64}$/.test(submissionKey))) {
      throw new BadRequestError('Invalid assessment submission key.');
    }
    const requestFingerprint = submissionKey ? fingerprintSubmission(formData, files) : null;
    const replay = async () => {
      if (!submissionKey || !this.hairTestRepository.findBySubmissionKey) return null;
      const existing = await this.hairTestRepository.findBySubmissionKey(userId, submissionKey);
      if (!existing) return null;
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new ConflictError(
          'An earlier assessment was already sent. Open that report before submitting your changed draft.',
          { reference_no: existing.reference_no, reason: 'ASSESSMENT_ALREADY_SUBMITTED' },
        );
      }
      const retained = new Set((existing.scalp_photos || []).flatMap((photo) => [photo.file_name, photo.optimized_file_name]).filter(Boolean));
      const prefix = `drhair/images/user-${Number(userId)}/assessment/`;
      const uploads = Object.values(files).flat().map((file) => file.publicId || file.key)
        .filter((key) => typeof key === 'string' && key.startsWith(prefix) && !retained.has(key));
      if (typeof this.imageStorage?.deleteImage === 'function') {
        await Promise.all(uploads.map((key) => this.imageStorage.deleteImage(key, { deliveryType: 'authenticated' }).catch(() => null)));
      }
      return { message: 'Assessment already submitted.', reference_no: existing.reference_no, test: publicAssessment(existing),
        ai_assessment: existing.ai_assessment, ai_assessment_status: existing.ai_assessment_status };
    };
    const existingSubmission = await replay();
    if (existingSubmission) {
      if (formData.background_ai === 'true' && existingSubmission.ai_assessment_status === 'queued') {
        this.scheduleAssessment(existingSubmission.reference_no);
      }
      return existingSubmission;
    }

    // Helper to safely parse stringified JSON array fields from multipart/form-data
    const parseJsonArray = (val) => {
      if (Array.isArray(val)) return val;
      if (typeof val === 'string' && val.trim().startsWith('[')) {
        try {
          return JSON.parse(val);
        } catch {
          return [val];
        }
      }
      return val ? [val] : [];
    };

    const boundedText = (value, field, maxLength) => {
      if (value == null || value === '') return '';
      if (typeof value !== 'string') throw new BadRequestError(`${field} must be text.`);
      const normalized = value.trim();
      if (normalized.length > maxLength) throw new BadRequestError(`${field} must be at most ${maxLength} characters.`);
      return normalized;
    };
    const allergyStatus = boundedText(formData.allergy_status, 'allergy_status', 60);
    const currentMedicationsStatus = boundedText(formData.current_medications_status, 'current_medications_status', 60);
    const allergyDetails = boundedText(formData.allergy_details, 'allergy_details', 500);
    const currentMedications = boundedText(formData.current_medications, 'current_medications', 1000);
    if (allergyStatus && !['No known allergies', 'Yes, I have allergies', 'Not sure'].includes(allergyStatus)) {
      throw new BadRequestError('Choose a valid allergy status.');
    }
    if (currentMedicationsStatus && !['No', 'Yes', 'Not sure'].includes(currentMedicationsStatus)) {
      throw new BadRequestError('Choose a valid current medicines status.');
    }
    if (allergyStatus === 'Yes, I have allergies' && !allergyDetails) {
      throw new BadRequestError('List the known allergies before submitting.');
    }
    if (currentMedicationsStatus === 'Yes' && !currentMedications) {
      throw new BadRequestError('List current medicines or supplements before submitting.');
    }

    // Process scalp photo uploads
    const scalpPhotos = [];
    // Only files staged by this request can be removed on failure. Legacy
    // references may also be used by an earlier, already-saved assessment.
    const stagedPhotoKeys = new Set();
    const photoKeys = ['photo_front', 'photo_top', 'photo_left', 'photo_right', 'photo_back'];
    let selectionOrder = [];
    if (formData.photo_selection_order != null && formData.photo_selection_order !== '') {
      try {
        selectionOrder = JSON.parse(formData.photo_selection_order);
      } catch {
        throw new BadRequestError('photo_selection_order must be a JSON array of photo field names.');
      }
      if (!Array.isArray(selectionOrder) || selectionOrder.length > photoKeys.length ||
          selectionOrder.some((key) => typeof key !== 'string' || !photoKeys.includes(key)) ||
          new Set(selectionOrder).size !== selectionOrder.length) {
        throw new BadRequestError('photo_selection_order must contain distinct valid photo field names.');
      }
    }
    const resolveOwnedPhoto = async (value, field) => {
      const val = String(value || '').trim();
      let publicId = val;
      if (val.startsWith('http://') || val.startsWith('https://')) {
        let parsedUrl;
        try {
          parsedUrl = new URL(val);
        } catch {
          throw new BadRequestError(`${field} must be a valid uploaded image URL.`);
        }
        const marker = '/api/v1/media/assets/';
        const index = parsedUrl.pathname.indexOf(marker);
        if ((parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost') || index < 0) {
          throw new BadRequestError(`${field} must point to an image uploaded through the Dr. Hair media API.`);
        }
        try {
          publicId = parsedUrl.pathname.slice(index + marker.length)
            .split('/').map(decodeURIComponent).join('/');
        } catch {
          throw new BadRequestError(`${field} contains an invalid media key.`);
        }
      }
      const ownedFolder = `drhair/images/user-${userId}/assessment/`;
      if (!publicId || !publicId.startsWith(ownedFolder) || publicId.includes('..')) {
        throw new UnauthorizedError(`${field} must belong to the authenticated patient's assessment uploads.`);
      }
      if (typeof this.imageStorage?.getAuthenticatedImage !== 'function') {
        throw new BadRequestError(`${field} cannot be verified as a private uploaded image.`);
      }
      let asset;
      try {
        asset = await this.imageStorage.getAuthenticatedImage(publicId);
      } catch {
        throw new BadRequestError(`${field} must reference a private image uploaded for this assessment.`);
      }
      if (!asset || asset.type !== 'authenticated' || asset.public_id !== publicId) {
        throw new BadRequestError(`${field} must reference a private image uploaded for this assessment.`);
      }
      return { publicId, asset };
    };

    try {
      const photoTasks = photoKeys.map((key) => {
        const uploadedFiles = files[key] || [];
        const optimizedFiles = files[`${key}_optimized`] || [];
        const suppliedValue = formData[`${key}_url`] || formData[`${key}_id`] || formData[`${key}_public_id`];
        const optimizedValue = formData[`${key}_optimized_url`] || formData[`${key}_optimized_id`];
        if ((uploadedFiles.length > 0 || optimizedFiles.length > 0) && (suppliedValue || optimizedValue)) {
          throw new BadRequestError(`Send direct files or uploaded media references for ${key}, not both.`);
        }
        if ((optimizedValue || optimizedFiles.length > 0) && !suppliedValue && uploadedFiles.length === 0) {
          throw new BadRequestError(`${key}_optimized_url requires the original ${key} image.`);
        }
        if (optimizedFiles.length > 1 || uploadedFiles.length > 1) {
          throw new BadRequestError(`Only one original and one optimized image are allowed for ${key}.`);
        }

        if (uploadedFiles[0]) {
          const sourcePixels = Number(uploadedFiles[0].width) * Number(uploadedFiles[0].height);
          if (sourcePixels > 40_000_000) {
            const optimizedPixels = Number(optimizedFiles[0]?.width) * Number(optimizedFiles[0]?.height);
            if (!optimizedFiles[0] || !Number.isFinite(optimizedPixels) || optimizedPixels <= 0 || optimizedPixels >= sourcePixels) {
              throw new BadRequestError(`${key} exceeds 40 megapixels and requires a verified, smaller optimized image.`);
            }
          }
          const persistUploadedFile = async (file, fieldName) => {
            if (file.publicId || file.key) {
              const publicId = file.publicId || file.key;
              const expectedPrefix = `drhair/images/user-${Number(userId)}/assessment/`;
              if (!publicId.startsWith(expectedPrefix)) {
                throw new UnauthorizedError(`${fieldName} must belong to the authenticated patient's assessment uploads.`);
              }
              const asset = await this.imageStorage.getAuthenticatedImage(publicId);
              stagedPhotoKeys.add(publicId);
              return {
                file_name: publicId,
                url: asset.secure_url,
                delivery_type: 'authenticated',
                format: asset.format,
                bytes: asset.bytes,
                sha256: file.sha256,
              };
            }
            const uploaded = await this.imageStorage.uploadImage(
              file.buffer,
              `user-${userId}/assessment`,
              undefined,
              { deliveryType: 'authenticated', contentType: file.mimetype || 'image/jpeg' },
            );
            stagedPhotoKeys.add(uploaded.publicId);
            const asset = await this.imageStorage.getAuthenticatedImage?.(uploaded.publicId);
            return {
              file_name: uploaded.publicId,
              url: asset?.secure_url || uploaded.secureUrl || uploaded.storageUrl,
              delivery_type: 'authenticated',
              format: asset?.format || uploaded.format,
              bytes: asset?.bytes || file.buffer.length,
            };
          };

          return async () => {
            const [original, optimized] = await Promise.all([
              persistUploadedFile(uploadedFiles[0], key),
              optimizedFiles[0] ? persistUploadedFile(optimizedFiles[0], `${key}_optimized`) : Promise.resolve(null),
            ]);
            const photo = {
              ...original,
              angle: key.replace('photo_', ''),
              verification_status: 'pending',
              verification_message: 'Visual photo review is pending with the assessment.',
            };
            if (optimized) {
              photo.optimized_file_name = optimized.file_name;
              photo.optimized_format = optimized.format;
              photo.optimized_bytes = optimized.bytes;
              photo.optimized_sha256 = optimized.sha256;
            }
            return photo;
          };
        }

        if (suppliedValue) {
          return async () => {
            const [{ publicId, asset }, optimized] = await Promise.all([
              resolveOwnedPhoto(suppliedValue, `${key}_url`),
              optimizedValue ? resolveOwnedPhoto(optimizedValue, `${key}_optimized_url`) : Promise.resolve(null),
            ]);
            const photo = {
              file_name: publicId,
              url: asset.secure_url,
              delivery_type: 'authenticated',
              format: asset.format,
              bytes: asset.bytes,
              angle: key.replace('photo_', ''),
              verification_status: 'pending',
              verification_message: 'Visual photo review is pending with the assessment.',
            };
            if (optimized) {
              photo.optimized_file_name = optimized.publicId;
              photo.optimized_format = optimized.asset.format;
              photo.optimized_bytes = optimized.asset.bytes;
            }
            return photo;
          };
        }

        return null;
      }).filter(Boolean);

      const resolvedPhotos = await Promise.all(photoTasks.map((task) => task()));
      scalpPhotos.push(...resolvedPhotos);
    } catch (error) {
      await Promise.all([...stagedPhotoKeys].map((key) => this.imageStorage.deleteImage(key, { deliveryType: 'authenticated' }).catch(() => null)));
      throw error;
    }

    if (selectionOrder.length) {
      const order = new Map(selectionOrder.map((key, index) => [key.replace('photo_', ''), index]));
      // Unknown/legacy angles precede explicitly ordered photos.
      scalpPhotos.sort((a, b) => (order.get(a.angle) ?? -1) - (order.get(b.angle) ?? -1));
    }

    let hairTest;
    try {
      hairTest = await this.hairTestRepository.create({
        userId: userId ? parseInt(userId, 10) : null,
        submission_key: submissionKey,
        request_fingerprint: requestFingerprint,
        status: 'submitted',
        full_name: formData.full_name || formData.name,
        email: formData.email,
        phone: formData.phone,
        age: formData.age ? parseInt(formData.age, 10) : null,
        gender: formData.gender,
        city: formData.city,
        occupation: formData.occupation,
        hair_fall_start: formData.hair_fall_start || formData.duration,
        duration: formData.duration || formData.hair_fall_start,
        hair_fall_pattern: formData.hair_fall_pattern,
        daily_hair_fall: formData.daily_hair_fall,
        hair_fall_increasing: formData.hair_fall_increasing,
        dandruff: formData.dandruff,
        scalp_condition: formData.scalp_condition,
        scalp_symptoms: parseJsonArray(formData.scalp_symptoms),
        hair_type: formData.hair_type,
        medical_conditions: parseJsonArray(formData.medical_conditions),
        recent_events: parseJsonArray(formData.recent_events),
        stress_level: formData.stress_level,
        gut_health: formData.gut_health || formData.gutHealth,
        sleep_quality: formData.sleep_quality,
        diet_type: formData.diet_type,
        protein_intake: formData.protein_intake,
        family_history: formData.family_history,
        allergy_status: allergyStatus,
        allergy_details: allergyDetails,
        current_medications_status: currentMedicationsStatus,
        current_medications: currentMedications,
        have_taken_treatment: formData.have_taken_treatment,
        previous_treatments: parseJsonArray(formData.previous_treatments),
        treatment_results: formData.treatment_results,
        main_concern: formData.main_concern || formData.primary_concern,
        looking_for: formData.looking_for,
        hair_loss_stage: formData.hair_loss_stage || formData.stage,
        scalp_photos: scalpPhotos,
        ai_assessment: null,
        ai_assessment_status: 'queued',
        ai_assessment_queued_at: new Date(),
        ai_assessment_updated_at: new Date(),
      });

      if (userId && this.hairTestRepository?.deleteDraft) {
        await this.hairTestRepository.deleteDraft(userId).catch(() => null);
      }
    } catch (error) {
      if (error?.code === 11000 && submissionKey) {
        const concurrentSubmission = await replay();
        if (concurrentSubmission) {
          if (formData.background_ai === 'true' && concurrentSubmission.ai_assessment_status === 'queued') {
            this.scheduleAssessment(concurrentSubmission.reference_no);
          }
          return concurrentSubmission;
        }
      }
      await Promise.all([...stagedPhotoKeys].map((key) => this.imageStorage.deleteImage(key, { deliveryType: 'authenticated' }).catch(() => null)));
      throw error;
    }

    if (formData.background_ai === 'true' && this.scheduleAssessment(hairTest.reference_no)) {
      return {
        message: 'Hair test submitted successfully. AI analysis is in progress.',
        reference_no: hairTest.reference_no,
        test: publicAssessment(hairTest),
        ai_assessment: null,
        ai_assessment_status: 'queued',
      };
    }

    let aiAssessment = null;
    let aiAssessmentStatus = hairTest.ai_assessment_status || 'queued';
    if (this.geminiAiService?.generateHairTestAssessment) {
      try {
        aiAssessment = await this.geminiAiService.generateHairTestAssessment(hairTest);
        if (this.assessmentProductAvailabilityService) {
          aiAssessment = await this.assessmentProductAvailabilityService.resolve(aiAssessment);
        }
      } catch {
        // Keep a result screen available even if the live model or catalog
        // enrichment fails; the service's deterministic fallback is local.
        try {
          aiAssessment = this.geminiAiService.generateFallbackAssessment?.(hairTest) || null;
        } catch {
          aiAssessment = null;
        }
      }

      if (aiAssessment) {
        try {
          const saved = await this.hairTestRepository.saveAiAssessment(
            hairTest.reference_no,
            aiAssessment,
          );
          if (!saved) throw new Error('assessment_result_save_failed');
          hairTest = saved;
          aiAssessmentStatus = aiAssessment?.ai_status === 'unavailable'
            ? 'unavailable'
            : 'ready';
        } catch {
          // The queued job remains recoverable by the scheduled processor.
          aiAssessment = null;
          aiAssessmentStatus = 'queued';
        }
      }
    }

    return {
      message: 'Hair test submitted successfully.',
      reference_no: hairTest.reference_no,
      test: publicAssessment(hairTest),
      ai_assessment: aiAssessment,
      ai_assessment_status: aiAssessmentStatus,
    };
  }
}

