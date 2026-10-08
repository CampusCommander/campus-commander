import { z } from 'zod';
import { googleCustomerIdSchema } from './google-connection';

export const customerSettingsSchema = z.strictObject({
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine(
      (value) => !/\p{Cc}/u.test(value),
      'Use a display name without control characters.',
    ),
});
export const customerSettingsWriteSchema = z.strictObject({
  requestId: z.uuid(),
  customerId: googleCustomerIdSchema,
  expectedRevision: z.number().int().min(0).max(2147483646),
  settings: customerSettingsSchema,
});
export const customerSettingsReceiptSchema = z.strictObject({
  requestId: z.uuid(),
  customerId: googleCustomerIdSchema,
  revision: z.number().int().positive(),
  settings: customerSettingsSchema,
  savedAt: z.iso.datetime({ offset: true }),
});
export const customerStateSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  primaryDomain: z.string().min(1).max(253),
  settings: customerSettingsSchema,
  revision: z.number().int().nonnegative(),
  lastRequestId: z.uuid().nullable(),
  onboarding: z.strictObject({
    customerConfirmedAt: z.iso.datetime({ offset: true }),
    settingsConfirmedAt: z.iso.datetime({ offset: true }).nullable(),
    lastGoogleObservationAt: z.iso.datetime({ offset: true }),
  }),
});
export const customerStateResponseSchema = z.strictObject({
  customer: customerStateSchema.nullable(),
});
export type CustomerState = z.infer<typeof customerStateSchema>;
export type CustomerSettings = z.infer<typeof customerSettingsSchema>;
export type CustomerSettingsReceipt = z.infer<
  typeof customerSettingsReceiptSchema
>;
