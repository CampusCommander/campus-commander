import * as z from 'zod';

/**
 * The display ID of one job: its prefix and a number of at least three digits. The prefixes are the
 * sections 1.4 and 1.6 of the write job design and the export and import kinds (design section 1).
 * The category job adds `CAT` (document B section 7.1), and the value job adds `UAT` (document B
 * section 7.2).
 *
 * The module holds the IDs alone, so the user contracts and the job contracts both read them
 * without a module cycle.
 */
export const jobDisplayIdSchema = z
  .string()
  .regex(/^(UPD|REF|CMD|STS|EXP|IMP|CAT|UAT)-\d{3,}$/);
export type JobDisplayId = z.infer<typeof jobDisplayIdSchema>;

/** The display ID of one device update preview. */
export const previewDisplayIdSchema = z.string().regex(/^PV-\d{3,}$/);
export type PreviewDisplayId = z.infer<typeof previewDisplayIdSchema>;
