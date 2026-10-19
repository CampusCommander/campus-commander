import * as z from 'zod';
import { deviceSelectionKeySchema } from './devices';
import { googleFailureSchema } from './google-connection';
import { jobDisplayIdSchema, previewDisplayIdSchema } from './jobs';

const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().min(0);
const deviceId = z.string().min(1).max(128);
const serialNumber = z.string().max(256);
const selectionKeyShape = {
  gridId: deviceSelectionKeySchema.shape.gridId,
  tabId: deviceSelectionKeySchema.shape.tabId,
};

/** The only writable field of this slice. */
export const deviceUpdateFieldSchema = z.literal('annotatedLocation');
export type DeviceUpdateField = z.infer<typeof deviceUpdateFieldSchema>;

export const deviceUpdateModeSchema = z.enum(['replace', 'clear']);
export type DeviceUpdateMode = z.infer<typeof deviceUpdateModeSchema>;

/** The value bounds of section 2.3. The count is code points, not UTF-16 units. */
export const DEVICE_UPDATE_VALUE_MAX = 200;
export const deviceUpdateValueSchema = z
  .string()
  .refine(
    (value) => {
      const length = [...value].length;
      return length >= 1 && length <= DEVICE_UPDATE_VALUE_MAX;
    },
    { message: 'A value holds 1 to 200 characters.' },
  )
  .refine((value) => value.trim().length > 0, {
    message: 'A value needs a visible character.',
  });
export type DeviceUpdateValue = z.infer<typeof deviceUpdateValueSchema>;

const manifestDigest = z.string().regex(/^[a-f0-9]{64}$/);

/** The preview request of section 2.3. Clear carries no value. */
export const deviceUpdatePreviewRequestSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...selectionKeyShape,
    mode: z.literal('replace'),
    value: deviceUpdateValueSchema,
  }),
  z.strictObject({
    ...selectionKeyShape,
    mode: z.literal('clear'),
  }),
]);
export type DeviceUpdatePreviewRequest = z.infer<
  typeof deviceUpdatePreviewRequestSchema
>;

/** The preview summary of section 2.3. Its counts cover the frozen targets. */
export const deviceUpdatePreviewSchema = z
  .strictObject({
    previewId: z.uuid(),
    displayId: previewDisplayIdSchema,
    mode: deviceUpdateModeSchema,
    value: deviceUpdateValueSchema.nullable(),
    selected: count,
    eligible: count,
    unchanged: count,
    excluded: count,
    oldestObservedAt: timestamp.nullable(),
    stale: z.boolean(),
    preparedAt: timestamp,
    expiresAt: timestamp,
    manifestDigest,
  })
  .refine(
    (preview) =>
      preview.selected ===
      preview.eligible + preview.unchanged + preview.excluded,
    {
      message: 'Selected equals the sum of eligible, unchanged, and excluded.',
    },
  )
  .refine(
    (preview) => (preview.mode === 'clear') === (preview.value === null),
    {
      message: 'Only a clear preview holds a null value.',
    },
  );
export type DeviceUpdatePreview = z.infer<typeof deviceUpdatePreviewSchema>;

/** One frozen preview target (section 2.3). A removed device stays as an exclusion. */
export const deviceUpdateTargetSchema = z.strictObject({
  deviceId,
  serialNumber,
  field: deviceUpdateFieldSchema,
  observedValue: z.string().max(4096).nullable(),
  approvedValue: deviceUpdateValueSchema.nullable(),
  disposition: z.enum(['eligible', 'unchanged', 'excluded']),
  /** Present for an excluded target only: for example `removed`. */
  exclusionReason: z.string().min(1).max(64).nullable(),
});
export type DeviceUpdateTarget = z.infer<typeof deviceUpdateTargetSchema>;

/** One targets page. The route caps a page at 1,000 rows. */
export const deviceUpdateTargetsSchema = z
  .array(deviceUpdateTargetSchema)
  .max(1000);

/** The confirmation body of section 2.4. */
export const deviceUpdateConfirmRequestSchema = z.strictObject({
  manifestDigest,
  acknowledged: z.literal(true),
});
export type DeviceUpdateConfirmRequest = z.infer<
  typeof deviceUpdateConfirmRequestSchema
>;

/** The confirmation receipt of section 2.4. The receipt page renders it. */
export const deviceUpdateJobReceiptSchema = z.strictObject({
  jobId: z.uuid(),
  displayId: jobDisplayIdSchema,
  status: z.literal('accepted'),
  deviceCount: count,
  updateCount: count,
});
export type DeviceUpdateJobReceipt = z.infer<
  typeof deviceUpdateJobReceiptSchema
>;

/** The write-access states of section 4.2. */
export const deviceWriteAccessStateSchema = z.enum([
  'granted',
  'denied',
  'unavailable',
  'unchecked',
]);
export type DeviceWriteAccessState = z.infer<
  typeof deviceWriteAccessStateSchema
>;

/** The write-access projection of section 2.7. */
export const deviceWriteAccessSchema = z.strictObject({
  state: deviceWriteAccessStateSchema,
  /** The Google scope that the check mints. It reads null without a check. */
  scope: z.string().min(1).max(512).nullable(),
  failure: googleFailureSchema.nullable(),
  checkedAt: timestamp.nullable(),
});
export type DeviceWriteAccess = z.infer<typeof deviceWriteAccessSchema>;

export {
  DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
  deviceWriteAccessMessage,
} from './device-write-access-message';

/**
 * The documented answer of `POST /api/devices/updates/access/check` inside the
 * 30-second interval: status 429 with the route body `{reason:'busy'}`. The GET
 * route never answers this status. `applicationErrorSchema` names `busy` in the
 * wider application vocabulary.
 */
export const DEVICE_WRITE_ACCESS_BUSY_ANSWER = Object.freeze({
  status: 429,
  reason: 'busy',
} as const);
