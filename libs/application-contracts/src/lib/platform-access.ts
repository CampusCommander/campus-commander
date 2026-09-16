import * as z from 'zod';
import { grantsSchema } from './authorization';

export const platformPrincipalSchema = z.strictObject({
  id: z.uuid(),
  issuer: z.string(),
  subject: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  permissionVersion: z.number().int().positive(),
  permissions: z.array(
    z.enum(['identity:read', 'diagnostics:read', 'diagnostics:run']),
  ),
  grants: grantsSchema,
});
export type PlatformPrincipal = z.infer<typeof platformPrincipalSchema>;
export const platformPrincipalPageSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  items: z.array(platformPrincipalSchema).max(100),
});
export const platformAccessChangeSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  enabled: z.boolean(),
  grants: grantsSchema,
});
export type PlatformAccessChange = z.infer<typeof platformAccessChangeSchema>;
export const platformAccessReviewSchema = z.strictObject({
  current: platformPrincipalSchema,
  proposed: z.strictObject({ enabled: z.boolean(), grants: grantsSchema }),
  actorVersion: z.number().int().positive(),
  targetVersion: z.number().int().positive(),
});
export type PlatformAccessReview = z.infer<typeof platformAccessReviewSchema>;
export const platformAccessResultSchema = z.strictObject({
  receiptId: z.uuid(),
  correlationId: z.uuid(),
  principal: platformPrincipalSchema,
});
