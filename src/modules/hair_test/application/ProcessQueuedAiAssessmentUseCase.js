import { randomUUID } from 'node:crypto';

export class ProcessQueuedAiAssessmentUseCase {
  constructor({
    hairTestRepository,
    geminiAiService,
    assessmentProductAvailabilityService,
    deviceTokenRepository = null,
    notificationRepository = null,
    sendPushNotification = null,
    logger = console,
  }) {
    this.hairTestRepository = hairTestRepository;
    this.geminiAiService = geminiAiService;
    this.assessmentProductAvailabilityService = assessmentProductAvailabilityService;
    this.deviceTokenRepository = deviceTokenRepository;
    this.notificationRepository = notificationRepository;
    this.sendPushNotification = sendPushNotification;
    this.logger = logger;
  }

  async _notifyAssessmentReady(hairTest, assessment) {
    const userId = hairTest?.userId;
    if (!userId || assessment?.ai_status === 'unavailable') return;
    const title = 'Your AI Hair Report is Ready';
    const body = 'Open Dr. Hair to view your personalized scalp assessment and next steps.';
    const data = {
      type: 'ai_assessment_ready',
      screen: 'assessment_report',
      reference_no: String(hairTest.reference_no || ''),
    };

    try {
      if (this.notificationRepository?.create) {
        await this.notificationRepository.create({
          userId,
          title,
          body,
          type: 'ai_assessment_ready',
          data,
        }).catch(() => null);
      }
      if (this.deviceTokenRepository?.listByUserId && this.sendPushNotification) {
        const tokens = await this.deviceTokenRepository.listByUserId(userId);
        const activeTokens = (tokens || [])
          .filter((entry) => entry?.active !== false && typeof entry?.token === 'string' && entry.token.trim())
          .map((entry) => entry.token.trim());
        await Promise.allSettled(
          activeTokens.map((token) => this.sendPushNotification({ token, title, body, data })),
        );
      }
    } catch {
      this.logger.warn?.('Unable to send AI assessment ready notification.');
    }
  }

  async processOne({ referenceNo } = {}) {
    const hairTest = await this.hairTestRepository.claimNextAiAssessment(randomUUID(), { referenceNo });
    if (!hairTest) return false;

    try {
      let assessment = await this.geminiAiService.generateHairTestAssessment(hairTest);
      if (this.assessmentProductAvailabilityService) {
        assessment = await this.assessmentProductAvailabilityService.resolve(assessment);
      }
      const saved = await this.hairTestRepository.saveAiAssessment(hairTest.reference_no, assessment);
      if (!saved) throw new Error('assessment_record_missing');
      await this._notifyAssessmentReady(hairTest, assessment);
      this.logger.info?.('Assessment AI job completed.');
    } catch {
      this.logger.error?.('Assessment AI job failed; patient can retry.');
      await this.hairTestRepository.markAiAssessmentFailed(hairTest.reference_no, 'processing_failed');
    }
    return true;
  }
}
