import { Injectable, inject } from '@angular/core';
import {
  DEVICE_UPDATE_FIELD_LABELS,
  DEVICE_UPDATE_TEXT_FIELDS,
  ENTITY_FRESHNESS_HOURS,
  deviceUpdateJobReceiptSchema,
  deviceUpdatePreviewSchema,
  deviceUpdateTargetsPageSchema,
  type DeviceUpdateChange,
  type DeviceUpdateConfirmRequest,
  type DeviceUpdateJobReceipt,
  type DeviceUpdateMode,
  type DeviceUpdatePreview,
  type DeviceUpdatePreviewRequest,
  type DeviceUpdateTarget,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from '../google-connection/connection.store';
import { formatTimestamp } from '../jobs/job-fields';
import { DeviceUpdateDraftStore } from './device-update-draft.store';
import { DEVICE_GRID_ID } from './device-selection';
import {
  DEVICE_UPDATE_PERMISSION_MESSAGE,
  deviceCountText,
} from './device-update-messages';
import { DevicesStore } from './devices.store';

/** The answers of design 2.4 that change the page state. */
export type FlowAnswerKind =
  | 'preview-expired'
  | 'preview-changed'
  | 'permission-changed'
  | 'connection-changed'
  | 'connection-required'
  | 'nothing-to-update'
  | 'forbidden'
  | 'preview-not-found'
  | 'selection-expired'
  | 'selection-too-large'
  | 'nothing-selected';

/** A page-level state. `offline` and the unreadable answers add the read failures. */
export type FlowProblemKind =
  | FlowAnswerKind
  | 'preview-unavailable'
  | 'confirm-uncertain'
  | 'confirm-receipt-unavailable'
  | 'job-unavailable'
  | 'job-forbidden'
  | 'job-not-found'
  | 'offline';

export type FlowActionId =
  | 'return-to-draft'
  | 'prepare-new-preview'
  | 'back-to-devices'
  | 'back-to-jobs'
  | 'back-to-choose'
  | 'open-google-connection'
  | 'retry';

export interface FlowAction {
  id: FlowActionId;
  label: string;
  primary: boolean;
}

/** The text and recovery of one stalled write-flow state, in the frame style. */
export interface FlowProblem {
  kind: FlowProblemKind;
  title: string;
  subtitle: string;
  heading: string;
  paragraphs: readonly string[];
  actions: readonly FlowAction[];
}

export interface FlowProblemContext {
  /** The preview display ID when the page has already read the summary. */
  displayId?: string | null;
  /** The expiry of a `410 preview-expired` answer. */
  expiresAt?: string | null;
  /** The person may open the Google connection page. */
  canOpenConnection?: boolean;
}

const PRESERVED = 'Draft preserved · No job created';
const NO_JOB = 'No job created';

const returnToDraft = (primary = false): FlowAction => ({
  id: 'return-to-draft',
  label: 'Return to draft',
  primary,
});
const prepareNewPreview: FlowAction = {
  id: 'prepare-new-preview',
  label: 'Prepare new preview',
  primary: true,
};
const backToDevices = (primary = false): FlowAction => ({
  id: 'back-to-devices',
  label: 'Back to devices',
  primary,
});
const backToJobs: FlowAction = {
  id: 'back-to-jobs',
  label: 'View jobs',
  primary: true,
};
const openConnection: FlowAction = {
  id: 'open-google-connection',
  label: 'Open Google connection',
  primary: true,
};
const retry: FlowAction = { id: 'retry', label: 'Retry', primary: true };

/** The answer of a preview, confirm, or targets request, or null for another failure. */
export function flowAnswer(
  status: number,
  body: unknown,
): FlowAnswerKind | null {
  const reason = (body as { reason?: unknown } | null)?.reason;
  if (status === 410 && reason === 'preview-expired') return 'preview-expired';
  if (status === 404 && reason === 'preview-not-found')
    return 'preview-not-found';
  if (status === 403) return 'forbidden';
  if (status === 409 && reason === 'preview-changed') return 'preview-changed';
  if (status === 409 && reason === 'permission-changed')
    return 'permission-changed';
  if (status === 409 && reason === 'connection-changed')
    return 'connection-changed';
  if (status === 409 && reason === 'connection-required')
    return 'connection-required';
  if (status === 409 && reason === 'selection-expired')
    return 'selection-expired';
  if (status === 422 && reason === 'selection-too-large')
    return 'selection-too-large';
  if (status === 422 && reason === 'nothing-to-update')
    return 'nothing-to-update';
  if (status === 422 && reason === 'nothing-selected')
    return 'nothing-selected';
  return null;
}

/** The expiry of a `410 preview-expired` answer. */
export function flowExpiry(body: unknown): string | null {
  const expiresAt = (body as { expiresAt?: unknown } | null)?.expiresAt;
  return typeof expiresAt === 'string' ? expiresAt : null;
}

/**
 * An answer to a replayed confirmation can hide a job that the first request created.
 * The API checks current authority and the frozen action version before it returns an
 * existing receipt (`deployment/postgres/migrations/017-jobs.sql`), and both action
 * controllers check the Google connection before the confirm call. A revoked grant,
 * an obsolete preview, or a missing connection therefore answers before the receipt.
 * `connection-changed` is absent on purpose: the function checks it after the receipt.
 */
export function confirmationMayExist(answer: FlowProblemKind): boolean {
  return (
    answer === 'forbidden' ||
    answer === 'permission-changed' ||
    answer === 'preview-changed' ||
    answer === 'connection-required'
  );
}

/** The frame-style state of one answer. The card drafts every string for owner review. */
export function flowProblem(
  kind: FlowProblemKind,
  context: FlowProblemContext = {},
): FlowProblem {
  const connectionAction = context.canOpenConnection ? openConnection : null;
  switch (kind) {
    case 'preview-expired': {
      const expired = context.displayId
        ? `Preview ${context.displayId} expired${context.expiresAt ? ` at ${formatTimestamp(context.expiresAt)}` : ''}. Its approval controls are no longer valid.`
        : `The preview expired${context.expiresAt ? ` at ${formatTimestamp(context.expiresAt)}` : ''}. Its approval controls are no longer valid.`;
      return {
        kind,
        title: 'Preview expired',
        subtitle: PRESERVED,
        heading: 'Prepare a new preview before confirming',
        paragraphs: [
          expired,
          'Your draft remains available. A new preview rechecks targets, permissions, current values, and expiry.',
        ],
        actions: [returnToDraft(), prepareNewPreview],
      };
    }
    case 'preview-changed':
      return {
        kind,
        title: 'Preview changed',
        subtitle: PRESERVED,
        heading: 'Review the current targets in a new preview',
        paragraphs: [
          'The approved scope changed after this preview was prepared. Its approval controls are no longer valid.',
          'Your draft remains available. A new preview rechecks targets, permissions, current values, and expiry.',
        ],
        actions: [returnToDraft(), prepareNewPreview],
      };
    case 'permission-changed':
      return {
        kind,
        title: 'Your access changed',
        subtitle: PRESERVED,
        heading: 'Review your access before you create the job',
        paragraphs: [
          'Your permissions changed after this preview was prepared. The preview can no longer become a job.',
          DEVICE_UPDATE_PERMISSION_MESSAGE,
        ],
        actions: [returnToDraft(), backToDevices(true)],
      };
    case 'connection-changed':
      return {
        kind,
        title: 'The Google connection changed',
        subtitle: PRESERVED,
        heading: 'Reconnect Google Workspace before you create the job',
        paragraphs: [
          'The Google connection changed after this preview was prepared. Its approval controls are no longer valid.',
          'Check the Google connection, then prepare a new preview.',
        ],
        actions: [returnToDraft(), connectionAction ?? backToDevices(true)],
      };
    case 'connection-required':
      return {
        kind,
        title: 'Google Workspace is not connected',
        subtitle: PRESERVED,
        heading: 'Connect Google Workspace before you create the job',
        paragraphs: [
          'Campus Commander has no Google Workspace connection for this customer. Connect it, then prepare a new preview.',
        ],
        actions: [returnToDraft(), connectionAction ?? backToDevices(true)],
      };
    case 'nothing-to-update':
      return {
        kind,
        title: 'Nothing to update',
        subtitle: PRESERVED,
        heading: 'No device needs this change',
        paragraphs: [
          'Every frozen target already holds the approved value or is excluded. Adjust the draft and prepare a new preview.',
        ],
        actions: [backToDevices(), returnToDraft(true)],
      };
    case 'forbidden':
      return {
        kind,
        title: 'Update device is unavailable',
        subtitle: PRESERVED,
        heading: 'Your access does not permit this update',
        paragraphs: [DEVICE_UPDATE_PERMISSION_MESSAGE],
        actions: [returnToDraft(), backToDevices(true)],
      };
    case 'preview-not-found':
      return {
        kind,
        title: 'Preview not found',
        subtitle: NO_JOB,
        heading: 'This preview is unavailable',
        paragraphs: [
          'The preview does not exist or belongs to another person. Return to the draft to prepare a new preview.',
        ],
        actions: [backToDevices(), returnToDraft(true)],
      };
    case 'selection-expired':
      return {
        kind,
        title: 'Selection expired',
        subtitle: PRESERVED,
        heading: 'Select the devices again',
        paragraphs: [
          'The browsing selection expired. Your draft remains available.',
          'Return to Devices and select the devices again before you prepare a new preview.',
        ],
        actions: [backToDevices(), returnToDraft(true)],
      };
    case 'selection-too-large':
      return {
        kind,
        title: 'The selection is too large',
        subtitle: PRESERVED,
        heading: 'Narrow the filters and select again',
        paragraphs: [
          'The selection holds more than 100,000 devices. Narrow the filters before you prepare a new preview.',
        ],
        actions: [backToDevices(), returnToDraft(true)],
      };
    case 'nothing-selected':
      return {
        kind,
        title: 'No devices are selected',
        subtitle: PRESERVED,
        heading: 'Select the devices again',
        paragraphs: [
          'The selection holds no devices. Your draft remains available.',
          'Return to Devices and select the devices again before you prepare a new preview.',
        ],
        actions: [backToDevices(), returnToDraft(true)],
      };
    case 'job-not-found':
      return {
        kind,
        title: 'Job not found',
        subtitle: 'No job to show',
        heading: 'This job is unavailable',
        paragraphs: [
          'The job does not exist or is no longer available. Return to Jobs to check the current jobs.',
        ],
        actions: [backToDevices(), backToJobs],
      };
    case 'job-forbidden':
      return {
        kind,
        title: 'The job is unavailable',
        subtitle: 'No job to show',
        heading: 'Your access does not permit this job',
        paragraphs: [
          'You need the jobs:read permission or a device read grant for this customer. Ask your administrator for access.',
        ],
        actions: [backToDevices(), backToJobs],
      };
    case 'job-unavailable':
      return {
        kind,
        title: 'The job is unavailable',
        subtitle: 'No job to show',
        heading: 'Campus Commander could not read the job',
        paragraphs: [
          'The job answer was not readable or the service failed. Retry the job.',
        ],
        actions: [backToDevices(), retry],
      };
    case 'offline':
      return {
        kind,
        title: 'Cannot reach Campus Commander',
        subtitle: 'Your draft stays in this tab',
        heading: 'Check the connection and retry',
        paragraphs: [
          'Campus Commander did not answer. Check the connection and retry.',
        ],
        actions: [backToDevices(), retry],
      };
    case 'confirm-uncertain':
      return {
        kind,
        title: 'The confirmation did not finish',
        subtitle: 'The result is unknown',
        heading: 'Retry the confirmation',
        paragraphs: [
          'Campus Commander did not answer the confirmation, or the answer was not readable. The update job may exist.',
          'Retry sends the same confirmation. If the job exists, Campus Commander returns its receipt.',
        ],
        actions: [backToDevices(), retry],
      };
    case 'confirm-receipt-unavailable':
      return {
        kind,
        title: 'The update job may exist',
        subtitle: 'The receipt is unavailable',
        heading: 'Check Jobs for the update job',
        paragraphs: [
          'Campus Commander could not return the receipt for this confirmation. The update job may exist.',
          'Review the Jobs page before you prepare another preview.',
        ],
        actions: [backToDevices(), backToJobs],
      };
    case 'preview-unavailable':
      return {
        kind,
        title: 'The preview is unavailable',
        subtitle: NO_JOB,
        heading: 'Campus Commander could not read the preview',
        paragraphs: [
          'The preview answer was not readable or the service failed. Retry the preview.',
        ],
        actions: [backToDevices(), retry],
      };
  }
}

/** The title and heading of one problem as a short inline message. */
export function problemSummary(kind: FlowProblemKind): string {
  const problem = flowProblem(kind);
  return `${problem.title}. ${problem.heading}.`;
}

/** "Review 6 device updates". The device noun stays singular before `update`. */
export function previewTitle(preview: DeviceUpdatePreview): string {
  const count = preview.eligible;
  return `Review ${count.toLocaleString('en-US')} device update${count === 1 ? '' : 's'}`;
}

/** "Confirm 6 device updates". */
export function confirmTitle(preview: DeviceUpdatePreview): string {
  const count = preview.eligible;
  return `Confirm ${count.toLocaleString('en-US')} device update${count === 1 ? '' : 's'}`;
}

/** "6 devices · 6 field changes · 0 excluded". */
export function previewCountLine(preview: DeviceUpdatePreview): string {
  const changes = preview.fieldChanges.toLocaleString('en-US');
  return `${deviceCountText(preview.selected)} · ${changes} ${
    preview.fieldChanges === 1 ? 'field change' : 'field changes'
  } · ${preview.excluded.toLocaleString('en-US')} excluded`;
}

/** "Prepared Sep 5, 10:30 AM · Expires Sep 5, 10:45 AM · Preview PV-006". */
export function previewMetaLine(preview: DeviceUpdatePreview): string {
  // The preview ID stays on one line in the narrow sheet. U+2011 is a
  // non-breaking hyphen, so the ID cannot break between PV and the number.
  return `Prepared ${formatTimestamp(preview.preparedAt)} · Expires ${formatTimestamp(
    preview.expiresAt,
  )} · Preview\u00A0${preview.displayId.replace('-', '\u2011')}`;
}

/** The frozen-targets sentence of frame 97:21. */
export const FROZEN_TARGETS_SENTENCE =
  'Targets and final values are frozen. New matching devices will not join this job.';

/** The stale warning of design 2.3. The frame shows a fresh preview. */
export function staleWarning(): string {
  return `Some observed values are more than ${
    ENTITY_FRESHNESS_HOURS.device
  } hours old. Review them before you continue.`;
}

/**
 * The confirmation card heading of frame 97:57 for several fields. The first count is the
 * changed fields, and the second is the eligible devices of the frozen preview.
 */
export function confirmationHeading(preview: DeviceUpdatePreview): string {
  const fields = preview.changes.length;
  return `Update ${fields.toLocaleString('en-US')} ${
    fields === 1 ? 'field' : 'fields'
  } on ${deviceCountText(preview.eligible)}`;
}

/**
 * One confirmation sentence per changed field (Figma 172:2420). A Move sentence needs the
 * destination and its policy note; F3 adds it.
 */
export function changeSentence(
  change: DeviceUpdateChange,
  devices: number,
): string {
  const label = DEVICE_UPDATE_FIELD_LABELS[change.field].toLowerCase();
  const count = deviceCountText(devices);
  switch (change.mode) {
    case 'clear':
      return `Clear the ${label} on ${count}.`;
    case 'move':
      return '';
    case 'replace':
      return `Set the ${label} to ${change.value ?? ''} on ${count}.`;
  }
}

/** The eligible frozen targets of one field. A device that keeps its value is not a change. */
export function fieldChangeCount(
  targets: readonly DeviceUpdateTarget[],
  field: DeviceUpdateChange['field'],
): number {
  return targets.filter(
    (target) => target.field === field && target.disposition === 'eligible',
  ).length;
}

/**
 * The sentences of the Confirm step, one per changed field, in contract order. Each sentence
 * counts that field's eligible frozen rows. `preview.eligible` counts devices that change at
 * least one field, so it overstates a field whose devices partly keep their value (UI-06).
 */
export function changeSentences(
  preview: DeviceUpdatePreview,
  targets: readonly DeviceUpdateTarget[],
): string[] {
  return preview.changes
    .map((change) =>
      changeSentence(change, fieldChangeCount(targets, change.field)),
    )
    .filter((sentence) => sentence !== '');
}

/**
 * The fields that keep their value, as the step 4 sentence names them. Only the three text
 * fields of the draft appear, because the sheet offers no other change. F3 adds
 * Organization unit to this sentence.
 */
export function unchangedSentence(preview: DeviceUpdatePreview): string {
  const changed = new Set(preview.changes.map((change) => change.field));
  const labels = DEVICE_UPDATE_TEXT_FIELDS.filter(
    (field) => !changed.has(field),
  ).map((field) => DEVICE_UPDATE_FIELD_LABELS[field].toLowerCase());
  if (labels.length === 0) return '';
  const joined =
    labels.length === 1
      ? labels[0]
      : labels.length === 2
        ? `${labels[0]} and ${labels[1]}`
        : `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
  const sentence = `${joined} ${
    labels.length === 1 ? 'remains' : 'remain'
  } unchanged.`;
  // The sentence opens with the field name, so its first letter is upper case.
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** "Preview PV-006 · 6 devices · 15 field changes". */
export function confirmationMetaLine(preview: DeviceUpdatePreview): string {
  const changes = preview.fieldChanges.toLocaleString('en-US');
  return `Preview ${preview.displayId} · ${deviceCountText(
    preview.selected,
  )} · ${changes} ${
    preview.fieldChanges === 1 ? 'field change' : 'field changes'
  }`;
}

/** "Expires Sep 5, 10:45 AM". */
export function expiryLine(expiresAt: string): string {
  return `Expires ${formatTimestamp(expiresAt)}`;
}

/** The checkbox label of frame 97:57. N counts every frozen target. */
export function acknowledgementLabel(preview: DeviceUpdatePreview): string {
  const count = preview.selected.toLocaleString('en-US');
  return `I reviewed all ${count} ${preview.selected === 1 ? 'device' : 'devices'} and their final values.`;
}

/** A missing annotated location reads "No value". The frame has no null example. */
export function observedValueText(target: DeviceUpdateTarget): string {
  return target.observedValue ?? 'No value';
}

/** "Cleared" for a clear preview. An excluded target is never updated. */
export function approvedValueText(
  target: DeviceUpdateTarget,
  mode: DeviceUpdateMode,
): string {
  if (target.disposition === 'excluded') return 'Not updated';
  if (mode === 'clear')
    return target.disposition === 'unchanged' ? 'No value' : 'Cleared';
  return target.approvedValue ?? 'No value';
}

/** The exclusion reasons that section 2.3 defines, in the frame style. */
export function exclusionReasonText(reason: string | null): string {
  switch (reason) {
    case 'removed':
      return 'Removed from inventory';
    case 'invalid-device-id':
      return 'Device ID cannot be written';
    default:
      return 'Not eligible for this update';
  }
}

/** A second line under Approved value, or an empty string. */
export function targetNote(target: DeviceUpdateTarget): string {
  // The device group row carries the exclusion reason (design note 16).
  if (target.disposition === 'unchanged') return 'No change';
  return '';
}

/** The device cell of a target row. */
export function targetDeviceText(target: DeviceUpdateTarget): string {
  return target.serialNumber || target.deviceId;
}

/** One row group of the Review table: a device, then one row per changed field. */
export interface TargetGroup {
  deviceId: string;
  /** The serial, or the device ID when Google reports no serial. */
  serialNumber: string;
  /** "Excluded · Removed from inventory", or null for a device that the job covers. */
  excluded: string | null;
  rows: DeviceUpdateTarget[];
}

/**
 * The frozen targets as one group per device, in the order that the route returns them. A
 * device of an excluded target shows its reason once, in the group row (design note 16).
 */
export function targetGroups(
  targets: readonly DeviceUpdateTarget[],
): TargetGroup[] {
  const groups = new Map<string, TargetGroup>();
  for (const target of targets) {
    let group = groups.get(target.deviceId);
    if (!group) {
      group = {
        deviceId: target.deviceId,
        serialNumber: targetDeviceText(target),
        excluded: null,
        rows: [],
      };
      groups.set(target.deviceId, group);
    }
    group.rows.push(target);
    if (target.disposition === 'excluded')
      group.excluded = `Excluded · ${exclusionReasonText(
        target.exclusionReason,
      )}`;
  }
  return [...groups.values()];
}

/** One page of targets, or the answer that stopped the read. */
export type FlowRead<T> =
  | { ok: true; value: T }
  | { ok: false; answer: FlowProblemKind; expiresAt: string | null };

export interface PreviewData {
  preview: DeviceUpdatePreview;
  targets: DeviceUpdateTarget[];
}

export type ReceiptData = DeviceUpdateJobReceipt;

/**
 * The preview and confirmation reads of design 2.3 and 2.4. Each answer maps to one
 * page state. The pages own the navigation and the display context.
 */
@Injectable({ providedIn: 'root' })
export class DeviceUpdateFlow {
  private readonly auth = inject(AuthStore);
  private readonly draft = inject(DeviceUpdateDraftStore);
  private readonly devices = inject(DevicesStore);
  private readonly connection = inject(ConnectionStore);

  /** Add the connection check to one problem of this flow. */
  problem(
    kind: FlowProblemKind,
    context: Omit<FlowProblemContext, 'canOpenConnection'> = {},
  ): FlowProblem {
    return flowProblem(kind, {
      ...context,
      canOpenConnection: this.connection.readable(),
    });
  }

  /** The preview summary of design 2.3. */
  async readPreview(previewId: string): Promise<FlowRead<DeviceUpdatePreview>> {
    try {
      const response = await this.auth.request(
        `/api/devices/updates/previews/${encodeURIComponent(previewId)}`,
      );
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const preview = deviceUpdatePreviewSchema.safeParse(body);
        return preview.success
          ? { ok: true, value: preview.data }
          : { ok: false, answer: 'preview-unavailable', expiresAt: null };
      }
      return this.failure(response.status, body);
    } catch {
      return { ok: false, answer: 'offline', expiresAt: null };
    }
  }

  /** One page of the frozen targets of design 2.3. */
  async readTargetsPage(
    previewId: string,
    cursor: string | null,
  ): Promise<
    FlowRead<{ targets: DeviceUpdateTarget[]; nextCursor: string | null }>
  > {
    const query = new URLSearchParams({ limit: '1000' });
    if (cursor) query.set('cursor', cursor);
    try {
      const response = await this.auth.request(
        `/api/devices/updates/previews/${encodeURIComponent(previewId)}/targets?${query}`,
      );
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const page = deviceUpdateTargetsPageSchema.safeParse(body);
        return page.success
          ? { ok: true, value: page.data }
          : { ok: false, answer: 'preview-unavailable', expiresAt: null };
      }
      return this.failure(response.status, body);
    } catch {
      return { ok: false, answer: 'offline', expiresAt: null };
    }
  }

  /** Every frozen target, in ordinal order, through the route cursor. */
  async readTargets(
    previewId: string,
    cursor: string | null = null,
  ): Promise<FlowRead<DeviceUpdateTarget[]>> {
    const targets: DeviceUpdateTarget[] = [];
    let next: string | null = cursor;
    do {
      const page = await this.readTargetsPage(previewId, next);
      if (!page.ok) return page;
      targets.push(...page.value.targets);
      next = page.value.nextCursor;
    } while (next);
    return { ok: true, value: targets };
  }

  /** A new preview from the durable draft. The expired page uses it (design 2.4). */
  async prepareFromDraft(): Promise<FlowRead<DeviceUpdatePreview>> {
    const key = { gridId: DEVICE_GRID_ID, tabId: this.devices.selectionTab };
    // One change per changed field, in contract order.
    const request: DeviceUpdatePreviewRequest = {
      ...key,
      changes: this.draft.changes(),
    };
    try {
      const response = await this.auth.request(
        '/api/devices/updates/previews',
        request,
      );
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const preview = deviceUpdatePreviewSchema.safeParse(body);
        return preview.success
          ? { ok: true, value: preview.data }
          : { ok: false, answer: 'preview-unavailable', expiresAt: null };
      }
      return this.failure(response.status, body);
    } catch {
      return { ok: false, answer: 'offline', expiresAt: null };
    }
  }

  /**
   * The confirmation of design 2.4. A duplicate answer opens the same receipt.
   * An answer that names no design state leaves acceptance unknown, because the
   * request may have committed before the answer was lost.
   */
  async confirm(
    previewId: string,
    manifestDigest: string,
  ): Promise<FlowRead<DeviceUpdateJobReceipt>> {
    const request: DeviceUpdateConfirmRequest = {
      manifestDigest,
      acknowledged: true,
    };
    try {
      const response = await this.auth.request(
        `/api/devices/updates/previews/${encodeURIComponent(previewId)}/confirm`,
        request,
      );
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const receipt = deviceUpdateJobReceiptSchema.safeParse(body);
        return receipt.success
          ? { ok: true, value: receipt.data }
          : { ok: false, answer: 'confirm-uncertain', expiresAt: null };
      }
      return {
        ok: false,
        answer: flowAnswer(response.status, body) ?? 'confirm-uncertain',
        expiresAt: flowExpiry(body),
      };
    } catch {
      return { ok: false, answer: 'confirm-uncertain', expiresAt: null };
    }
  }

  private failure(
    status: number,
    body: unknown,
    fallback: FlowProblemKind = 'preview-unavailable',
  ): FlowRead<never> {
    return {
      ok: false,
      answer: flowAnswer(status, body) ?? fallback,
      expiresAt: flowExpiry(body),
    };
  }
}
