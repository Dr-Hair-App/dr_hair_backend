import { z } from 'zod';

export const adminApiTrafficQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  window: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
  statusClass: z.enum(['2xx', '4xx', '5xx']).optional(),
}).strict();
