import { z } from 'zod';

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
  page: z.string().trim().optional(),
});
