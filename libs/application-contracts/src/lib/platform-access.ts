import * as z from 'zod';
import { grantsSchema } from './authorization';
import { googleCustomerIdSchema } from './google-connection';

export const schoolGrantRevisionsSchema = z
  .array(
    z.strictObject({
      schoolId: z.uuid(),
      customerId: googleCustomerIdSchema,
      revision: z.number().int().positive(),
    }),
  )
  .max(256)
  .default([]);

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
  schoolRevisions: schoolGrantRevisionsSchema,
  invitationsToRevoke: z
    .array(z.strictObject({ id: z.uuid(), label: z.string() }))
    .max(50),
});
export type PlatformAccessReview = z.infer<typeof platformAccessReviewSchema>;
export const platformAccessResultSchema = z.strictObject({
  receiptId: z.uuid(),
  correlationId: z.uuid(),
  principal: platformPrincipalSchema,
});

export const platformAccessRejectionSchema = z.strictObject({
  reason: z.enum([
    'unchanged',
    'invitations-changed',
    'school-changed',
    'school-unavailable',
    'conflict',
    'delegation',
    'last-administrator',
    'forbidden',
  ]),
});
export const platformAccessReceiptSchema = z.strictObject({
  id: z.uuid(),
  actorId: z.uuid(),
  principalId: z.uuid(),
  correlationId: z.uuid(),
  createdAt: z.string(),
  revokedInvitationIds: z.array(z.uuid()).max(50),
  schoolRevisions: schoolGrantRevisionsSchema,
  previousVersion: z.number().int().positive(),
  permissionVersion: z.number().int().positive(),
  previous: z.strictObject({ enabled: z.boolean(), grants: grantsSchema }),
  applied: z.strictObject({ enabled: z.boolean(), grants: grantsSchema }),
});
export const platformAccessReceiptPageSchema = z.strictObject({
  items: z.array(platformAccessReceiptSchema).max(20),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type PlatformAccessReceiptPage = z.infer<
  typeof platformAccessReceiptPageSchema
>;
