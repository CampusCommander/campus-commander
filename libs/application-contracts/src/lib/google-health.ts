import { z } from 'zod';
import {
  googleCustomerIdSchema,
  googleFailureSchema,
} from './google-connection';

// A passed observation becomes stale after five minutes. It never proves continuous access.
export const GOOGLE_HEALTH_FRESH_SECONDS = 300;

export const googleHealthCapabilitySchema = z.enum([
  'customer-identity',
  'domain-observations',
]);
export type GoogleHealthCapability = z.infer<
  typeof googleHealthCapabilitySchema
>;
export const googleHealthFailureSchema = z.enum([
  ...googleFailureSchema.options,
  'license-restricted',
  'key-unavailable',
]);
export type GoogleHealthFailure = z.infer<typeof googleHealthFailureSchema>;
export const googleCapabilityResultSchema = z
  .strictObject({
    capability: googleHealthCapabilitySchema,
    scopeVerified: z.boolean(),
    failure: googleHealthFailureSchema.nullable(),
  })
  .refine(
    (result) => result.failure !== null || result.scopeVerified,
    'A successful check must verify its scope.',
  );
export type GoogleCapabilityResult = z.infer<
  typeof googleCapabilityResultSchema
>;
export const googleHealthCheckSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  generation: z.number().int().positive(),
  capabilities: z
    .array(googleHealthCapabilitySchema)
    .min(1)
    .max(2)
    .refine((items) => new Set(items).size === items.length),
});
export const googleHealthSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  generation: z.number().int().positive(),
  observedAt: z.iso.datetime({ offset: true }),
  backgroundFailure: googleFailureSchema.nullable(),
  check: z
    .strictObject({
      id: z.uuid(),
      capabilities: z.array(googleHealthCapabilitySchema).min(1).max(2),
      expiresAt: z.iso.datetime({ offset: true }),
      finishedAt: z.iso.datetime({ offset: true }).nullable(),
      retryAt: z.iso.datetime({ offset: true }),
    })
    .nullable(),
  capabilities: z
    .array(
      z.strictObject({
        capability: googleHealthCapabilitySchema,
        scopeVerified: z.boolean(),
        failure: googleHealthFailureSchema.nullable(),
        checkedAt: z.iso.datetime({ offset: true }),
        lastSucceededAt: z.iso.datetime({ offset: true }).nullable(),
        correlationId: z.uuid().nullable(),
      }),
    )
    .length(2)
    .refine(
      (items) => new Set(items.map((item) => item.capability)).size === 2,
    ),
});
export const googleHealthResponseSchema = z.strictObject({
  health: googleHealthSchema.nullable(),
});
export type GoogleHealth = z.infer<typeof googleHealthSchema>;

export const GOOGLE_HEALTH_RECOVERY: Readonly<
  Record<GoogleHealthFailure, { label: string; recovery: string }>
> = Object.freeze({
  'credential-rejected': {
    label: 'Credential rejected',
    recovery:
      'Check the service-account key, delegated administrator, and server clock. Replace rejected credentials through the credential workflow.',
  },
  'delegation-not-authorized': {
    label: 'Delegation not authorized',
    recovery:
      'Verify the service-account numeric client ID and this capability scope in domain-wide delegation. Recheck after approval propagates.',
  },
  'api-not-enabled': {
    label: 'Admin SDK API unavailable',
    recovery:
      'Check Admin SDK API activation and Cloud project restrictions. Correct the configuration, then recheck.',
  },
  'policy-restricted': {
    label: 'Google policy restriction',
    recovery:
      'Ask a Google administrator to review the applicable API access policy, then recheck.',
  },
  'network-failure': {
    label: 'Google connection unavailable',
    recovery:
      'Check outbound connectivity and DNS. Retry after the connection returns.',
  },
  'scope-mismatch': {
    label: 'Required scope not verified',
    recovery:
      'Verify this capability scope in domain-wide delegation, then recheck this capability.',
  },
  'permission-denied': {
    label: 'Google access denied',
    recovery:
      'Review the delegated administrator privileges, API access policy, and required scope. Google did not identify a specific cause.',
  },
  quota: {
    label: 'Google request limit',
    recovery:
      'Wait for the request limit to recover, then retry. Check the Google project quota if failures continue.',
  },
  'provider-unavailable': {
    label: 'Google service unavailable',
    recovery:
      'Retain the last confirmed result and retry after Google service recovery.',
  },
  'invalid-response': {
    label: 'Google response not verified',
    recovery:
      'Retry the capability check. Contact the installation operator if the response remains invalid.',
  },
  'wrong-customer': {
    label: 'Different Google customer',
    recovery:
      'Use credentials for the confirmed customer. The installation will not change its customer automatically.',
  },
  'request-failed': {
    label: 'Google request failed',
    recovery:
      'Check the Google configuration and connection. Retry the capability check. Use its correlation ID for investigation.',
  },
  'license-restricted': {
    label: 'Google license restriction',
    recovery:
      'Ask a Google administrator to verify the required subscription or license. Recheck after Google confirms availability.',
  },
  'key-unavailable': {
    label: 'Credential encryption key unavailable',
    recovery:
      'Ask the installation operator to restore the configured encryption key, then recheck.',
  },
});
