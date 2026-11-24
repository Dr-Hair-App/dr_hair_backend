import test from 'node:test';
import assert from 'node:assert/strict';
import { PatientClinicalController } from '../src/modules/patient/presentation/patient-clinical.controller.js';
import { normalizePatientDietSuggestions } from '../src/modules/treatment/domain/patient-diet-suggestion.js';
import { TreatmentController } from '../src/modules/treatment/presentation/treatment.controller.js';

const validSuggestion = {
  id: 'food_oats_1', name: 'Oats', frequency: 'weekly', weekdays: [1, 3],
  start_date: '2026-11-24', assessment_reference: 'DHA-TEST-1',
};

test('normalizes patient food schedules and rejects invalid weekly schedules', () => {
  assert.deepEqual(normalizePatientDietSuggestions([validSuggestion]), [{
    ...validSuggestion, source: 'assessment_ai', active: true,
  }]);
  assert.throws(() => normalizePatientDietSuggestions([{ ...validSuggestion, weekdays: [] }]), /Choose at least one weekday/);
  assert.throws(() => normalizePatientDietSuggestions([{ ...validSuggestion, start_date: '2026-02-30' }]), /valid YYYY-MM-DD/);
  assert.throws(() => normalizePatientDietSuggestions(Array.from({ length: 21 }, (_, i) => ({ ...validSuggestion, id: `food_${i}` }))), /up to 20/);
});

test('saves a schedule only when the assessment belongs to the signed-in patient', async () => {
  const saved = [];
  const controller = new PatientClinicalController({
    hairTestRepository: { findByReferenceNo: async (referenceNo) => ({ reference_no: referenceNo, userId: 42 }) },
    treatmentRepository: { updatePatientDietSuggestions: async (userId, referenceNo, suggestions) => {
      saved.push({ userId, referenceNo, suggestions });
      return { patient_diet_suggestions: suggestions };
    } },
  });
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  let nextError = null;
  await controller.savePatientDietSuggestions({ user: { id: 42 }, body: { reference_no: 'DHA-TEST-1', suggestions: [validSuggestion] } }, response, (error) => { nextError = error; });
  assert.equal(nextError, null);
  assert.equal(response.body.data.patient_diet_suggestions[0].name, 'Oats');
  assert.equal(saved[0].userId, 42);
  assert.equal(saved[0].referenceNo, 'DHA-TEST-1');

  const deniedResponse = { ...response, body: null };
  const crossPatientController = new PatientClinicalController({
    hairTestRepository: { findByReferenceNo: async () => ({ reference_no: 'DHA-TEST-1', userId: 7 }) },
    treatmentRepository: { updatePatientDietSuggestions: async () => assert.fail('must not persist another patient’s schedule') },
  });
  await crossPatientController.savePatientDietSuggestions({ user: { id: 42 }, body: { reference_no: 'DHA-TEST-1', suggestions: [validSuggestion] } }, deniedResponse, (error) => { nextError = error; });
  assert.equal(nextError?.statusCode, 404);
});

test('returns clinician meals and active food schedules in the existing diet-plan read', async () => {
  const controller = new TreatmentController({
    treatmentRepository: { findByUserId: async () => [
      { status: 'active', treatment_name: 'Clinical plan', doctor_name: 'Clinician', diet_meals: [{ type: 'Lunch', name: 'Plan meal' }], patient_diet_suggestions: [validSuggestion] },
      { status: 'withdrawn', patient_diet_suggestions: [{ ...validSuggestion, id: 'withdrawn' }] },
    ] },
  });
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await controller.getPatientDietPlan({ user: { id: 42 } }, response, (error) => { throw error; });
  assert.deepEqual(response.body.data.diet_meals, [{ type: 'Lunch', name: 'Plan meal' }]);
  assert.deepEqual(response.body.data.patient_diet_suggestions, [validSuggestion]);
});
