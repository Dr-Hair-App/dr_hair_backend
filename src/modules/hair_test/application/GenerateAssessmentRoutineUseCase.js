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

    let routinePlan;
    if (typeof this.geminiAiService?.generatePersonalizedRoutine === 'function') {
      routinePlan = await this.geminiAiService.generatePersonalizedRoutine(hairTest);
    } else {
      routinePlan = {
        summary: 'Clinical routine designed to support scalp barrier health and nutrient flow.',
        steps: [
          { title: 'Morning Gentle Scalp Cleansing', subtitle: 'Wash with lukewarm water and a pH-balanced gentle cleanser', category: 'Cleansing', time_of_day: 'Morning' },
          { title: 'Follicular Stimulation Massage', subtitle: '4 minutes gentle fingertip circular motion to enhance microcirculation', category: 'Massage', time_of_day: 'Morning' },
          { title: 'Mid-Day Hydration & Scalp Protection', subtitle: 'Drink 500ml water and protect hair from harsh direct sun or pollution', category: 'Lifestyle', time_of_day: 'Afternoon' },
          { title: 'Evening Botanical Regrowth Tonic', subtitle: 'Apply nourishing botanical/peptide scalp serum on thinning regions', category: 'Nourishment', time_of_day: 'Evening' },
          { title: 'Pre-Sleep Follicle Rest & Care', subtitle: 'Avoid tight hairstyles, use smooth pillowcase, and aim for 7-8h restful sleep', category: 'Sleep', time_of_day: 'Night' },
        ],
        generated_by: 'Dr. Hair Assistant',
        generated_at: new Date().toISOString(),
      };
    }

    const updatedAssessment = { ...assessment, custom_routine: routinePlan };
    const updatedTest = await this.hairTestRepository.saveAiAssessment(referenceNo, updatedAssessment);

    // Sync generated routine steps to treatment routine repository if available
    if (this.treatmentRepository?.addRoutineStep && Array.isArray(routinePlan.steps)) {
      for (const step of routinePlan.steps) {
        await this.treatmentRepository.addRoutineStep(userId, {
          title: step.title,
          subtitle: step.subtitle || '',
          category: step.category || 'Daily care',
          time_of_day: step.time_of_day || 'Daily',
          created_by: 'ai_assessment',
        }).catch(() => null);
      }
    }

    return {
      message: 'Your personalized daily care routine is ready.',
      reference_no: referenceNo,
      routine: routinePlan,
      ai_assessment: updatedAssessment,
      test: updatedTest || { ...hairTest, ai_assessment: updatedAssessment },
    };
  }
}
