import { z } from 'zod';

const adminReviewFields = {
  name: z.string().trim().min(2).max(80),
  rating: z.number().int().min(1).max(5),
  category: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(1500),
  avatar: z.string().trim().max(2048).optional().default(''),
  media_assets: z.record(z.string(), z.unknown()).optional(),
  treatment: z.string().trim().max(120).optional().default(''),
  duration: z.string().trim().max(120).optional().default(''),
  review_type: z.enum(['doctor', 'product', 'clinic']).optional().default('doctor'),
  product_id: z.string().trim().max(100).optional(),
  page: z.enum(['home', 'reels']).optional().default('home'),
  status: z.enum(['draft', 'pending', 'active', 'rejected']).optional().default('draft'),
  patient_consent_confirmed: z.boolean().optional().default(false),
};

export const createAdminReviewSchema = z.object(adminReviewFields).strict();

export const updateAdminReviewSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  message: z.string().trim().min(1).max(1500).optional(),
  avatar: z.string().trim().max(2048).optional(),
  media_assets: z.record(z.string(), z.unknown()).optional(),
  treatment: z.string().trim().max(120).optional(),
  duration: z.string().trim().max(120).optional(),
  review_type: z.enum(['doctor', 'product', 'clinic']).optional(),
  product_id: z.string().trim().max(100).optional(),
  page: z.enum(['home', 'reels']).optional(),
  patient_consent_confirmed: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one review field to update.' });

export const adminReviewStatusSchema = z.object({
  id: z.coerce.number().int().positive(),
  status: z.enum(['draft', 'pending', 'active', 'rejected']),
}).strict();

export const adminReviewIdSchema = z.object({ id: z.string().regex(/^\d+$/, 'Review ID must be numeric.') });

export const createReviewSchema = z.object({
  name: z.string({ required_error: 'Name is required' }).trim().min(2, 'Name must be at least 2 characters'),
  rating: z.coerce
    .number({ required_error: 'Rating is required' })
    .min(1, 'Rating must be at least 1')
    .max(5, 'Rating cannot exceed 5'),
  category: z.string().trim().optional(),
  message: z.string().trim().optional(),
  avatar: z.string().trim().optional(),
  review_type: z.string().trim().optional(),
  product_id: z.string().trim().max(100).optional(),
  page: z.string().trim().optional(),
});
