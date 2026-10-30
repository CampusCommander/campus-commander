import * as z from 'zod';
import { deviceImportModeSchema } from './device-edit-template';
import {
  JOB_IMPORT_SOURCE_TYPES,
  jobDisplayIdSchema,
  jobImportSourceTypeSchema,
} from './jobs';
import type { JobImportSourceType } from './jobs';

/**
 * The Google Drive contracts of the device export and import workflow
 * (`docs/superpowers/specs/2026-10-30-device-drive-slice-design.md`, sections 1 and 3).
 *
 * A Sheet export writes a Google Sheet to the person's My Drive. A Drive import reads a Sheet tab
 * or a CSV file in Drive as the person. This module holds the source types, the Drive import
 * request and receipt, the access answer, the session answer, the tab list, and the settings. The
 * routes stay in `api/drive/`, and the Google calls stay in `gc/drive.ts`.
 */

const timestamp = z.iso.datetime({ offset: true });

/** The three import source types of the Drive slice (design section 1). The uploaded file stays
 * `csv`. The job answer names the same list (`JOB_IMPORT_SOURCE_TYPES`). */
export const DEVICE_IMPORT_SOURCE_TYPES = JOB_IMPORT_SOURCE_TYPES;
export const deviceImportSourceTypeSchema = jobImportSourceTypeSchema;
export type DeviceImportSourceType = JobImportSourceType;

/** The two source types of a Drive import (design section 1). */
export const DEVICE_DRIVE_SOURCE_TYPES = ['drive-sheet', 'drive-csv'] as const;
export const deviceDriveSourceTypeSchema = z.enum(DEVICE_DRIVE_SOURCE_TYPES);
export type DeviceDriveSourceType = z.infer<typeof deviceDriveSourceTypeSchema>;

/** A Drive file ID: 1 to 128 letters, digits, hyphens, or underscores (design section 1). */
export const googleDriveFileIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/);
export type GoogleDriveFileId = z.infer<typeof googleDriveFileIdSchema>;

/** The integer sheet ID of the Sheets API (design section 1). The first tab of a Sheet holds 0. */
export const googleDriveTabIdSchema = z.number().int().min(0);
export type GoogleDriveTabId = z.infer<typeof googleDriveTabIdSchema>;

/** One tab of a Sheet, as the tab list shows it (states 07 and 10). */
export const googleDriveTabSchema = z.strictObject({
  tabId: googleDriveTabIdSchema,
  title: z.string().min(1).max(255),
  index: z.number().int().min(0),
});
export type GoogleDriveTab = z.infer<typeof googleDriveTabSchema>;

/** The answer of `GET /api/google/drive/files/{fileId}/tabs` (design section 1). A tab list holds
 * 1 to 1,000 tabs. */
export const googleDriveTabListSchema = z.strictObject({
  fileId: googleDriveFileIdSchema,
  tabs: z.array(googleDriveTabSchema).min(1).max(1000),
});
export type GoogleDriveTabList = z.infer<typeof googleDriveTabListSchema>;

/** The request of `POST /api/devices/imports/drive` (design section 1). A Sheet adds its tab ID,
 * and a CSV file in Drive names none. */
export const googleDriveImportRequestSchema = z.strictObject({
  mode: deviceImportModeSchema,
  fileId: googleDriveFileIdSchema,
  tabId: googleDriveTabIdSchema.nullable().default(null),
});
export type GoogleDriveImportRequest = z.infer<
  typeof googleDriveImportRequestSchema
>;

/** The receipt of `POST /api/devices/imports/drive` (design section 1). The job takes its name and
 * its size from Drive, not from the browser. */
export const googleDriveImportReceiptSchema = z.strictObject({
  jobId: z.uuid(),
  displayId: jobDisplayIdSchema,
  status: z.literal('accepted'),
  mode: deviceImportModeSchema,
  name: z.string().min(1).max(255),
  sourceType: deviceDriveSourceTypeSchema,
  /** The chosen tab of a Sheet. A CSV file carries none. */
  tabTitle: z.string().min(1).max(255).nullable(),
});
export type GoogleDriveImportReceipt = z.infer<
  typeof googleDriveImportReceiptSchema
>;

/** The three causes of an unavailable Drive (design section 1, `notes:228-234`). */
export const GOOGLE_DRIVE_CAUSES = ['setup', 'delegation', 'account'] as const;
export const googleDriveCauseSchema = z.enum(GOOGLE_DRIVE_CAUSES);
export type GoogleDriveCause = z.infer<typeof googleDriveCauseSchema>;

/** The access of a Sheet export. An export opens no Picker, so `setup` never applies to it (design
 * section 1). */
export const googleDriveSheetExportAccessSchema = z.union([
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({
    available: z.literal(false),
    cause: z.enum(['delegation', 'account']),
  }),
]);
export type GoogleDriveSheetExportAccess = z.infer<
  typeof googleDriveSheetExportAccessSchema
>;

/** The access of a Drive import: the saved settings, the last `drive-files` result, and the
 * session (design section 1). */
export const googleDriveImportAccessSchema = z.union([
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({
    available: z.literal(false),
    cause: googleDriveCauseSchema,
  }),
]);
export type GoogleDriveImportAccess = z.infer<
  typeof googleDriveImportAccessSchema
>;

/** The answer of `GET /api/google/drive` (design section 1). The read calls no Google API. */
export const googleDriveAccessSchema = z.strictObject({
  sheetExport: googleDriveSheetExportAccessSchema,
  driveImport: googleDriveImportAccessSchema,
});
export type GoogleDriveAccess = z.infer<typeof googleDriveAccessSchema>;

/** A Picker API key: exactly 39 letters, digits, hyphens, or underscores (design section 3). The
 * key is not a secret, because every browser that opens the Picker receives it. */
export const googleDrivePickerApiKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{39}$/);
export type GoogleDrivePickerApiKey = z.infer<
  typeof googleDrivePickerApiKeySchema
>;

/** A project number: 1 to 20 digits and no leading zero (design section 3). The Picker uses it as
 * its App ID. */
export const googleDriveProjectNumberSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/);
export type GoogleDriveProjectNumber = z.infer<
  typeof googleDriveProjectNumberSchema
>;

/** The request of `POST /api/google/drive/session`. It carries no field (design section 1). */
export const googleDriveSessionRequestSchema = z.strictObject({});

/** The answer of `POST /api/google/drive/session` (design section 1). The token expires within one
 * hour, and the route sends `cache-control: no-store`. */
export const googleDriveSessionSchema = z.strictObject({
  accessToken: z.string().min(1).max(4096),
  expiresAt: timestamp,
  apiKey: googleDrivePickerApiKeySchema,
  appId: googleDriveProjectNumberSchema,
});
export type GoogleDriveSession = z.infer<typeof googleDriveSessionSchema>;

/** The saved Drive settings (design section 3). The same block is the body of the save route. */
export const googleDriveSettingsSchema = z.strictObject({
  pickerApiKey: googleDrivePickerApiKeySchema,
  projectNumber: googleDriveProjectNumberSchema,
});
export type GoogleDriveSettings = z.infer<typeof googleDriveSettingsSchema>;

/** The answer of the Drive settings routes (design section 1). `drive` stays null before the first
 * save. */
export const googleDriveSettingsAnswerSchema = z.strictObject({
  drive: googleDriveSettingsSchema.nullable(),
});
export type GoogleDriveSettingsAnswer = z.infer<
  typeof googleDriveSettingsAnswerSchema
>;
