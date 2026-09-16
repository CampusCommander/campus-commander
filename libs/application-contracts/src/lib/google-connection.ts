import { z } from 'zod';

export const googleCustomerIdSchema = z.string().regex(/^C[A-Za-z0-9]{4,31}$/);
export const googleDomainNameSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );
export const googleObservationSchema = z
  .strictObject({
    customerId: googleCustomerIdSchema,
    primaryDomain: googleDomainNameSchema,
    domains: z
      .array(
        z.strictObject({
          name: googleDomainNameSchema,
          primary: z.boolean(),
          verified: z.boolean(),
          aliases: z
            .array(
              z.strictObject({
                name: googleDomainNameSchema,
                verified: z.boolean(),
              }),
            )
            .max(1000),
        }),
      )
      .min(1)
      .max(1000),
  })
  .refine(
    (value) => {
      const primary = value.domains.filter((domain) => domain.primary);
      const names = value.domains.flatMap((domain) => [
        domain.name,
        ...domain.aliases.map((alias) => alias.name),
      ]);
      return (
        primary.length === 1 &&
        primary[0].name === value.primaryDomain &&
        new Set(names).size === names.length
      );
    },
    { message: 'The domain observation is inconsistent.' },
  );
export type GoogleObservation = z.infer<typeof googleObservationSchema>;

export const googleFailureSchema = z.enum([
  'credential-rejected',
  'delegation-not-authorized',
  'api-not-enabled',
  'policy-restricted',
  'network-failure',
  'scope-mismatch',
  'permission-denied',
  'quota',
  'provider-unavailable',
  'invalid-response',
  'wrong-customer',
  'request-failed',
]);
export type GoogleFailure = z.infer<typeof googleFailureSchema>;
export const googleCandidateSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['verifying', 'ready', 'failed', 'expired', 'consumed']),
  expiresAt: z.string(),
  clientId: z.string().regex(/^[0-9]{1,32}$/),
  subject: z.email().max(254),
  observation: googleObservationSchema.nullable(),
  observedAt: z.string().nullable(),
  failure: googleFailureSchema.nullable(),
});
export type GoogleCandidate = z.infer<typeof googleCandidateSchema>;
export const googleCredentialImportSchema = z.strictObject({
  id: z.uuid(),
  clientId: z.string().regex(/^[0-9]{1,32}$/),
  subject: z.email().max(254),
  serviceAccount: z.record(z.string(), z.unknown()),
});
export const googleCustomerConfirmationSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  confirmed: z.literal(true),
});
export const googleConnectionSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  generation: z.number().int().positive(),
  observation: googleObservationSchema,
  observedAt: z.string(),
  confirmedAt: z.string(),
  clientId: z.string().regex(/^[0-9]{1,32}$/),
  subject: z.email().max(254),
});
export type GoogleConnection = z.infer<typeof googleConnectionSchema>;

export const googleConnectionStateSchema = z.strictObject({
  connection: googleConnectionSchema.nullable(),
});
