import test from 'node:test';
import assert from 'node:assert/strict';
import { SubmitHairTestUseCase } from '../src/modules/hair_test/application/SubmitHairTestUseCase.js';
import { ProcessQueuedAiAssessmentUseCase } from '../src/modules/hair_test/application/ProcessQueuedAiAssessmentUseCase.js';
import { HairTestRepository } from '../src/modules/hair_test/infrastructure/HairTestRepository.js';
import { runWithExecutionContext } from '../src/shared/runtime/execution-context.js';
import { store } from '../src/shared/database/store.js';

test('background submission returns a saved report before AI finishes and targets the new job', async (t) => {
  const userId = 98765432;
  t.after(() => { store.hairTests = store.hairTests.filter((item) => item.userId !== userId); });
  const repository = new HairTestRepository();
  const earlier = await repository.create({ userId, full_name: 'Earlier synthetic patient', status: 'submitted', ai_assessment_status: 'queued', ai_assessment: null });
  let finishAi;
  const ai = { generateHairTestAssessment: () => new Promise((resolve) => { finishAi = resolve; }) };
  const processor = new ProcessQueuedAiAssessmentUseCase({ hairTestRepository: repository, geminiAiService: ai, logger: {} });
  const submit = new SubmitHairTestUseCase({ hairTestRepository: repository, geminiAiService: ai, processQueuedAiAssessmentUseCase: processor });
  const jobs = [];
  const result = await runWithExecutionContext({ waitUntil: (job) => jobs.push(job) }, () => submit.execute({
    userId, formData: { full_name: 'Synthetic patient', background_ai: 'true', submission_key: 'c'.repeat(64) },
  }));
  assert.equal(result.ai_assessment_status, 'queued');
  assert.equal(jobs.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishAi, 'function');
  assert.equal((await repository.findBySubmissionKey(userId, 'c'.repeat(64))).ai_assessment_status, 'processing');
  finishAi({ ai_status: 'ready', summary: 'Synthetic result' });
  await Promise.all(jobs);
  assert.equal((await repository.findBySubmissionKey(userId, 'c'.repeat(64))).ai_assessment_status, 'ready');
  assert.equal(store.hairTests.find((item) => item.reference_no === earlier.reference_no).ai_assessment_status, 'queued');
});
