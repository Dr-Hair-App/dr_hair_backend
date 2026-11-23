import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdminController } from '../src/modules/admin/presentation/admin.controller.js';

const responseRecorder = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

describe('Admin prescription medicines', () => {
  it('sends an inbox and routine-screen push notification when a clinician adds routine steps', async () => {
    const notifications = [];
    let tokenLookups = 0;
    const controller = new AdminController({
      hairTestRepository: { findByReferenceNo: async (referenceNo) => ({ id: 101, reference_no: referenceNo, userId: 12 }) },
      treatmentRepository: { create: async (treatment) => ({ toResponse: () => ({ id: 51, ...treatment }) }) },
      notificationRepository: { create: async (item) => { const saved = { id: 'ntf-routine-1', ...item }; notifications.push(saved); return saved; } },
      deviceTokenRepository: { listByUserId: async (userId) => { assert.equal(userId, 12); tokenLookups += 1; return [{ token: 'mock-routine-device' }]; } },
    });
    const res = responseRecorder();

    await controller.createTreatment({ body: {
      reference_no: 'HT-2026-0042',
      treatment_name: 'Daily care plan',
      routine_steps: [{ title: 'Gentle scalp wash', subtitle: 'Wash as advised', category: 'Cleansing', time_of_day: 'Morning' }],
    } }, res, (error) => { throw error; });

    assert.equal(res.statusCode, 201);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].userId, 12);
    assert.equal(notifications[0].type, 'reminder');
    assert.equal(notifications[0].destination.screen, 'routine');
    assert.equal(tokenLookups, 1);
  });

  it('does not send a routine notification when the treatment has no routine steps', async () => {
    let notificationCalls = 0;
    const controller = new AdminController({
      hairTestRepository: { findByReferenceNo: async (referenceNo) => ({ id: 101, reference_no: referenceNo, userId: 12 }) },
      treatmentRepository: { create: async (treatment) => ({ toResponse: () => ({ id: 51, ...treatment }) }) },
      notificationRepository: { create: async () => { notificationCalls += 1; return {}; } },
    });
    await controller.createTreatment({ body: {
      reference_no: 'HT-2026-0042', treatment_name: 'Medication plan',
      medications: [{ name: 'Serum', dose: '1 ml', frequency: 'daily' }],
    } }, responseRecorder(), (error) => { throw error; });
    assert.equal(notificationCalls, 0);
  });

  it('notifies the patient when an existing routine plan is edited', async () => {
    const notifications = [];
    const plan = { id: 51, userId: 12, treatment_name: 'Daily care plan', routine_steps: [] };
    const controller = new AdminController({
      treatmentRepository: {
        findById: async () => plan,
        update: async (_id, patch) => ({ ...plan, ...patch, toResponse: () => ({ ...plan, ...patch }) }),
      },
      notificationRepository: { create: async (item) => { notifications.push(item); return { id: 'ntf-routine-update-1', ...item }; } },
    });
    const res = responseRecorder();

    await controller.updateTreatment({
      params: { treatmentId: '51' },
      body: { routine_steps: [{ title: 'Evening scalp care' }] },
      user: { role: 'super_admin', email: 'doctor@example.test' },
    }, res, (error) => { throw error; });

    assert.equal(res.statusCode, 200);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'Your daily routine was updated');
    assert.match(notifications[0].body, /updated care steps/);
    assert.equal(notifications[0].destination.screen, 'routine');
  });

  it('validates and saves selected medicines with a treatment plan', async () => {
    let saved;
    const controller = new AdminController({
      hairTestRepository: { findByReferenceNo: async (referenceNo) => ({ id: 101, reference_no: referenceNo, userId: 12 }) },
      treatmentRepository: { create: async (treatment) => { saved = treatment; return { toResponse: () => ({ id: 51, ...treatment }) }; } },
    });
    const res = responseRecorder();

    await controller.createTreatment({ body: {
      reference_no: 'HT-2026-0042',
      treatment_name: 'Hair care plan',
      duration: '90 days',
      doctor_name: 'Dr. Example',
      diagnosis: 'Clinician-reviewed diagnosis',
      stage: 'Stage 2',
      next_review_date: '2026-11-30',
      medications: [{ catalog_id: 'PRD-101', name: 'Follicle Booster Serum', category: 'Topical regrowth', form: 'Serum', dose: '1 ml', frequency: 'Nightly', duration: '', instructions: '' }],
      routine_steps: [{ title: 'Apply serum', subtitle: 'Use on a dry scalp', category: 'Scalp care', time_of_day: 'Night' }],
      diet_meals: [{ type: 'Breakfast', name: 'Patient-selected meal', nutrients: 'Protein', benefit: 'Clinician note' }],
    } }, res, (error) => { throw error; });

    assert.equal(res.statusCode, 201);
    assert.equal(saved.medications.length, 1);
    assert.equal(saved.medications[0].name, 'Follicle Booster Serum');
    assert.equal(saved.diagnosis, 'Clinician-reviewed diagnosis');
    assert.equal(saved.next_review_date, '2026-11-30');
    assert.equal(saved.routine_steps[0].time_of_day, 'Night');
    assert.equal(saved.diet_meals[0].name, 'Patient-selected meal');
    assert.deepEqual(res.body.data.medications, saved.medications);
  });

  it('rejects a medicine without a dose or frequency before saving', async () => {
    const controller = new AdminController({
      hairTestRepository: { findByReferenceNo: async (referenceNo) => ({ id: 101, reference_no: referenceNo, userId: 12 }) },
      treatmentRepository: { create: async () => assert.fail('invalid prescription must not be saved') },
    });
    let error;

    await controller.createTreatment({ body: {
      reference_no: 'HT-2026-0042', treatment_name: 'Hair care plan',
      medications: [{ name: 'A clinic medicine', dose: ' ', frequency: '' }],
    } }, responseRecorder(), (caught) => { error = caught; });

    assert.equal(error?.statusCode, 400);
    assert.match(error?.message || '', /name, dose, and frequency/i);
  });

  it('rejects malformed personalized care steps before saving', async () => {
    const controller = new AdminController({
      hairTestRepository: { findByReferenceNo: async () => ({ id: 101, reference_no: 'HT-2026-0042', userId: 12 }) },
      treatmentRepository: { create: async () => assert.fail('invalid care plan must not be saved') },
    });
    let error;

    await controller.createTreatment({ body: {
      reference_no: 'HT-2026-0042', treatment_name: 'Hair care plan',
      routine_steps: [{ title: ' ' }],
    } }, responseRecorder(), (caught) => { error = caught; });

    assert.equal(error?.statusCode, 400);
    assert.match(error?.message || '', /routine step needs a title/i);
  });
});
