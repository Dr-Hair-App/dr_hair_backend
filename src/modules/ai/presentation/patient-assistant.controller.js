export class PatientAssistantController {
  constructor({
    streamPatientAssistantReplyUseCase,
    userRepository,
    hairTestRepository,
    treatmentRepository,
  }) {
    this.streamPatientAssistantReplyUseCase = streamPatientAssistantReplyUseCase;
    this.userRepository = userRepository;
    this.hairTestRepository = hairTestRepository;
    this.treatmentRepository = treatmentRepository;
  }

  async _getPatientContext(userId) {
    const safeLoad = async (load, fallback) => {
      try { return await load(); } catch { return fallback; }
    };
    const [user, assessments, carePlans] = await Promise.all([
      this.userRepository?.findById
        ? safeLoad(() => this.userRepository.findById(userId), null)
        : null,
      this.hairTestRepository?.findByUserId
        ? safeLoad(() => this.hairTestRepository.findByUserId(userId), [])
        : [],
      this.treatmentRepository?.findByUserId
        ? safeLoad(() => this.treatmentRepository.findByUserId(userId), [])
        : [],
    ]);
    const latest = Array.isArray(assessments)
      ? assessments.filter((item) => item?.status !== 'draft').at(0)
      : null;
    const carePlan = Array.isArray(carePlans) ? carePlans[0] : null;
    return {
      profile: {
        age: user?.age != null && Number.isFinite(Number(user.age)) ? Number(user.age) : null,
        gender: typeof user?.gender === 'string' ? user.gender.slice(0, 24) : null,
      },
      latestAssessment: latest ? {
        status: String(latest.status || 'submitted').slice(0, 24),
        mainConcern: String(latest.main_concern || '').slice(0, 120),
        duration: String(latest.duration || '').slice(0, 60),
        hairFallPattern: String(latest.hair_fall_pattern || '').slice(0, 80),
        hairLossStage: String(latest.hair_loss_stage || '').slice(0, 60),
        dandruff: String(latest.dandruff || '').slice(0, 80),
        scalpCondition: String(latest.scalp_condition || '').slice(0, 100),
        scalpSymptoms: Array.isArray(latest.scalp_symptoms)
          ? latest.scalp_symptoms.slice(0, 5).map((value) => String(value).slice(0, 40))
          : [],
      } : null,
      currentCarePlan: carePlan ? {
        stage: String(carePlan.stage || '').slice(0, 60),
        routineSteps: Array.isArray(carePlan.routine_steps)
          ? carePlan.routine_steps.slice(0, 8).map((step) => ({
            title: String(step?.title || '').slice(0, 80),
            category: String(step?.category || '').slice(0, 32),
            timeOfDay: String(step?.time_of_day || step?.timeOfDay || '').slice(0, 24),
            createdBy: step?.created_by === 'patient' ? 'patient' : 'clinician',
          }))
          : [],
        dietMeals: Array.isArray(carePlan.diet_meals)
          ? carePlan.diet_meals.slice(0, 8).map((meal) => ({
            type: String(meal?.type || '').slice(0, 24),
            name: String(meal?.name || '').slice(0, 80),
          }))
          : [],
      } : null,
    };
  }

  streamChat = async (req, res, next) => {
    let messages;
    try {
      messages = this.streamPatientAssistantReplyUseCase.normalizeMessages(req.body?.messages);
    } catch (error) {
      return next(error);
    }

    const abortController = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abortController.abort();
    };
    res.on('close', onClose);
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': assistant stream ready\n\n');
    res.flush?.();

    try {
      const patientContext = await this._getPatientContext(req.user?.id);
      await this.streamPatientAssistantReplyUseCase.execute({
        messages,
        signal: abortController.signal,
        patientContext,
        onToken: async (text) => {
          if (res.destroyed || abortController.signal.aborted) return;
          res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
          res.flush?.();
        },
        onAction: async (action) => {
          if (res.destroyed || abortController.signal.aborted) return;
          res.write(`data: ${JSON.stringify({ type: 'action', action })}\n\n`);
          res.flush?.();
        },
      });
      if (!res.destroyed && !abortController.signal.aborted) {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      }
    } catch (error) {
      if (!res.destroyed && !abortController.signal.aborted) {
        const message = error?.statusCode === 503
          ? error.message
          : 'The assistant could not finish this reply. Please try again.';
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
        res.end();
      }
    } finally {
      res.off('close', onClose);
    }
  };
}
