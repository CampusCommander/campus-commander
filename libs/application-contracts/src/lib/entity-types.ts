import * as z from 'zod';

/**
 * The two entity types that the cache, the sync jobs, and the Jobs grid name (document A section 5).
 * This module holds no import, because both the cache and the job contracts read it.
 */
export const entityTypeSchema = z.enum(['device', 'user']);
export type EntityType = z.infer<typeof entityTypeSchema>;
