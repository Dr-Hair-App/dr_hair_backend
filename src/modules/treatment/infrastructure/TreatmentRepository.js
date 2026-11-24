import { ITreatmentRepository } from '../domain/ITreatmentRepository.js';
import { Treatment } from '../domain/Treatment.js';
import { store } from '../../../shared/database/store.js';
import { isDatabaseConnected } from '../../../shared/database/database.js';
import { TreatmentModel, nextId } from '../../../shared/database/models.js';

const toTreatment = (record) => {
  if (!record) return null;
  return new Treatment(typeof record.toObject === 'function' ? record.toObject() : record);
};

export class TreatmentRepository extends ITreatmentRepository {
  async findByTestIdentifier(referenceNoOrId, { userId } = {}) {
    const search = String(referenceNoOrId).trim();
    if (isDatabaseConnected()) {
      const numeric = Number(search);
      const filters = [{ reference_no: search }];
      if (Number.isFinite(numeric)) filters.push({ test_id: numeric }, { id: numeric });
      const query = { $or: filters };
      if (userId !== undefined) query.userId = Number(userId);
      const records = await TreatmentModel.find(query).sort({ date: -1 }).lean();
      return records.map(toTreatment);
    }
    const treatments = store.treatments.filter(
      (t) =>
        t.reference_no === search ||
        String(t.test_id) === search ||
        String(t.id) === search
    ).filter((t) =>
      userId === undefined || Number(t.userId) === Number(userId),
    );

    return treatments.map((t) => new Treatment(t));
  }

