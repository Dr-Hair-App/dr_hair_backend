/**
 * Treatment Domain Entity
 */
export class Treatment {
  constructor({
    id,
    test_id,
    reference_no,
    userId,
    treatment_name,
    duration,
    instructions,
    doctor_name,
    reviewed_by = '',
    medications = [],
    diagnosis = '',
    stage = '',
    next_review_date = '',
    routine_steps = [],
    diet_meals = [],
    patient_diet_suggestions = [],
    date = new Date().toISOString().split('T')[0],
    status = 'active',
    withdrawn_at = null,
    withdrawn_reason = null,
    withdrawn_by = '',
    updated_at = null,
  }) {
    this.id = id;
    this.test_id = test_id;
    this.reference_no = reference_no;
    this.userId = userId;
    this.treatment_name = treatment_name;
    this.duration = duration;
    this.instructions = instructions;
    this.doctor_name = doctor_name;
    this.reviewed_by = reviewed_by;
    this.medications = medications;
    this.diagnosis = diagnosis;
    this.stage = stage;
    this.next_review_date = next_review_date;
    this.routine_steps = routine_steps;
    this.diet_meals = diet_meals;
    this.patient_diet_suggestions = patient_diet_suggestions;
    this.date = date;
    this.status = status;
    this.withdrawn_at = withdrawn_at;
    this.withdrawn_reason = withdrawn_reason;
    this.withdrawn_by = withdrawn_by;
    this.updated_at = updated_at;
  }

  toResponse() {
    return {
      id: this.id,
      treatment_name: this.treatment_name,
      duration: this.duration,
      instructions: this.instructions,
      doctor_name: this.doctor_name,
      reviewed_by: this.reviewed_by,
      medications: this.medications,
      diagnosis: this.diagnosis,
      stage: this.stage,
      next_review_date: this.next_review_date,
      routine_steps: this.routine_steps,
      diet_meals: this.diet_meals,
      patient_diet_suggestions: this.patient_diet_suggestions,
      date: this.date,
      status: this.status || 'active',
      withdrawn_at: this.withdrawn_at || null,
      withdrawn_reason: this.withdrawn_reason || null,
      withdrawn_by: this.withdrawn_by || '',
      updated_at: this.updated_at || null,
    };
  }
}

