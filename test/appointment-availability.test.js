import test from 'node:test';
import assert from 'node:assert/strict';
import { createContainer } from '../src/container.js';
import { store } from '../src/shared/database/store.js';

const mockResponse = () => ({
  statusCode: 200,
  data: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.data = payload; return this; },
});

test('public appointment availability exposes clinic-local slots without patient data', async (t) => {
  const container = createContainer();
  const { appointmentRepository } = container.repositories;
  const { appointmentController } = container.controllers;
  await container.repositories.featureFlagRepository.setFlag('clinic_appointment_schedule', {
    group: 'Appointments', enabled: true,
    metadata: { booking_window_days: 90, weekly_closed_weekdays: [7], slot_interval_minutes: 30, appointment_duration_minutes: 30, appointment_services: ['Consultation'], sessions: [
      { label: 'Morning Session', opens_at: '10:00', closes_at: '12:30' },
      { label: 'Evening Session', opens_at: '15:30', closes_at: '18:30' },
    ] },
  });
  store.appointments = [];
  store.clinicClosedDates = [];
  t.after(() => {
    store.appointments = [];
    store.clinicClosedDates = [];
  });

  await appointmentRepository.addClosedDate({ date: '2026-12-01', reason: 'Clinic holiday' });
  await appointmentRepository.create({
    userId: 42,
    patient_code: 'PRIVATE-CODE',
    reason: 'Private patient reason',
    status: 'Confirmed',
    starts_at: new Date('2026-12-02T10:30:00+05:30').toISOString(),
  });
  await appointmentRepository.create({
    userId: 43,
    reason: 'Cancelled booking',
    status: 'Cancelled',
    starts_at: new Date('2026-12-02T11:00:00+05:30').toISOString(),
  });

  const res = mockResponse();
  await appointmentController.getPatientAvailability(
    { query: { from: '2026-12-02', to: '2026-12-02' } },
    res,
    (error) => { throw error; },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.data.timezone, 'Asia/Kolkata');
  assert.equal(res.data.data.booking_window_days, 90);
  assert.equal(res.data.data.slot_interval_minutes, 30);
  assert.equal(res.data.data.is_configured, true);
  assert.deepEqual(res.data.data.weekly_closed_weekdays, [7]);
  assert.deepEqual(res.data.data.booked_slots, ['2026-12-02T10:30']);
  assert.deepEqual(res.data.data.closed_dates, []);
  assert.equal(JSON.stringify(res.data).includes('PRIVATE-CODE'), false);
  assert.equal(JSON.stringify(res.data).includes('Private patient reason'), false);
  assert.equal(JSON.stringify(res.data).includes('Clinic holiday'), false);
  assert.equal(JSON.stringify(res.data).includes('Cancelled booking'), false);
});

test('availability includes closed dates and rejects invalid or oversized ranges', async () => {
  const container = createContainer();
  const { appointmentController } = container.controllers;
  await container.repositories.featureFlagRepository.setFlag('clinic_appointment_schedule', {
    group: 'Appointments', enabled: true,
    metadata: { booking_window_days: 60, weekly_closed_weekdays: [], slot_interval_minutes: 15, appointment_duration_minutes: 15, appointment_services: ['Consultation'], sessions: [
      { label: 'Clinic', opens_at: '09:00', closes_at: '17:00' },
    ] },
  });
  await container.repositories.appointmentRepository.addClosedDate({
    date: '2026-12-01',
    reason: 'Clinic holiday',
  });
  const call = async (query) => {
    let error;
    const res = mockResponse();
    await appointmentController.getPatientAvailability({ query }, res, (value) => { error = value; });
    return { res, error };
  };

  const closed = await call({ from: '2026-12-01', to: '2026-12-01' });
  assert.deepEqual(closed.res.data.data.closed_dates, [{ date: '2026-12-01' }]);

  const invalidDate = await call({ from: '2026-02-31', to: '2026-03-01' });
  assert.match(invalidDate.error.message, /valid YYYY-MM-DD/);

  const oversized = await call({ from: '2026-12-01', to: '2027-01-12' });
  assert.match(oversized.error.message, /cannot exceed 41/);
});

test('availability uses the persisted clinic timezone when querying booked slots', async (t) => {
  const container = createContainer();
  await container.repositories.featureFlagRepository.setFlag('clinic_appointment_schedule', {
    group: 'Appointments', enabled: true,
    metadata: {
      timezone: 'America/Los_Angeles', booking_window_days: 30, weekly_closed_weekdays: [],
      slot_interval_minutes: 30, appointment_duration_minutes: 30, appointment_services: ['Consultation'],
      sessions: [{ label: 'Clinic', opens_at: '09:00', closes_at: '12:00' }],
    },
  });
  store.appointments = [];
  t.after(() => { store.appointments = []; });
  await container.repositories.appointmentRepository.create({
    userId: 66, starts_at: new Date('2026-12-02T10:30:00-08:00').toISOString(), status: 'Confirmed',
  });
  const res = mockResponse();
  await container.controllers.appointmentController.getPatientAvailability(
    { query: { from: '2026-12-02', to: '2026-12-02' } }, res, (error) => { throw error; },
  );
  assert.equal(res.data.data.timezone, 'America/Los_Angeles');
  assert.deepEqual(res.data.data.booked_slots, ['2026-12-02T10:30']);
});

test('admin saves a valid clinic timezone and rejects unsupported timezone names', async () => {
  const container = createContainer();
  const { appointmentController } = container.controllers;
  const payload = {
    timezone: 'America/Los_Angeles',
    booking_window_days: 45,
    weekly_closed_weekdays: [7],
    slot_interval_minutes: 30,
    sessions: [{ label: 'Clinic', opens_at: '09:00', closes_at: '17:00' }],
    clinic_name: 'Test Clinic',
    clinic_address: 'Test address',
    doctor_name: 'Test Clinician',
    room: 'Room 1',
    appointment_duration_minutes: 30,
    appointment_services: ['Consultation'],
  };
  const call = async (body) => {
    const res = mockResponse();
    let error;
    await appointmentController.updateScheduleConfigAdmin(
      { body, user: { email: 'admin@example.test' } }, res, (value) => { error = value; },
    );
    return { res, error };
  };

  const saved = await call(payload);
  assert.equal(saved.error, undefined);
  assert.equal(saved.res.data.data.timezone, 'America/Los_Angeles');
  assert.equal(saved.res.data.data.is_configured, true);

  const rejected = await call({ ...payload, timezone: 'Not/A_Time_Zone' });
  assert.match(rejected.error.message, /valid IANA clinic timezone/);
  const overlapping = await call({ ...payload, slot_interval_minutes: 15, appointment_duration_minutes: 30 });
  assert.match(overlapping.error.message, /prevent overlapping visits/);
  assert.equal((await appointmentController.getScheduleConfig()).timezone, 'America/Los_Angeles');
});
