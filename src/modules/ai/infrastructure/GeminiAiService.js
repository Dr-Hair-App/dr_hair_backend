import { config } from '../../../config/env.js';
import { optimizeImageForInference } from '../../media/infrastructure/R2MediaStorage.js';
import { getImageOptimizationBinding } from '../../../shared/storage/runtime.js';
const unavailableImageVerification = (label, details = 'The image verification service did not return a result.') => ({
  is_hair: false,
  status: 'verificationUnavailable',
  confidence: 0,
  detected_angle: label,
  follicle_visibility: 'Unknown',
  message: 'Photo verification is temporarily unavailable. Please retry.',
  details,
  source: 'unavailable',
});

const photoAngle = (photo, index) => {
  const angle = String(photo?.angle || '').toLowerCase();
  if (['front', 'top', 'left', 'right', 'back'].includes(angle)) return angle;
  return `photo_${index + 1}`;
};

const unavailableScalpPhotoVerification = (photos = []) => photos.map((photo, index) => ({
  angle: photoAngle(photo, index),
  file_name: String(photo?.file_name || ''),
  status: 'verificationUnavailable',
  is_hair: false,
  confidence: 0,
  message: 'Could not visually verify this photo. Please try a clearer image or ask the clinic for help.',
  details: 'The visual scalp check did not return a usable result.',
}));

const normalizeScalpPhotoVerification = (rawResults, includedImages, photos = []) => {
  const unavailable = unavailableScalpPhotoVerification(photos);
  const rawByAngle = new Map(
    (Array.isArray(rawResults) ? rawResults : [])
      .filter((result) => result && typeof result === 'object')
      .map((result) => [String(result.angle || '').toLowerCase(), result]),
  );
  const checkedAngles = new Set(includedImages.map((image) => image.angle));

  return unavailable.map((fallback) => {
    if (!checkedAngles.has(fallback.angle)) return fallback;
    const result = rawByAngle.get(fallback.angle);
    const status = result?.status;
    const isConsistent = status === 'hairDetected'
      ? result?.is_hair === true
      : ['notHair', 'lowClarity'].includes(status) && result?.is_hair === false;
    if (!isConsistent) return fallback;
    const messages = {
      hairDetected: 'Scalp and hair are visually present in this photo.',
      notHair: 'This photo does not appear to show a scalp. Choose a close-up scalp photo.',
      lowClarity: 'The scalp is too unclear to review. Choose a brighter, sharper photo.',
    };
    return {
      angle: fallback.angle,
      file_name: fallback.file_name,
      status,
      is_hair: status === 'hairDetected',
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
      message: messages[status],
      details: 'This is a visual scalp, screenshot, and clarity check; it does not verify image provenance or diagnose a condition.',
    };
  });
};

const conservativeNextStepRecommendation = (patientData = {}) => {
  const pattern = String(patientData.hair_fall_pattern || '').toLowerCase();
  const symptoms = [patientData.scalp_symptoms, patientData.scalp_condition]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .join(' ')
    .toLowerCase();
  const advancedStage = /stage\s*[- ]?\s*[45]/i.test(String(patientData.hair_loss_stage || ''));
  const increasing = /yes|increasing|rapid|sudden/i.test(String(patientData.hair_fall_increasing || ''));
  const medicalHistory = (Array.isArray(patientData.medical_conditions)
    ? patientData.medical_conditions
    : [patientData.medical_conditions]).join(' ').toLowerCase();
  const redFlag = advancedStage || increasing || /patchy|sudden|rapid|rapidly/i.test(pattern) ||
    /pain|burn|sore|bleed|wound|pus|infection|swelling/i.test(symptoms) ||
    /thyroid|pcos|autoimmune|anemia|anaemia|pregnan|diabetes|kidney|renal|liver disease|cancer|chemotherapy/i.test(medicalHistory);

  return redFlag
    ? {
        type: 'doctor_appointment',
        is_critical: true,
        reason: 'Your reported pattern or scalp symptoms deserve an in-person clinician review.',
      }
    : {
        type: 'products',
        is_critical: false,
        reason: 'Your answers support starting with a simple daily care routine and optional product guidance.',
      };
};

export class GeminiAiService {
  constructor({ apiKey, model, fallbackModel, logger, fetchFn, imageStorage } = {}) {
    this._apiKey = apiKey;
    this._model = model;
    this._fallbackModel = fallbackModel;
    this.logger = logger || console;
    this._fetchFn = fetchFn;
    this.fetchFn = (url, options) => {
      if (this._fetchFn) return this._fetchFn(url, options);
      return globalThis.fetch(url, options);
    };
    this.imageStorage = imageStorage;
  }

  get apiKey() {
    return this._apiKey !== undefined ? this._apiKey : (process.env.GEMINI_API_KEY?.trim() || config.gemini?.apiKey || '');
  }

  set apiKey(val) {
    this._apiKey = val;
  }

  get model() {
    return this._model !== undefined ? this._model : (process.env.GEMINI_MODEL?.trim() || config.gemini?.model || 'gemini-3.5-flash-lite');
  }

  set model(val) {
    this._model = val;
  }

  get fallbackModel() {
    return this._fallbackModel !== undefined ? this._fallbackModel : (process.env.GEMINI_FALLBACK_MODEL?.trim() || config.gemini?.fallbackModel || 'gemini-2.5-flash');
  }

  set fallbackModel(val) {
    this._fallbackModel = val;
  }

