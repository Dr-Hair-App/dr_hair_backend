import { BadRequestError } from '../../../shared/errors/index.js';

export function normalizePatientDietSuggestions(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new BadRequestError('patient_diet_suggestions must contain up to 20 items.');
  }

  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BadRequestError('Each patient diet suggestion must be an object.');
    }
    const id = String(item.id || '').trim();
    const name = String(item.name || '').trim();
    const frequency = String(item.frequency || '').trim();
    const startDate = String(item.start_date || '').trim();
    const reference = String(item.assessment_reference || '').trim();
    if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(id)) throw new BadRequestError('Diet suggestion id is invalid.');
    if (!name || name.length > 160) throw new BadRequestError('Diet suggestion name is required and must be at most 160 characters.');
    if (!['daily', 'alternate_days', 'weekly'].includes(frequency)) throw new BadRequestError('Diet suggestion frequency is invalid.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(Date.parse(`${startDate}T00:00:00Z`)) || new Date(`${startDate}T00:00:00Z`).toISOString().slice(0, 10) !== startDate) {
      throw new BadRequestError('Diet suggestion start_date must be a valid YYYY-MM-DD date.');
    }
    const weekdays = Array.isArray(item.weekdays)
      ? [...new Set(item.weekdays.map(Number))].sort((a, b) => a - b)
      : [];
    if (weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      throw new BadRequestError('Diet suggestion weekdays must be ISO weekdays from 1 to 7.');
    }
    if (frequency === 'weekly' && weekdays.length === 0) {
      throw new BadRequestError('Choose at least one weekday for a weekly food suggestion.');
    }
    if (reference.length > 100) throw new BadRequestError('Assessment reference is too long.');
    return {
      id,
      name,
      frequency,
      weekdays: frequency === 'weekly' ? weekdays : [],
      start_date: startDate,
      assessment_reference: reference,
      source: 'assessment_ai',
      active: item.active !== false,
    };
  });
}
