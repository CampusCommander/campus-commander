import { z } from 'zod';
import { grantsSchema } from './authorization';

export const invitationTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const createInvitationSchema = z.strictObject({
  label: z.string().trim().min(1).max(120),
  expectedSubject: z.string().trim().min(1).max(512).optional(),
  expiresInHours: z.number().int().min(1).max(168),
  grants: grantsSchema
    .max(11)
    .refine(
      (grants) => grants.every((grant) => grant.scope.kind === 'platform'),
      {
        message:
          'District and school invitations require their verified resource configuration.',
      },
    )
    .refine(
      (grants) =>
        new Set(grants.map((grant) => grant.action)).size === grants.length,
      { message: 'Each grant must appear once.' },
    ),
});
export type CreateInvitation = z.infer<typeof createInvitationSchema>;
export const invitationStatusSchema = z.enum([
  'issued',
  'redeeming',
  'pending',
  'accepted',
  'revoked',
  'expired',
]);
export const invitationSchema = z.strictObject({
  id: z.uuid(),
  createdBy: z.uuid(),
  label: z.string(),
  issuer: z.string(),
  expectedSubject: z.string().nullable(),
  grants: grantsSchema,
  status: invitationStatusSchema,
  candidateSubject: z.string().nullable(),
  candidateName: z.string().nullable(),
  version: z.number().int().positive(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type Invitation = z.infer<typeof invitationSchema>;
export const invitationRevisionSchema = z.strictObject({
  version: z.number().int().positive(),
});
export const confirmInvitationSchema = invitationRevisionSchema.extend({
  subject: z.string().min(1).max(512),
});