  getConservativeNextStepRecommendation(patientData = {}) {
    return conservativeNextStepRecommendation(patientData);
  }

  /**
   * Generates a comprehensive clinical assessment for a hair test using Google Gemini Flash.
   * If Gemini call fails or API key is not configured, falls back to clinical rule-based analysis.
   * @param {Object} patientData - Answers collected from the hair assessment questionnaire.
   * @returns {Promise<Object>} Formatted clinical assessment report.
   */
  async generateHairTestAssessment(patientData = {}) {
    const photos = Array.isArray(patientData.scalp_photos) ? patientData.scalp_photos : [];
    if (!this.apiKey) {
      this.logger.warn?.('Gemini API key is not set; using clinical rules fallback.');
      return {
        ...this.generateFallbackAssessment(patientData),
        scalp_photo_verification: unavailableScalpPhotoVerification(photos),
      };
    }

    const maxInlineImages = 5;
    const maxInlineImageBytes = 2 * 1024 * 1024;
    const maxInlineImageTotalBytes = maxInlineImages * maxInlineImageBytes;
    let inlineImageBytes = 0;
    const inlineImages = Array.isArray(patientData.inlineImages)
      ? patientData.inlineImages.filter((image) => image?.data && image?.mimeType).slice(0, maxInlineImages).map((image, index) => ({
          ...image,
          angle: String(image.angle || photoAngle(photos[index], index)).toLowerCase(),
        }))
      : [];
    const includedAngles = new Set();
    for (let index = 0; index < inlineImages.length; index += 1) {
      const image = inlineImages[index];
      const angle = String(image.angle || photoAngle(photos[index], index)).toLowerCase();
      const estimatedBytes = Math.floor((image.data.length * 3) / 4);
      if (!['front', 'top', 'left', 'right', 'back'].includes(angle) ||
          estimatedBytes <= 0 || estimatedBytes > maxInlineImageBytes ||
          inlineImageBytes + estimatedBytes > maxInlineImageTotalBytes) {
        inlineImages.splice(index, 1);
        index -= 1;
        continue;
      }
      image.angle = angle;
      inlineImageBytes += estimatedBytes;
      includedAngles.add(angle);
    }
    const maxGeminiCalls = 3;
    const requestDeadline = Date.now() + 25_000;
    let geminiCallCount = 0;

    if (this.imageStorage?.downloadAuthenticatedImage) {
      for (let index = 0; index < photos.length && inlineImages.length < maxInlineImages; index += 1) {
        const photo = photos[index];
        const angle = photoAngle(photo, index);
        if (includedAngles.has(angle)) continue;
        if (photo?.delivery_type !== 'authenticated' || !photo?.file_name || !photo?.format) continue;
        const candidates = [
          ...(photo.optimized_file_name
            ? [{ fileName: photo.optimized_file_name, format: photo.optimized_format || photo.format }]
            : []),
          { fileName: photo.file_name, format: photo.format },
        ];
        for (const candidate of candidates) {
          try {
            const image = await this.imageStorage.downloadAuthenticatedImage(
              candidate.fileName,
              candidate.format,
              { maxBytes: maxInlineImageBytes },
            );
            const imageBytes = Math.floor((image?.data?.length || 0) * 3 / 4);
            if (image?.data && image?.mimeType && imageBytes > 0 &&
                imageBytes <= maxInlineImageBytes &&
                inlineImageBytes + imageBytes <= maxInlineImageTotalBytes) {
              inlineImages.push({ ...image, angle });
              inlineImageBytes += imageBytes;
              includedAngles.add(angle);
              break;
            }
          } catch {
            this.logger.warn?.('A private assessment image could not be loaded for AI analysis.');
          }
        }
      }
    }
    const prompt = this._buildPrompt(patientData, inlineImages.map((image) => image.angle));

    const callGeminiOnce = async (model) => {
      if (geminiCallCount >= maxGeminiCalls || Date.now() >= requestDeadline) {
        return { ok: false, status: 0, errorText: 'Gemini request budget exhausted.' };
      }
      geminiCallCount += 1;
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        Math.min(10_000, requestDeadline - Date.now()),
      );

      try {
        const parts = [{ text: prompt }];
        for (const img of inlineImages) {
          parts.push({ text: `The next image is the patient's ${img.angle} scalp photo. Verify only whether it visually shows human scalp/hair and whether it is clear enough for review.` });
          parts.push({
            inline_data: {
              mime_type: img.mimeType,
              data: img.data,
            },
          });
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
        const response = await this.fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts,
              },
            ],
            generationConfig: {
              temperature: 0.2,
              topK: 40,
              topP: 0.9,
              maxOutputTokens: 2500,
              responseMimeType: 'application/json',
            },
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          return { ok: false, status: response.status, errorText };
        }

