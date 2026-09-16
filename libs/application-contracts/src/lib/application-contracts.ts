import * as z from 'zod';
import { grantsSchema } from './authorization';

export const applicationMetadataSchema = z.strictObject({
  phase: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  authenticationConfigured: z.boolean(),
  version: z.string().min(1).max(80),
  build: z.string().min(1).max(128),
});
export type ApplicationMetadata = z.infer<typeof applicationMetadataSchema>;

export const permissionSchema = z.enum([
  'identity:read',
  'diagnostics:read',
  'diagnostics:run',
]);
export const securityEventSchema = z.enum([
  'login-started',
  'login-succeeded',
  'login-denied',
  'logout',
  'access-denied',
  'session-expired',
  'access-granted',
  'access-revoked',
  'identity-replaced',
  'diagnostic-started',
  'diagnostic-passed',
  'diagnostic-failed',
  'preferences-changed',
  'platform-administrator-confirmed',
  'grants-changed',
  'principal-disabled',
  'principal-enabled',
  'invitation-created',
  'invitation-redeemed',
  'invitation-confirmed',
  'invitation-revoked',
  'invitation-expired',
  'customer-confirmed',
  'customer-settings-changed',
  'connection-staged',
  'connection-stage-failed',
  'connection-stage-expired',
  'connection-token-renewed',
  'connection-token-failed',
  'connection-authorized',
  'connection-replaced',
  'connection-revoked',
  'connection-checked',
  'credential-key-rotated',
  'school-scope-changed',
  'recovery-required',
]);
export type SecurityEvent = z.infer<typeof securityEventSchema>;
export const preferencesSchema = z.strictObject({
  theme: z.enum(['system', 'light', 'dark']),
  navigationCollapsed: z.boolean(),
});
export const identitySchema = z.strictObject({
  id: z.uuid(),
  displayName: z.string().min(1).max(200),
  permissions: z.array(permissionSchema).max(3),
  permissionVersion: z.number().int().positive().default(1),
  grants: grantsSchema.default([]),
  preferences: preferencesSchema,
});
export const sessionResponseSchema = z.strictObject({
  identity: identitySchema,
  expiresAt: z.iso.datetime(),
  csrfToken: z.string().regex(/^[a-f0-9]{64}$/),
});
export const diagnosticOperationSchema = z.enum([
  'postgresql',
  'redis',
  'kestra',
  'artifacts',
]);
export const diagnosticResultSchema = z.strictObject({
  operation: diagnosticOperationSchema,
  status: z.enum(['passed', 'failed', 'unavailable', 'timed-out']),
  observedAt: z.iso.datetime(),
  correlationId: z.uuid(),
  message: z.string().min(1).max(500),
});
export const dependencyHealthSchema = z.strictObject({
  status: z.enum(['ready', 'not-ready']),
  observedAt: z.iso.datetime(),
  checks: z
    .array(
      z.strictObject({
        name: z.string().max(80),
        status: z.enum(['ready', 'not-ready']),
      }),
    )
    .max(20),
});
export const applicationErrorSchema = z.strictObject({
  code: z.enum([
    'unauthenticated',
    'forbidden',
    'invalid-request',
    'unavailable',
    'busy',
    'not-found',
    'conflict',
  ]),
  message: z.string().min(1).max(500),
  correlationId: z.uuid(),
});
export type Permission = z.infer<typeof permissionSchema>;
export type Identity = z.infer<typeof identitySchema>;
export type Preferences = z.infer<typeof preferencesSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type DiagnosticOperation = z.infer<typeof diagnosticOperationSchema>;
export type DiagnosticResult = z.infer<typeof diagnosticResultSchema>;
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;
