import { BadRequestError, NotFoundError, UnauthorizedError } from '../../../shared/errors/index.js';

export class GenerateAssessmentRoutineUseCase {
  constructor({ hairTestRepository, treatmentRepository, geminiAiService }) {
    this.hairTestRepository = hairTestRepository;
    this.treatmentRepository = treatmentRepository;
    this.geminiAiService = geminiAiService;
  }

  async execute({ userId, referenceNo }) {
    if (!referenceNo) throw new BadRequestError('Assessment reference number is required.');
    const hairTest = await this.hairTestRepository.findByReferenceNo(referenceNo);
    if (!hairTest) throw new NotFoundError('Assessment not found for that reference number.');
    if (!userId || !hairTest.userId || String(hairTest.userId) !== String(userId)) {
      throw new UnauthorizedError('You are not authorized to access this assessment.');
    }

    const assessment = hairTest.ai_assessment;
    if (!assessment || assessment.ai_status === 'unavailable') {
      throw new BadRequestError('A completed AI assessment is required before creating a care routine.');
    }
    const safetyRecommendation = this.geminiAiService.getConservativeNextStepRecommendation?.(hairTest);
    if (assessment.next_step_recommendation?.type === 'doctor_appointment'
      || safetyRecommendation?.type === 'doctor_appointment') {
      throw new BadRequestError('Please speak with a clinician before creating a routine for this assessment.');
    }

    if (typeof this.geminiAiService?.generatePersonalizedRoutine !== 'function') {
      throw new BadRequestError('AI routine generation is unavailable. Please try again later.');
    }
    const routinePlan = await this.geminiAiService.generatePersonalizedRoutine(hairTest);
    if (!routinePlan || !Array.isArray(routinePlan.steps) || !routinePlan.steps.length) {
      throw new BadRequestError('AI could not create this routine. Please try again later.');
    }

    const updatedAssessment = { ...assessment, custom_routine: routinePlan };
    const updatedTest = await this.hairTestRepository.saveAiAssessment(referenceNo, updatedAssessment);

    return {
      message: 'Your personalized daily care routine is ready.',
      reference_no: referenceNo,
      routine: routinePlan,
      ai_assessment: updatedAssessment,
      test: updatedTest || { ...hairTest, ai_assessment: updatedAssessment },
    };
  }
}
