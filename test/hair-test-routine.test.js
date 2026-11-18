import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GenerateAssessmentRoutineUseCase } from '../src/modules/hair_test/application/GenerateAssessmentRoutineUseCase.js';
import { GeminiAiService } from '../src/modules/ai/infrastructure/GeminiAiService.js';

describe('AI Assessment Care Routine UseCase & Gemini Service', () => {
  it('generates a personalized routine via GeminiAiService fallback when no API key', async () => {
    const service = new GeminiAiService({ apiKey: '' });
    const routine = await service.generatePersonalizedRoutine({
      age: 28,
      gender: 'Male',
      hair_fall_pattern: 'Receding hairline',
    });

    assert.ok(routine);
    assert.ok(Array.isArray(routine.steps));
    assert.ok(routine.steps.length >= 4);
    assert.equal(routine.steps[0].category, 'Cleansing');
    assert.ok(routine.summary);
  });

  it('executes GenerateAssessmentRoutineUseCase and persists custom_routine', async () => {
    let savedReferenceNo = null;
    let savedAssessment = null;
    const addedSteps = [];

    const mockHairTestRepo = {
      findByReferenceNo: async (ref) => ({
        reference_no: ref,
        userId: 101,
        ai_assessment: {
          ai_status: 'available',
          scalp_health_score: 75,
          stage_classification: 'Stage 2',
        },
      }),
      saveAiAssessment: async (ref, assessment) => {
        savedReferenceNo = ref;
        savedAssessment = assessment;
        return { reference_no: ref, ai_assessment: assessment };
      },
    };

    const mockTreatmentRepo = {
      addRoutineStep: async (userId, step) => {
        addedSteps.push({ userId, step });
        return addedSteps;
      },
    };

    const mockGeminiService = {
      generatePersonalizedRoutine: async () => ({
        summary: 'Custom test routine',
        steps: [
          { title: 'Morning Tonic', subtitle: 'Apply serum', category: 'Treatment', time_of_day: 'Morning' },
          { title: 'Evening Scalp Care', subtitle: 'Gentle massage', category: 'Massage', time_of_day: 'Night' },
        ],
      }),
    };

    const useCase = new GenerateAssessmentRoutineUseCase({
      hairTestRepository: mockHairTestRepo,
      treatmentRepository: mockTreatmentRepo,
      geminiAiService: mockGeminiService,
    });

    const result = await useCase.execute({ userId: 101, referenceNo: 'HT-TEST-001' });

    assert.equal(result.reference_no, 'HT-TEST-001');
    assert.equal(savedReferenceNo, 'HT-TEST-001');
    assert.equal(savedAssessment.custom_routine.summary, 'Custom test routine');
    assert.equal(addedSteps.length, 2);
    assert.equal(addedSteps[0].step.title, 'Morning Tonic');
  });

  it('rejects routine generation when user is unauthorized', async () => {
    const mockHairTestRepo = {
      findByReferenceNo: async (ref) => ({
        reference_no: ref,
        userId: 999, // different user
        ai_assessment: { ai_status: 'available' },
      }),
    };

    const useCase = new GenerateAssessmentRoutineUseCase({
      hairTestRepository: mockHairTestRepo,
    });

    await assert.rejects(
      () => useCase.execute({ userId: 101, referenceNo: 'HT-TEST-001' }),
      /not authorized/i,
    );
  });

  it('verifies HairTestRepository getAiAssessmentStatus includes patient_id and patient_code', async () => {
    const { HairTestRepository } = await import('../src/modules/hair_test/infrastructure/HairTestRepository.js');
    const { store } = await import('../src/shared/database/store.js');

    store.hairTests.push({
      reference_no: 'HT-TEST-STATUS-1',
      userId: 42,
      ai_assessment_status: 'ready',
      ai_assessment: {
        ai_status: 'available',
        scalp_health_score: 80,
      },
    });

    const repo = new HairTestRepository();
    const status = await repo.getAiAssessmentStatus('HT-TEST-STATUS-1', 42);

    assert.ok(status);
    assert.equal(status.reference_no, 'HT-TEST-STATUS-1');
    assert.equal(status.patient_id, 42);
    assert.equal(status.patient_code, 'DHP0042');
  });
});
