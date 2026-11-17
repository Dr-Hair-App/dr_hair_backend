import { z } from 'zod';

export const bookAppointmentSchema = z.object({
  slot_date: z
    .string({ required_error: 'Appointment date is required' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  slot_time: z
    .string({ required_error: 'Appointment time slot is required' })
    .trim()
    .min(1, 'Time slot cannot be empty'),
  patient_name: z.string().trim().min(2).optional(),
  patient_phone: z.string().trim().optional(),
  notes: z.string().trim().max(1000).optional(),
});
