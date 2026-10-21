import * as z from 'zod';
import { deviceSelectionKeySchema } from './devices';
import {
  deviceUpdateJobReceiptSchema,
  type DeviceUpdateJobReceipt,
} from './device-updates';
import { previewDisplayIdSchema } from './jobs';

const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().min(0);
const deviceId = z.string().min(1).max(128);
const serialNumber = z.string().max(256);
const orgUnitPath = z.string().min(1).max(4096).startsWith('/');
const manifestDigest = z.string().regex(/^[a-f0-9]{64}$/);
const selectionKeyShape = {
  gridId: deviceSelectionKeySchema.shape.gridId,
  tabId: deviceSelectionKeySchema.shape.tabId,
};

/** The three device actions of section 1. An annotated-location update is not one of them. */
export const deviceActionSchema = z.enum(['reboot', 'disable', 'reenable']);
export type DeviceAction = z.infer<typeof deviceActionSchema>;

/** The one command of this build (section 6). */
export const deviceCommandTypeSchema = z.literal('REBOOT');
export type DeviceCommandType = z.infer<typeof deviceCommandTypeSchema>;

/** The two status changes of this build (section 6). */
export const deviceStatusActionSchema = z.enum(['disable', 'reenable']);
export type DeviceStatusAction = z.infer<typeof deviceStatusActionSchema>;

/** The command preview body of section 7. It carries the selection key and the command type. */
export const deviceCommandPreviewRequestSchema = z.strictObject({
  ...selectionKeyShape,
  commandType: deviceCommandTypeSchema,
});
export type DeviceCommandPreviewRequest = z.infer<
  typeof deviceCommandPreviewRequestSchema
>;

/** The status preview body of section 7. It carries the selection key and the status action. */
export const deviceStatusPreviewRequestSchema = z.strictObject({
  ...selectionKeyShape,
  statusAction: deviceStatusActionSchema,
});
export type DeviceStatusPreviewRequest = z.infer<
  typeof deviceStatusPreviewRequestSchema
>;

export const deviceActionPreviewRequestSchema = z.union([
  deviceCommandPreviewRequestSchema,
  deviceStatusPreviewRequestSchema,
]);
export type DeviceActionPreviewRequest = z.infer<
  typeof deviceActionPreviewRequestSchema
>;

/**
 * One frozen preview of section 2. These actions hold no unchanged disposition, so selected counts
 * eligible and excluded only. The action decides which request field is set.
 */
export const deviceActionPreviewSchema = z
  .strictObject({
    previewId: z.uuid(),
    displayId: previewDisplayIdSchema,
    action: deviceActionSchema,
    commandType: deviceCommandTypeSchema.nullable(),
    statusAction: deviceStatusActionSchema.nullable(),
    selected: count,
    eligible: count,
    excluded: count,
    /** The oldest cached status stamp of an eligible target. */
    oldestObservedAt: timestamp.nullable(),
    stale: z.boolean(),
    preparedAt: timestamp,
    expiresAt: timestamp,
    manifestDigest,
  })
  .refine(
    (preview) => preview.selected === preview.eligible + preview.excluded,
    {
      message: 'Selected equals the sum of eligible and excluded.',
    },
  )
  .refine(
    (preview) =>
      preview.action === 'reboot'
        ? preview.commandType === 'REBOOT' && preview.statusAction === null
        : preview.commandType === null &&
          preview.statusAction === preview.action,
    {
      message: 'The action decides the command type or the status action.',
    },
  );
export type DeviceActionPreview = z.infer<typeof deviceActionPreviewSchema>;

/** One frozen preview target of section 7. A target carries the cached status it matched. */
export const deviceActionTargetSchema = z.strictObject({
  deviceId,
  serialNumber,
  orgUnitPath,
  observedStatus: z.string().max(64).nullable(),
  observedAt: timestamp.nullable(),
  disposition: z.enum(['eligible', 'excluded']),
  /** Present for an excluded target only: for example `device-disabled`. */
  exclusionReason: z.string().min(1).max(64).nullable(),
});
export type DeviceActionTarget = z.infer<typeof deviceActionTargetSchema>;

/** One targets page. The route caps a page at 1,000 rows. */
export const deviceActionTargetsPageSchema = z.strictObject({
  targets: z.array(deviceActionTargetSchema).max(1000),
  nextCursor: z.string().min(1).max(1024).nullable(),
});
export type DeviceActionTargetsPage = z.infer<
  typeof deviceActionTargetsPageSchema
>;

/** The confirmation body of section 7: the digest of the frozen preview and the acknowledgment. */
export const deviceActionConfirmRequestSchema = z.strictObject({
  manifestDigest,
  acknowledged: z.literal(true),
});
export type DeviceActionConfirmRequest = z.infer<
  typeof deviceActionConfirmRequestSchema
>;

/** The receipt reuses the step 4 schema. `updateCount` counts operations. */
export const deviceActionJobReceiptSchema = deviceUpdateJobReceiptSchema;
export type DeviceActionJobReceipt = DeviceUpdateJobReceipt;
