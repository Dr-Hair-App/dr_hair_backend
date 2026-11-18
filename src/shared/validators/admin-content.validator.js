import { z } from 'zod';

const contentFields = {
  type: z.enum(['banner', 'faq', 'tip', 'story', 'home_placement']),
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().max(500).optional(),
  content: z.string().trim().max(12000).optional(),
  imageUrl: z.string().trim().max(2048).optional(),
  actionUrl: z.string().trim().max(2048).optional(),
  placement: z.enum(['home', 'reels', 'care', 'explore', 'all']).optional(),
  sortOrder: z.number().int().min(-100000).max(100000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['draft', 'review', 'published', 'hidden', 'archived']).optional(),
  patient_consent_confirmed: z.boolean().optional(),
};

export const createAdminContentSchema = z.object(contentFields).strict().superRefine((value, context) => {
  if (value.type === 'banner' && !value.imageUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['imageUrl'], message: 'A banner image URL is required.' });
  }
  if (value.status === 'published' && value.type === 'story' && value.patient_consent_confirmed !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['patient_consent_confirmed'], message: 'Confirm patient consent before publishing a story.' });
  }
});

export const updateAdminContentSchema = z.object({
  title: contentFields.title.optional(),
  subtitle: contentFields.subtitle,
  content: contentFields.content,
  imageUrl: contentFields.imageUrl,
  actionUrl: contentFields.actionUrl,
  placement: contentFields.placement,
  sortOrder: contentFields.sortOrder,
  metadata: contentFields.metadata,
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one content field to update.' });

export const updateAdminContentStatusSchema = z.object({
  status: z.enum(['draft', 'review', 'published', 'hidden', 'archived']),
  note: z.string().trim().max(500).optional(),
  patient_consent_confirmed: z.boolean().optional(),
}).strict();

export const adminContentIdSchema = z.object({
  id: z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9_-]+$/),
});