        const jsonResponse = await response.json();
        const candidateText = jsonResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
        return { ok: true, candidateText };
      } catch (err) {
        clearTimeout(timeoutId);
        return { ok: false, status: 0, errorText: err.message };
      }
    };

    try {
      const callWithTransientRetry = async (model) => {
        let result = await callGeminiOnce(model);
        if (!result.ok && (result.status === 429 || result.status === 503)) {
          if (geminiCallCount >= maxGeminiCalls || Date.now() + 800 >= requestDeadline) return result;
          this.logger.warn?.(`Gemini [${result.status}] transient issue. Retrying once within the request budget...`);
          await new Promise((resolve) => setTimeout(resolve, 800));
          result = await callGeminiOnce(model);
        }
        return result;
      };

      let activeModel = this.model;
      let callResult = await callWithTransientRetry(activeModel);

      if (!callResult.ok && callResult.status === 404 && this.fallbackModel && this.fallbackModel !== this.model) {
        this.logger.warn?.(`Gemini model ${this.model} was unavailable; trying configured fallback model.`);
        activeModel = this.fallbackModel;
        callResult = await callWithTransientRetry(activeModel);
      }

      if (!callResult.ok) {
        this.logger.error?.(`Gemini API request failed with status ${callResult.status}.`);
        return {
          ...this.generateFallbackAssessment(patientData),
          scalp_photo_verification: unavailableScalpPhotoVerification(photos),
        };
      }

      if (!callResult.candidateText) {
        this.logger.warn?.('Gemini returned empty candidate text. Using fallback.');
        return {
          ...this.generateFallbackAssessment(patientData),
          scalp_photo_verification: unavailableScalpPhotoVerification(photos),
        };
      }

      const parsedData = this._parseJsonCandidate(callResult.candidateText);
      if (!parsedData || typeof parsedData !== 'object') {
        this.logger.warn?.('Gemini returned an invalid structured assessment. Using fallback.');
        return {
          ...this.generateFallbackAssessment(patientData),
          scalp_photo_verification: unavailableScalpPhotoVerification(photos),
        };
      }

      const hasRequiredAssessment =
        typeof parsedData.scalp_health_score === 'number' &&
        Number.isInteger(parsedData.scalp_health_score) &&
        parsedData.scalp_health_score >= 10 &&
        parsedData.scalp_health_score <= 100 &&
        String(parsedData.stage_classification || '').trim().length > 0 &&
        String(parsedData.summary || '').trim().length > 0 &&
        typeof parsedData.summary === 'string';
      if (!hasRequiredAssessment) {
        return {
          ...this.generateFallbackAssessment(patientData),
          scalp_photo_verification: unavailableScalpPhotoVerification(photos),
        };
      }
      const scalpPhotoVerification = normalizeScalpPhotoVerification(
        parsedData.scalp_photo_verification,
        inlineImages,
        photos,
      );

      const nextStepRecommendation = (() => {
        const safetyRecommendation = conservativeNextStepRecommendation(patientData);
        const modelRecommendation = parsedData.next_step_recommendation;
        if (safetyRecommendation.type === 'doctor_appointment') {
          return {
            ...safetyRecommendation,
            is_critical: true,
          };
        }
        if (modelRecommendation?.type === 'doctor_appointment') {
          return {
            type: 'doctor_appointment',
            is_critical: true,
            reason: modelRecommendation.reason || 'Your answers need a clinician review before the Assistant can suggest a care plan.',
          };
        }
        return {
          ...safetyRecommendation,
          is_critical: false,
        };
      })();
      const isClinicianPriority = nextStepRecommendation.type === 'doctor_appointment';
      return {
        ai_status: isClinicianPriority ? 'clinician_review_required' : 'available',
        scalp_health_score: Number(parsedData.scalp_health_score) || (isClinicianPriority ? 55 : 70),
        stage_classification: String(parsedData.stage_classification || (isClinicianPriority ? 'Stage 3 - Noticeable Thinning' : 'Stage 2 - Early Thinning')),
        summary: String(parsedData.summary || (isClinicianPriority
          ? 'Clinical AI evaluation indicates advanced thinning or sensitive symptoms. In-person clinician consultation is strongly advised.'
          : 'Clinical AI evaluation completed based on reported symptoms.')),
        root_causes: Array.isArray(parsedData.root_causes) ? parsedData.root_causes : [],
        // Plans are generated only after the patient taps their explicit CTA.
        diet_plan: {},
        lifestyle_guidance: parsedData.lifestyle_guidance || {},
        recommended_regimen: { summary: '', daily_steps: [], target_products: [] },
        next_step_recommendation: nextStepRecommendation,
        generated_by: `Dr. Hair Assistant (${activeModel})`,
        generated_at: new Date().toISOString(),
        scalp_photo_verification: scalpPhotoVerification,
      };
    } catch (err) {
      this.logger.error?.(`Gemini request failed (${err?.constructor?.name || 'Error'}). Using fallback assessment.`);
      return {
        ...this.generateFallbackAssessment(patientData),
        scalp_photo_verification: unavailableScalpPhotoVerification(photos),
      };
    }
  }

  async generatePersonalizedDietPlan(patientData = {}) {
    if (!this.apiKey) throw new Error('AI meal planning service is unavailable.');
    const prompt = `You are Dr. Hair Assistant. You only answer hair, scalp, recovery, and related nutrition questions. Create a practical, culturally flexible 7-day food plan that may support general hair health. This is nutrition guidance, not treatment or diagnosis. Do not prescribe supplements, medicines, doses, or restrictive diets. Respect the patient's stated diet, allergies, medical conditions, current medicines, and relevant clinician care plans. Do not promise hair regrowth or invent patient details. If the available clinical context indicates a risk requiring clinician review, do not generate a meal plan and direct the patient to their clinician. Return only JSON with this shape: {"summary":"...","days":[{"day":"Day 1","meals":[{"type":"Breakfast","name":"...","ingredients":["..."],"benefit":"..."}]}],"safety_note":"..."}. Include 3 meals per day for 7 days. Keep meals realistic and use alternatives where allergy or dietary details require it.\nPatient health context: ${JSON.stringify({ age: patientData.age, gender: patientData.gender, diet_type: patientData.diet_type, protein_intake: patientData.protein_intake, allergy_status: patientData.allergy_status, allergy_details: patientData.allergy_details, medical_conditions: patientData.medical_conditions, current_medications: patientData.current_medications, gut_health: patientData.gut_health, foods_to_eat: patientData.ai_assessment?.diet_plan?.foods_to_eat, clinical_context: patientData.clinical_context })}`;
    const response = await this.fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2200, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) throw new Error(`AI meal plan request failed (${response.status}).`);
    const data = await response.json();
    const parsed = this._parseJsonCandidate(data?.candidates?.[0]?.content?.parts?.[0]?.text);
    if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.days) || parsed.days.length !== 7) {
      throw new Error('AI meal plan response was incomplete.');
    }
    const days = parsed.days.slice(0, 7).map((day, index) => ({
      day: String(day.day || `Day ${index + 1}`).slice(0, 30),
      meals: (Array.isArray(day.meals) ? day.meals : []).slice(0, 3).map((meal) => ({
        type: String(meal.type || '').slice(0, 40),
        name: String(meal.name || '').slice(0, 160),
        ingredients: (Array.isArray(meal.ingredients) ? meal.ingredients : []).slice(0, 8).map((item) => String(item).slice(0, 120)),
        benefit: String(meal.benefit || '').slice(0, 300),
      })),
    }));
    if (days.some((day) => day.meals.length !== 3 || day.meals.some((meal) => !meal.name))) {
      throw new Error('AI meal plan response was incomplete.');
    }
    const declaredAllergies = String(patientData.allergy_details || '').toLowerCase();
    const foodAllergenGroups = [
      ['peanut', 'groundnut'],
      ['tree nut', 'nuts', 'almond', 'cashew', 'walnut', 'pistachio'],
      ['milk', 'dairy', 'lactose'],
      ['egg'], ['fish'], ['shellfish', 'prawn', 'shrimp'],
      ['soy', 'soya'], ['wheat', 'gluten'], ['sesame'], ['mustard'],
    ];
    const mealText = JSON.stringify(days);
    const conflictingAllergen = foodAllergenGroups.find((group) => {
      const declared = group.some((allergen) => declaredAllergies.includes(allergen));
      return declared && group.some((alias) => new RegExp(`\\b${alias.replace(' ', '\\s+')}s?\\b`, 'i').test(mealText));
    });
    if (conflictingAllergen) throw new Error('AI meal plan included a declared food allergen.');
    return {
      summary: parsed.summary.slice(0, 500),
      days,
      safety_note: String(parsed.safety_note || 'This meal plan is general nutrition guidance and does not replace advice from your clinician.').slice(0, 500),
      generated_by: 'Dr. Hair Assistant',
      generated_at: new Date().toISOString(),
    };
  }

  async generatePersonalizedRoutine(patientData = {}) {
    if (!this.apiKey) throw new Error('AI routine generation is unavailable. Please try again later.');

    try {
      const prompt = `You are Dr. Hair Assistant. Create a practical daily hair care routine tailored to this patient's hair loss profile:
${JSON.stringify({
  age: patientData.age,
  gender: patientData.gender,
  selected_concern: patientData.main_concern || patientData.primary_concern || patientData.hair_fall_pattern,
  reported_stage: patientData.hair_loss_stage,
  duration: patientData.duration || patientData.hair_fall_start,
  hair_fall_increasing: patientData.hair_fall_increasing,
  daily_hair_fall: patientData.daily_hair_fall,
  scalp_condition: patientData.scalp_condition,
  scalp_symptoms: patientData.scalp_symptoms,
  stress_level: patientData.stress_level,
  dandruff: patientData.dandruff,
  gut_health: patientData.gut_health,
  family_history: patientData.family_history,
  medical_conditions: patientData.medical_conditions,
  allergy_status: patientData.allergy_status,
  allergy_details: patientData.allergy_details,
  current_medications: patientData.current_medications,
  assessment_summary: patientData.ai_assessment?.summary,
  possible_contributors: patientData.ai_assessment?.root_causes,
  clinician_review_recommendation: patientData.ai_assessment?.next_step_recommendation,
})}
Return ONLY valid JSON with this format:
{
  "summary": "<1-2 sentence overview of daily routine strategy>",
  "steps": [
    { "title": "<Clear action>", "subtitle": "<Specific instruction>", "category": "Cleansing|Massage|Nourishment|Lifestyle|Sleep", "time_of_day": "Morning|Afternoon|Evening|Night" }
  ]
}
Include 4 to 5 daily steps across morning, afternoon, evening, and night. Do not prescribe medicines, supplements, doses, or products. Do not invent missing answers. If the assessment says clinician review is required, return an empty steps array and explain that clinician review comes first.`;

      const response = await this.fetchFn(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 1200, responseMimeType: 'application/json' },
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) throw new Error(`Gemini routine HTTP ${response.status}`);
      const data = await response.json();
      const parsed = this._parseJsonCandidate(data?.candidates?.[0]?.content?.parts?.[0]?.text);
      if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        throw new Error('Incomplete routine returned');
      }
      return {
        summary: String(parsed.summary || 'Personalized hair care routine designed for your scalp.').slice(0, 300),
        steps: parsed.steps.slice(0, 8).map((step) => ({
          title: String(step.title || 'Care Step').slice(0, 100),
          subtitle: String(step.subtitle || '').slice(0, 250),
          category: String(step.category || 'Daily care').slice(0, 50),
          time_of_day: String(step.time_of_day || 'Daily').slice(0, 40),
        })),
        generated_by: 'Dr. Hair Assistant',
        generated_at: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error('AI routine generation failed. Please try again later.', { cause: error });
    }
  }

  /**
   * Builds the clinical trichology system & user prompt for Gemini.
   */
  _buildPrompt(patientData, verifiedPhotoAngles = []) {
    const age = patientData.age || 'Not specified';
    const gender = patientData.gender || 'Not specified';
    const duration = patientData.duration || patientData.hair_fall_start || 'Not specified';
    const unknown = 'Unknown / not provided';
    const pattern = patientData.hair_fall_pattern || patientData.primary_concern || patientData.main_concern || unknown;
    const dailyFall = patientData.daily_hair_fall || unknown;
    const dandruff = patientData.dandruff || unknown;
    const scalpCondition = patientData.scalp_condition || unknown;
    const symptoms = Array.isArray(patientData.scalp_symptoms) ? patientData.scalp_symptoms.join(', ') : (patientData.scalp_symptoms || unknown);
    const stress = patientData.stress_level || unknown;
    const gut = patientData.gut_health || unknown;
    const sleep = patientData.sleep_quality || unknown;
    const diet = patientData.diet_type || unknown;
    const protein = patientData.protein_intake || unknown;
    const family = patientData.family_history || unknown;
    const medical = Array.isArray(patientData.medical_conditions) ? patientData.medical_conditions.join(', ') : (patientData.medical_conditions || unknown);
    const allergy = patientData.allergy_details || patientData.allergy_status || unknown;
    const meds = patientData.current_medications || patientData.current_medications_status || unknown;
    const increasing = patientData.hair_fall_increasing || unknown;

    return `
You are "Dr. Hair Assistant", the Clinical AI Trichologist for Dr. Hair Clinic (guided by Dr. Jai Bansal's hair recovery protocols).
Analyze the following patient's hair assessment questionnaire and return a cautious, non-diagnostic screening summary with practical recommendations.

PATIENT PROFILE & ASSESSMENT RESPONSES:
- Age: ${age}
- Gender: ${gender}
- Hair Loss Duration: ${duration}
- Patient's selected concern / reported stage: ${patientData.primary_concern || patientData.main_concern || patientData.stage || unknown}
- Hair Fall Pattern: ${pattern}
- Hair Fall Increasing: ${increasing}
- Estimated Daily Hair Fall: ${dailyFall}
- Scalp Condition: ${scalpCondition}
- Dandruff Level: ${dandruff}
- Scalp Symptoms: ${symptoms}
- Stress Level: ${stress}
- Gut Health / Digestion: ${gut}
- Sleep Quality: ${sleep}
- Diet Type: ${diet}
- Protein Intake: ${protein}
- Family History of Baldness: ${family}
- Pre-existing Medical Conditions: ${medical}
- Known Allergies: ${allergy}
- Current Medications: ${meds}

Image handling: If photos are included, use them only to assess whether they appear to show the scalp and are clear enough for clinician review. Do not diagnose a condition or infer a hair-loss stage from photos. Base appointment recommendations on the patient's reported answers.
For visual verification, the attached images have these angle labels in order: ${verifiedPhotoAngles.length ? verifiedPhotoAngles.join(', ') : 'no images could be verified'}. Return exactly one verification entry for every listed angle. Do not invent an entry for an image that was not attached. Photos may show screenshots or unrelated images; classify based only on the visible content. This visual check does not establish who took the photo or verify image provenance.

CLINICAL REQUIREMENTS:
Return a single strictly valid JSON object matching this schema exactly:
{
  "scalp_health_score": <Integer between 10 and 100; a questionnaire screening indicator, not a medical measurement>,
  "stage_classification": "<A cautious description of the patient's reported pattern; do not assign a medical diagnosis or infer a Norwood/Ludwig stage>",
  "summary": "<2-3 sentence cautious overview of the answers; distinguish reported information from possible explanations>",
  "scalp_photo_verification": [
    { "angle": "<one supplied attached-image angle>", "status": "hairDetected | notHair | lowClarity", "is_hair": true | false, "confidence": 0.9 }
  ],
  "next_step_recommendation": {
    "type": "doctor_appointment | products",
    "reason": "<Brief reason based only on the patient's answers; never present this as a diagnosis>"
  },
  "root_causes": [
    {
      "factor": "<e.g., DHT Sensitivity & Miniaturization, Scalp Microbiome & Sebum, Nutritional Deficit, Stress & Cortisol>",
      "severity": "<Low | Moderate | High>",
      "explanation": "<Specific reason explaining how this factor impacts this specific patient's follicles>"
    }
  ],
  "diet_plan": {},
  "lifestyle_guidance": {
    "summary": "<1-2 sentence lifestyle and routine optimization strategy>",
    "scalp_care_tips": ["<Tip 1>", "<Tip 2>", "<Tip 3>"],
    "oiling_rules": ["<Rule 1 regarding oiling frequency & dandruff management>", "<Rule 2>"],
    "sleep_and_stress": ["<Practical action 1>", "<Practical action 2>"]
  },
  "recommended_regimen": { "summary": "", "daily_steps": [], "target_products": [] }
}

NEXT-STEP DECISION:
- Use type "doctor_appointment" when the answers report patchy hair loss, sudden or rapidly increasing shedding, scalp pain/burning/sores/bleeding, advanced reported thinning, or symptoms whose cause needs clinical assessment. State the reason in calm, non-alarmist language.
- Otherwise use the existing type "products" to mean a self-care pathway with practical daily steps; products are optional supporting choices, never the primary treatment or the only next step.
- Make the next step fit the patient's reported condition and realistic care options. When clinician assessment is needed, prioritize the appointment/review path. Do not imply that AI guidance or catalog items provide a complete treatment.
- Suggest only broad categories from Hair Care or Serums; never suggest supplements, medicines, prescriptions, or branded products. The app matches broad categories to the active in-stock catalog.
- Never infer a diagnosis from a photo or questionnaire, and never recommend prescription treatment or supplement dosing.
- Do not call the score a clinical measurement or present the reported pattern as a confirmed stage or diagnosis.
- For each attached photo, use "hairDetected" only when a close scalp/hair area is visibly present, "notHair" for screenshots, unrelated images, or photos without scalp, and "lowClarity" for a scalp photo too blurry/dark to review. Keep is_hair consistent with status. Do not infer authenticity, ownership, or provenance.

Do not include markdown fences outside the JSON. Return valid JSON only.
`;
  }

  /**
   * Robust JSON extractor and parser.
   */
  _parseJsonCandidate(text) {
    if (!text) return null;
    let cleaned = text.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  /**
   * Returns an explicit unavailable result when AI cannot produce a usable assessment.
   */
  generateFallbackAssessment(patientData = {}) {
    const safetyRecommendation = conservativeNextStepRecommendation(patientData);
    return {
      ai_status: 'unavailable',
      scalp_health_score: null,
      stage_classification: null,
      summary: 'AI could not prepare your assessment right now. Please try again later or discuss your answers with a clinician.',
      root_causes: [],
      diet_plan: {},
      lifestyle_guidance: {},
      recommended_regimen: {
        summary: '',
        daily_steps: [],
        target_products: [],
      },
      next_step_recommendation: safetyRecommendation.type === 'doctor_appointment'
        ? safetyRecommendation
        : {
            type: 'unavailable',
            reason: 'AI could not prepare a product recommendation. Please retry or ask a clinician.',
          },
      scalp_photo_verification: unavailableScalpPhotoVerification(
        Array.isArray(patientData.scalp_photos) ? patientData.scalp_photos : [],
      ),
      generated_by: 'unavailable',
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Visually detects whether an uploaded photo is a genuine human scalp/hair image
   * using Gemini Flash vision, and verifies identity consistency with previously uploaded photos.
   * @param {Object} options
   * @param {Buffer} [options.imageBuffer] - Raw file buffer
   * @param {string} [options.base64Data] - Or raw base64 string
   * @param {string} [options.mimeType] - Mime type e.g. 'image/jpeg' or 'image/png'
   * @param {string} [options.label] - Intended angle e.g. 'Front Hairline', 'Crown / Top'
   * @param {Buffer} [options.referenceImageBuffer] - Optional baseline photo buffer from same session
   * @param {string} [options.referenceBase64] - Optional baseline photo base64
   * @param {string} [options.referenceMimeType] - Optional baseline photo mime type
   * @returns {Promise<Object>} Detection result
   */
  async detectHairAndScalpImage({
    imageBuffer,
    base64Data,
    mimeType = 'image/jpeg',
    label = 'Scalp',
    referenceImageBuffer,
    referenceBase64,
    referenceMimeType = 'image/jpeg',
  } = {}) {
    if ((!base64Data && !imageBuffer) || !this.apiKey) {
      return unavailableImageVerification(label, `Image data or AI service configuration is unavailable (apiKey present: ${Boolean(this.apiKey)}).`);
    }

    let referenceData = referenceBase64;

    const imageBinding = getImageOptimizationBinding();
    const prepareForInference = async (encoded, buffer, type) => {
      // Gemini's inline request limit is 20 MiB. Keep a margin for the prompt,
      // JSON encoding, and base64 expansion; large inputs are resized only in
      // this transient inference path, never in R2 or the clinical record.
      const originalData = typeof encoded === 'string' && encoded.length > 0 ? encoded : null;
      const originalBuffer = Buffer.isBuffer(buffer) ? buffer : null;
      const originalBytes = originalData ? Math.floor(originalData.length * 3 / 4) : (originalBuffer?.length || 0);
      if ((!originalData && !originalBuffer) || originalBytes <= 0 || originalBytes > 25 * 1024 * 1024 ||
          (originalData && originalData.length > 36 * 1024 * 1024)) return null;

      // Avoid base64 copies of multipart buffers until the combined request
      // size has been checked. Base64 callers already paid this allocation at
      // the HTTP parser and can be passed through without another copy.
      let source = originalData && imageBinding ? Buffer.from(originalData, 'base64') : originalBuffer;
      const prepared = source
        ? await optimizeImageForInference(source, type, imageBinding)
        : { buffer: null, contentType: type, resized: false };
      const preparedBuffer = prepared.resized ? prepared.buffer : originalBuffer;
      const preparedBytes = preparedBuffer?.length ?? originalBytes;
      const encodedCharacters = originalData && !prepared.resized
        ? originalData.length
        : Math.ceil(preparedBytes / 3) * 4;
      return {
        data: originalData && !prepared.resized ? originalData : null,
        buffer: preparedBuffer,
        encodedCharacters,
        mimeType: prepared.resized ? prepared.contentType : type,
      };
    };
    const preparedImage = await prepareForInference(base64Data, imageBuffer, mimeType);
    if (!preparedImage) return unavailableImageVerification(label, 'Image is too large for safe AI verification. Please choose a smaller photo.');
    mimeType = preparedImage.mimeType;

    let preparedReference = null;
    if (referenceBase64 || referenceImageBuffer) {
      preparedReference = await prepareForInference(referenceData, referenceImageBuffer, referenceMimeType);
      if (!preparedReference) return unavailableImageVerification(label, 'Reference image is too large for safe AI verification. Please choose a smaller photo.');
      referenceMimeType = preparedReference.mimeType;
    }
    const totalInlineCharacters = preparedImage.encodedCharacters + (preparedReference?.encodedCharacters || 0);
    if (totalInlineCharacters > 18 * 1024 * 1024) {
      return unavailableImageVerification(label, 'Images exceed the safe inline AI request limit. Please choose smaller photos.');
    }

    const data = preparedImage.data || preparedImage.buffer.toString('base64');
    referenceData = preparedReference
      ? preparedReference.data || preparedReference.buffer.toString('base64')
      : null;

    const hasReference = Boolean(referenceData);

    const prompt = hasReference
      ? `
You are Dr. Hair Assistant's Clinical Vision AI (under Dr. Jai Bansal's hair recovery protocols).
Perform strict clinical triage for an uploaded patient photo intended for trichology scalp evaluation.
Target angle: "${label}".

You are provided with TWO images:
- Image 1: The patient's baseline reference scalp photo previously verified in this assessment.
- Image 2: The newly uploaded scalp photo being submitted for angle "${label}".

CRITICAL CLINICAL ACCEPTANCE RULES FOR IMAGE 2:
1. ONLY APPROVE (status: "hairDetected", is_hair: true) if Image 2 clearly shows a REAL HUMAN SCALP, HAIRLINE, CROWN, TEMPLES, or ROOTS suitable for a trichology doctor to evaluate hair loss and follicle density, AND Image 2 visually belongs to the SAME individual as Image 1.
2. REJECT NON-SCALP (status: "notHair", is_hair: false):
   - Screenshots of any kind (phone UI, WhatsApp chats, social media, web pages, apps, text, documents, billing receipts, etc.).
   - Photos of computer monitors, laptop displays, or digital screens.
   - Random non-hair objects (cars, roads, animals, food, clothes, furniture, rooms, buildings, landscape, plants, nature, etc.).
   - Full body or distant portraits where scalp/hairline roots are not in clear close-up view.
   - Non-head body parts (hands, fingers, legs, chest, face without scalp).
   - Memes, artwork, drawings, cartoons, or graphic illustrations.
3. REJECT UNCLEAR (status: "lowClarity", is_hair: false):
   - If Image 2 has scalp/hair but is extremely dark, blurry, out-of-focus, or obstructed so a trichologist cannot evaluate hair density.
4. REJECT DIFFERENT PERSON (status: "personMismatch", is_hair: false):
   - Strict identity consistency check: Compare Image 2 against Image 1.
   - Compare observable biological traits: hair color (e.g., black vs brown vs blonde vs silver/grey), hair strand texture / curl pattern (straight vs wavy vs curly vs coily), and scalp skin tone/complexion.
   - If Image 2 clearly appears to be from a DIFFERENT person than Image 1 (different hair color, different ethnicity/scalp tone, or different individual's head), YOU MUST REJECT IT with status "personMismatch".

Return strictly valid JSON:
If approved (valid scalp close-up of the same individual):
{
  "is_hair": true,
  "status": "hairDetected",
  "confidence": 0.95,
  "detected_angle": "${label}",
  "follicle_visibility": "Clear",
  "same_person": true,
  "message": "Clear scalp and hair follicles verified for clinical assessment.",
  "details": "Scalp features and consistency with reference photo confirmed."
}

If rejected due to different person:
{
  "is_hair": false,
  "status": "personMismatch",
  "confidence": 0.95,
  "detected_angle": "${label}",
  "follicle_visibility": "Clear",
  "same_person": false,
  "message": "Photos appear to be of different people. Please ensure all 3 photos are of the same person.",
  "details": "Hair color, texture, or scalp tone does not match your reference photo."
}

If rejected due to non-hair / screenshot / object:
{
  "is_hair": false,
  "status": "notHair",
  "confidence": 0.98,
  "detected_angle": "Unknown",
  "follicle_visibility": "None",
  "same_person": false,
  "message": "Non-scalp image detected. Please upload an exclusive close-up photo of your scalp.",
  "details": "Screenshots, digital graphics, or non-scalp objects cannot be used for clinical diagnosis."
}

If rejected due to low clarity:
{
  "is_hair": false,
  "status": "lowClarity",
  "confidence": 0.90,
  "detected_angle": "${label}",
  "follicle_visibility": "Poor",
  "same_person": true,
  "message": "Photo is blurry or poorly lit. Please retake a clear close-up with good lighting.",
  "details": "Follicles and scalp surface are not clearly distinguishable."
}
`
      : `
You are Dr. Hair Assistant's Clinical Vision AI (under Dr. Jai Bansal's hair recovery protocols).
Perform strict clinical triage for an uploaded patient photo intended for trichology scalp evaluation.
Target angle: "${label}".

CRITICAL CLINICAL ACCEPTANCE RULES:
1. ONLY APPROVE (status: "hairDetected", is_hair: true) if this photo clearly shows a REAL HUMAN SCALP, HAIRLINE, CROWN, TEMPLES, or ROOTS suitable for a trichology doctor to evaluate hair loss and follicle density.
2. YOU MUST REJECT (status: "notHair", is_hair: false):
   - Screenshots of any kind (phone UI, WhatsApp chats, social media, web pages, apps, text, documents, billing receipts, etc.).
   - Photos of computer monitors, laptop displays, or digital screens.
   - Random non-hair objects (cars, roads, animals, food, clothes, furniture, rooms, buildings, landscape, plants, nature, etc.).
   - Full body or distant portraits where scalp/hairline roots are not in clear close-up view.
   - Non-head body parts (hands, fingers, legs, chest, face without scalp).
   - Memes, artwork, drawings, cartoons, or graphic illustrations.
3. If image has hair/scalp but is extremely dark, blurry, out-of-focus, or obstructed so a trichologist cannot evaluate hair density: mark status: "lowClarity", is_hair: false.

Return strictly valid JSON:
If approved:
{
  "is_hair": true,
  "status": "hairDetected",
  "confidence": 0.95,
  "detected_angle": "${label}",
  "follicle_visibility": "Clear",
  "message": "Clear scalp and hair follicles verified for clinical assessment.",
  "details": "Follicular density and scalp pattern clearly visible."
}

If rejected (non-hair, screenshot, or random object):
{
  "is_hair": false,
  "status": "notHair",
  "confidence": 0.98,
  "detected_angle": "Unknown",
  "follicle_visibility": "None",
  "message": "Non-scalp image detected. Please upload an exclusive close-up photo of your scalp.",
  "details": "Screenshots, digital graphics, or non-scalp objects cannot be used for clinical diagnosis."
}

If rejected due to low clarity:
{
  "is_hair": false,
  "status": "lowClarity",
  "confidence": 0.90,
  "detected_angle": "${label}",
  "follicle_visibility": "Poor",
  "message": "Photo is blurry or poorly lit. Please retake a clear close-up with good lighting.",
  "details": "Follicles and scalp surface are not clearly distinguishable."
}
`;

    const parts = [{ text: prompt }];
    if (hasReference) {
      parts.push({ text: 'Image 1 (Baseline reference photo previously confirmed for this patient):' });
      parts.push({
        inline_data: {
          mime_type: referenceMimeType,
          data: referenceData,
        },
      });
      parts.push({ text: `Image 2 (Newly uploaded target photo for angle "${label}"):` });
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data,
        },
      });
    } else {
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data,
        },
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const callGeminiModel = async (modelName) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
      return await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts,
            },
          ],
          generationConfig: {
            temperature: 0.1,
            topK: 20,
            topP: 0.9,
            maxOutputTokens: 600,
            responseMimeType: 'application/json',
          },
        }),
        signal: controller.signal,
      });
    };

    try {
      let activeModel = this.model;
      let response = await callGeminiModel(activeModel);

      if (!response.ok && response.status === 404 && this.fallbackModel && this.fallbackModel !== this.model) {
        this.logger.warn?.(`Gemini model ${this.model} was unavailable (404); trying fallback model ${this.fallbackModel}.`);
        activeModel = this.fallbackModel;
        response = await callGeminiModel(activeModel);
      }

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        this.logger.warn?.('Gemini scalp photo verification failed.', {
          reason: 'upstream_http_error',
          status: response.status,
          error: errorText,
        });
        return unavailableImageVerification(label, `Gemini HTTP ${response.status}: ${errorText.substring(0, 150)}`);
      }

      const jsonResponse = await response.json();
      const candidateText = jsonResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = this._parseJsonCandidate(candidateText);

      if (!parsed || typeof parsed !== 'object') {
        this.logger.warn?.('Gemini scalp photo verification failed.', {
          reason: 'invalid_model_response',
          candidateText,
        });
        return unavailableImageVerification(label, `Model output invalid: ${String(candidateText).substring(0, 100)}`);
      }

      const allowedStatuses = new Set(['hairDetected', 'notHair', 'lowClarity', 'personMismatch']);
      if (!allowedStatuses.has(parsed.status)) {
        this.logger.warn?.('Gemini scalp photo verification failed.', {
          reason: 'unsupported_model_status',
          status: parsed.status,
        });
        return unavailableImageVerification(label, `Unsupported status from model: ${parsed.status}`);
      }
      if (parsed.status === 'hairDetected' && parsed.is_hair !== true) {
        this.logger.warn?.('Gemini scalp photo verification failed.', {
          reason: 'inconsistent_model_result',
        });
        return unavailableImageVerification(label, 'Inconsistent status from model');
      }
      const isHair = parsed.status === 'hairDetected';
      const status = parsed.status;

      return {
        is_hair: isHair,
        status,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.92,
        detected_angle: parsed.detected_angle || label,
        follicle_visibility: parsed.follicle_visibility || (isHair ? 'Clear' : 'None'),
        same_person: parsed.same_person ?? (status !== 'personMismatch'),
        message: parsed.message || (isHair ? 'Hair & scalp detected successfully.' : 'No hair or scalp detected. Please upload a clear photo of your scalp.'),
        details: parsed.details || '',
        source: `Dr. Hair Assistant (${activeModel})`,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      this.logger.warn?.('Gemini scalp photo verification failed.', {
        reason: controller.signal.aborted ? 'upstream_timeout' : 'upstream_request_error',
        errorName: err?.name || 'Error',
      });
      return unavailableImageVerification(label, `Verification error: ${err?.message || err?.name}`);
    }
  }
}