  async findByUserId(userId) {
    const numericId = Number(userId);
    if (isDatabaseConnected()) {
      const records = await TreatmentModel.find({ userId: numericId }).sort({ date: -1, id: -1 }).lean();
      return records.map(toTreatment);
    }
    return store.treatments
      .filter((record) => Number(record.userId) === numericId)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.id) - Number(a.id))
      .map((record) => new Treatment(record));
  }

  async create(treatmentData) {
    if (isDatabaseConnected()) {
      return toTreatment(
        await TreatmentModel.create({
          ...treatmentData,
          id: await nextId('treatments'),
          date: treatmentData.date || new Date().toISOString().split('T')[0],
        }),
      );
    }
    const newId = store.treatments.length > 0 ? Math.max(...store.treatments.map((t) => t.id)) + 1 : 1;
    const newRecord = {
      ...treatmentData,
      id: newId,
      date: treatmentData.date || new Date().toISOString().split('T')[0],
    };

    store.treatments.push(newRecord);
    return new Treatment(newRecord);
  }

  async list({ page = 1, limit = 25 } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    if (isDatabaseConnected()) {
      const [records, total] = await Promise.all([
        TreatmentModel.find().sort({ date: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
        TreatmentModel.countDocuments(),
      ]);
      return { items: records.map(toTreatment), total, page: safePage, limit: safeLimit };
    }
    const start = (safePage - 1) * safeLimit;
    return {
      items: store.treatments.slice(start, start + safeLimit).map((record) => new Treatment(record)),
      total: store.treatments.length,
      page: safePage,
      limit: safeLimit,
    };
  }

  async findById(treatmentId) {
    const numericId = Number(treatmentId);
    if (isDatabaseConnected()) {
      const record = await TreatmentModel.findOne({
        $or: [{ id: numericId }, { _id: treatmentId }],
      }).lean();
      return record ? toTreatment(record) : null;
    }
    const record = store.treatments.find((t) => Number(t.id) === numericId || String(t.id) === String(treatmentId));
    return record ? new Treatment(record) : null;
  }

  async update(treatmentId, updateData) {
    const numericId = Number(treatmentId);
    const safeData = { ...updateData, updated_at: new Date().toISOString() };
    if (isDatabaseConnected()) {
      const record = await TreatmentModel.findOneAndUpdate(
        { $or: [{ id: numericId }, { _id: treatmentId }] },
        { $set: safeData },
        { new: true },
      ).lean();
      return record ? toTreatment(record) : null;
    }
    const idx = store.treatments.findIndex((t) => Number(t.id) === numericId || String(t.id) === String(treatmentId));
    if (idx === -1) return null;
    Object.assign(store.treatments[idx], safeData);
    return new Treatment(store.treatments[idx]);
  }

  async withdraw(treatmentId, { reason = '', actor = '' } = {}) {
    const numericId = Number(treatmentId);
    const withdrawData = {
      status: 'withdrawn',
      withdrawn_at: new Date().toISOString(),
      withdrawn_reason: String(reason || 'Withdrawn by clinical admin').slice(0, 500),
      withdrawn_by: String(actor || 'Admin'),
      updated_at: new Date().toISOString(),
    };
    if (isDatabaseConnected()) {
      const record = await TreatmentModel.findOneAndUpdate(
        { $or: [{ id: numericId }, { _id: treatmentId }] },
        { $set: withdrawData },
        { new: true },
      ).lean();
      return record ? toTreatment(record) : null;
    }
    const idx = store.treatments.findIndex((t) => Number(t.id) === numericId || String(t.id) === String(treatmentId));
    if (idx === -1) return null;
    Object.assign(store.treatments[idx], withdrawData);
    return new Treatment(store.treatments[idx]);
  }

  async updateDietMeals(userId, dietMeals) {
    const numericId = Number(userId);
    const meals = Array.isArray(dietMeals) ? dietMeals : [];
    if (isDatabaseConnected()) {
      let treatment = await TreatmentModel.findOne({ userId: numericId }).sort({ date: -1, id: -1 });
      if (treatment) {
        treatment.diet_meals = meals;
        await treatment.save();
        return toTreatment(treatment);
      }
      return toTreatment(
        await TreatmentModel.create({
          id: await nextId('treatments'),
          userId: numericId,
          treatment_name: 'Nutritional Care Plan',
          diet_meals: meals,
          date: new Date().toISOString().split('T')[0],
        }),
      );
    }
    let treatment = store.treatments.find((t) => Number(t.userId) === numericId);
    if (treatment) {
      treatment.diet_meals = meals;
      return new Treatment(treatment);
    }
    const newId = store.treatments.length > 0 ? Math.max(...store.treatments.map((t) => t.id)) + 1 : 1;
    const newRecord = {
      id: newId,
      userId: numericId,
      treatment_name: 'Nutritional Care Plan',
      diet_meals: meals,
      date: new Date().toISOString().split('T')[0],
    };
    store.treatments.push(newRecord);
    return new Treatment(newRecord);
  }

  async updatePatientDietSuggestions(userId, referenceNo, suggestions) {
    const numericId = Number(userId);
    const ref = String(referenceNo || '').trim();
    const items = Array.isArray(suggestions) ? suggestions : [];
    if (isDatabaseConnected()) {
      let treatment = await TreatmentModel.findOne({ userId: numericId, reference_no: ref }).sort({ date: -1, id: -1 });
      if (treatment) {
        treatment.patient_diet_suggestions = items;
        await treatment.save();
        return toTreatment(treatment);
      }
      return toTreatment(await TreatmentModel.create({
        id: await nextId('treatments'),
        userId: numericId,
        reference_no: ref,
        treatment_name: 'Patient-selected AI food suggestions',
        patient_diet_suggestions: items,
        date: new Date().toISOString().split('T')[0],
      }));
    }

    const treatment = store.treatments.find((item) =>
      Number(item.userId) === numericId && String(item.reference_no || '') === ref,
    );
    if (treatment) {
      treatment.patient_diet_suggestions = items;
      treatment.updated_at = new Date().toISOString();
      return new Treatment(treatment);
    }
    const id = store.treatments.length > 0 ? Math.max(...store.treatments.map((item) => Number(item.id) || 0)) + 1 : 1;
    const record = {
      id,
      userId: numericId,
      reference_no: ref,
      treatment_name: 'Patient-selected AI food suggestions',
      patient_diet_suggestions: items,
      date: new Date().toISOString().split('T')[0],
      status: 'active',
    };
    store.treatments.push(record);
    return new Treatment(record);
  }

  async getRoutineSteps(userId) {
    const numericId = Number(userId);
    if (isDatabaseConnected()) {
      const treatment = await TreatmentModel.findOne({ userId: numericId }).sort({ date: -1, id: -1 }).lean();
      return treatment?.routine_steps || [];
    }
    const treatment = store.treatments.find((t) => Number(t.userId) === numericId);
    return treatment?.routine_steps || [];
  }

  async addRoutineStep(userId, step) {
    const numericId = Number(userId);
    const cleanStep = {
      title: String(step.title || '').trim(),
      subtitle: String(step.subtitle || '').trim(),
      category: String(step.category || 'Lifestyle').trim(),
      time_of_day: String(step.time_of_day || 'Daily').trim(),
      created_by: 'patient',
    };

    if (isDatabaseConnected()) {
      let treatment = await TreatmentModel.findOne({ userId: numericId }).sort({ date: -1, id: -1 });
      if (treatment) {
        treatment.routine_steps = [...(treatment.routine_steps || []), cleanStep];
        await treatment.save();
        return treatment.routine_steps;
      }
      const created = await TreatmentModel.create({
        id: await nextId('treatments'),
        userId: numericId,
        treatment_name: 'Personalized Daily Routine',
        routine_steps: [cleanStep],
        date: new Date().toISOString().split('T')[0],
      });
      return created.routine_steps;
    }

    let treatment = store.treatments.find((t) => Number(t.userId) === numericId);
    if (treatment) {
      treatment.routine_steps = [...(treatment.routine_steps || []), cleanStep];
      return treatment.routine_steps;
    }
    const newId = store.treatments.length > 0 ? Math.max(...store.treatments.map((t) => t.id)) + 1 : 1;
    const newRecord = {
      id: newId,
      userId: numericId,
      treatment_name: 'Personalized Daily Routine',
      routine_steps: [cleanStep],
      date: new Date().toISOString().split('T')[0],
    };
    store.treatments.push(newRecord);
    return newRecord.routine_steps;
  }

  async removeRoutineStep(userId, stepIndex) {
    const numericId = Number(userId);
    const index = parseInt(stepIndex, 10);
    if (isDatabaseConnected()) {
      let treatment = await TreatmentModel.findOne({ userId: numericId }).sort({ date: -1, id: -1 });
      if (treatment && Array.isArray(treatment.routine_steps)) {
        if (index >= 0 && index < treatment.routine_steps.length) {
          treatment.routine_steps.splice(index, 1);
          await treatment.save();
        }
        return treatment.routine_steps;
      }
      return [];
    }
    let treatment = store.treatments.find((t) => Number(t.userId) === numericId);
    if (treatment && Array.isArray(treatment.routine_steps)) {
      if (index >= 0 && index < treatment.routine_steps.length) {
        treatment.routine_steps.splice(index, 1);
      }
      return treatment.routine_steps;
    }
    return [];
  }

  async getReminders(userId) {
    const numericId = Number(userId);
    if (isDatabaseConnected()) {
      const treatment = await TreatmentModel.findOne({ userId: numericId }).sort({ date: -1, id: -1 }).lean();
      return treatment?.care_reminders || [];
    }
    const treatment = store.treatments.find((t) => Number(t.userId) === numericId);
    return treatment?.care_reminders || [];
  }

  async saveReminder(userId, reminder) {
    const numericId = Number(userId);
    if (isDatabaseConnected()) {
      let treatment = await TreatmentModel.findOne({ userId: numericId }).sort({ date: -1, id: -1 });
      if (treatment) {
        const existing = Array.isArray(treatment.care_reminders) ? [...treatment.care_reminders] : [];
        const idx = existing.findIndex((r) => r.id === reminder.id);
        if (idx >= 0) {
          existing[idx] = reminder;
        } else {
          existing.push(reminder);
        }
        treatment.care_reminders = existing;
        await treatment.save();
        return treatment.care_reminders;
      }
      const created = await TreatmentModel.create({
        id: await nextId('treatments'),
        userId: numericId,
        treatment_name: 'Personalized Care Reminders',
        care_reminders: [reminder],
        date: new Date().toISOString().split('T')[0],
      });
      return created.care_reminders;
    }

    let treatment = store.treatments.find((t) => Number(t.userId) === numericId);
    if (treatment) {
      if (!Array.isArray(treatment.care_reminders)) {
        treatment.care_reminders = [];
      }
      const idx = treatment.care_reminders.findIndex((r) => r.id === reminder.id);
      if (idx >= 0) {
        treatment.care_reminders[idx] = reminder;
      } else {
        treatment.care_reminders.push(reminder);
      }
      return treatment.care_reminders;
    }
    const newId = store.treatments.length > 0 ? Math.max(...store.treatments.map((t) => t.id)) + 1 : 1;
    const newRecord = {
      id: newId,
      userId: numericId,
      treatment_name: 'Personalized Care Reminders',
      care_reminders: [reminder],
      date: new Date().toISOString().split('T')[0],
    };
    store.treatments.push(newRecord);
    return newRecord.care_reminders;
  }

  async deleteReminder(userId, reminderId) {
    const numericId = Number(userId);
    const searchId = String(reminderId).trim();
    if (isDatabaseConnected()) {
      let treatment = await TreatmentModel.findOne({ userId: numericId }).sort({ date: -1, id: -1 });
      if (treatment && Array.isArray(treatment.care_reminders)) {
        treatment.care_reminders = treatment.care_reminders.filter((r) => r.id !== searchId);
        await treatment.save();
        return treatment.care_reminders;
      }
      return [];
    }
    let treatment = store.treatments.find((t) => Number(t.userId) === numericId);
    if (treatment && Array.isArray(treatment.care_reminders)) {
      treatment.care_reminders = treatment.care_reminders.filter((r) => r.id !== searchId);
      return treatment.care_reminders;
    }
    return [];
  }
}

