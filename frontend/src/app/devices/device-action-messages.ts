import type {
  DeviceAction,
  DeviceActionPreview,
  DeviceActionTarget,
  DeviceWriteAccess,
  JobDetail,
} from '@campus/application-contracts';
import { formatTimestamp } from '../jobs/job-fields';
import { receiptCompletionSentence } from '../jobs/job-receipt-messages';
import type {
  FlowAction,
  FlowProblem,
  FlowProblemKind,
} from './device-update-flow';
import {
  deviceCountText,
  updateDeviceNote,
  type UpdateDeviceNote,
} from './device-update-messages';

/** The two Bulk Actions entries of the owner mockup of 2026-10-21 (states 01, 02, and 05). */
export type DeviceActionFamily = 'command' | 'status';

/** The actions that each family prepares. Send command holds Reboot only. */
export const FAMILY_ACTIONS: Readonly<
  Record<DeviceActionFamily, readonly DeviceAction[]>
> = {
  command: ['reboot'],
  status: ['disable', 'reenable'],
};

export interface DeviceActionFamilyCopy {
  /** The Bulk Actions entry and the sheet title noun of the record. */
  menuLabel: string;
  /** The permission note of a person without the family action (record section 6). */
  permissionMessage: string;
  /** The note of a person with no selected device. */
  selectionMessage: string;
  chooseTitle: string;
  /** The radio group label of the Choose step (mockup choice 1). */
  chooseLabel: string;
  stepperLabel: string;
  /** The Review step returns to the choice with this label (Figma 111:442). */
  backLabel: string;
  receiptTitle: string;
  /** The job noun of the busy label and the problem copy. */
  jobNoun: string;
}

export const SEND_COMMAND_PERMISSION_MESSAGE =
  'You need the devices:read, devices:commands, and devices:bulk-actions permissions to send device commands. Ask your administrator for access.';

export const CHANGE_STATUS_PERMISSION_MESSAGE =
  'You need the devices:read, devices:status, and devices:bulk-actions permissions to change device status. Ask your administrator for access.';

export const FAMILY_COPY: Readonly<
  Record<DeviceActionFamily, DeviceActionFamilyCopy>
> = {
  command: {
    menuLabel: 'Send command',
    permissionMessage: SEND_COMMAND_PERMISSION_MESSAGE,
    selectionMessage: 'Select one or more devices to send a command.',
    chooseTitle: 'Choose a device command',
    chooseLabel: 'Command',
    stepperLabel: 'Send command steps',
    backLabel: 'Back to command',
    receiptTitle: 'Command job created',
    jobNoun: 'command job',
  },
  status: {
    menuLabel: 'Change status',
    permissionMessage: CHANGE_STATUS_PERMISSION_MESSAGE,
    selectionMessage: 'Select one or more devices to change the status.',
    chooseTitle: 'Change device status',
    chooseLabel: 'Status change',
    stepperLabel: 'Change status steps',
    backLabel: 'Back to status',
    receiptTitle: 'Status job created',
    jobNoun: 'status job',
  },
};

export interface DeviceActionAvailability {
  family: DeviceActionFamily;
  offline: boolean;
  canRead: boolean;
  /** The permission of the family: devices:commands or devices:status. */
  canAction: boolean;
  canBulk: boolean;
  selectionCount: number;
  access: DeviceWriteAccess | null;
  accessLoading: boolean;
}

/**
 * The reason that a Bulk Actions entry is disabled, in the order of the card:
 * connectivity, permissions, selection, then the Google write-access state. A
 * person without devices:commands or devices:status reads the family note.
 */
export function deviceActionNote(
  availability: DeviceActionAvailability,
): UpdateDeviceNote | null {
  const copy = FAMILY_COPY[availability.family];
  return updateDeviceNote({
    offline: availability.offline,
    canRead: availability.canRead,
    canWrite: availability.canAction,
    canBulk: availability.canBulk,
    selectionCount: availability.selectionCount,
    access: availability.access,
    accessLoading: availability.accessLoading,
    permissionMessage: copy.permissionMessage,
    selectionMessage: copy.selectionMessage,
  });
}

export const ACTION_LABELS: Readonly<Record<DeviceAction, string>> = {
  reboot: 'Reboot',
  disable: 'Disable',
  reenable: 'Re-enable',
};

/** The supporting sentence of one Choose option (patterns DEVICE-01). */
export function actionConsequence(action: DeviceAction): string {
  switch (action) {
    case 'reboot':
      return 'Restarts the devices and interrupts active sessions.';
    case 'disable':
      return 'Blocks user access while keeping devices enrolled.';
    case 'reenable':
      return 'Restores access to disabled devices.';
  }
}

/** "6 of 8 selected devices are active." The eligible status names the target. */
export function targetSummaryText(
  action: DeviceAction,
  eligible: number,
  selected: number,
): string {
  const status = action === 'reenable' ? 'disabled' : 'active';
  const devices = selected === 1 ? 'device' : 'devices';
  return `${eligible.toLocaleString('en-US')} of ${selected.toLocaleString(
    'en-US',
  )} selected ${devices} ${eligible === 1 ? 'is' : 'are'} ${status}.`;
}

/** The Review and receipt noun of one action (mockup choice 6). */
export function actionNoun(action: DeviceAction, count: number): string {
  if (action === 'reboot') return count === 1 ? 'command' : 'commands';
  return count === 1 ? 'status change' : 'status changes';
}

export const EXCLUDED_HELP =
  'Excluded devices stay out of the job. The review lists each excluded device with its reason.';

/** The frozen-targets sentence of the action sheets (mockup choice 4). */
export const ACTION_FROZEN_TARGETS =
  'Targets are frozen. New matching devices will not join this job.';

/** The note of a selection that changed under a frozen preview (step 4 noun). */
export const ACTION_SELECTION_CHANGED_NOTE =
  'The selection changed after this preview. Change action to preview the new selection.';

/** "Review 6 Reboot commands". */
export function reviewTitle(action: DeviceAction, eligible: number): string {
  return `Review ${eligible.toLocaleString('en-US')} ${
    ACTION_LABELS[action]
  } ${actionNoun(action, eligible)}`;
}

/** "8 devices · 6 commands · 2 excluded". */
export function reviewCountLine(
  action: DeviceAction,
  preview: DeviceActionPreview,
): string {
  return `${deviceCountText(preview.selected)} · ${preview.eligible.toLocaleString(
    'en-US',
  )} ${actionNoun(action, preview.eligible)} · ${preview.excluded.toLocaleString(
    'en-US',
  )} excluded`;
}

/** "Prepared Sep 5, 10:30 AM · Expires Sep 5, 10:45 AM · Preview PV-002". */
export function previewMetaLine(preview: DeviceActionPreview): string {
  // The preview ID stays on one line in the narrow sheet, as step 4 does.
  return `Prepared ${formatTimestamp(preview.preparedAt)} · Expires ${formatTimestamp(
    preview.expiresAt,
  )} · Preview\u00A0${preview.displayId.replace('-', '\u2011')}`;
}

/** "Expires Sep 5, 10:45 AM". */
export function expiryLine(expiresAt: string): string {
  return `Expires ${formatTimestamp(expiresAt)}`;
}

/** "Preview PV-002 · 8 devices · 6 commands". */
export function confirmationMetaLine(
  action: DeviceAction,
  preview: DeviceActionPreview,
): string {
  return `Preview ${preview.displayId} · ${deviceCountText(
    preview.selected,
  )} · ${preview.eligible.toLocaleString('en-US')} ${actionNoun(
    action,
    preview.eligible,
  )}`;
}

/** "Reboot 6 devices". The step title and the Disable confirmation button share it. */
export function confirmationTitle(
  action: DeviceAction,
  eligible: number,
): string {
  return `${ACTION_LABELS[action]} ${deviceCountText(eligible)}`;
}

/** The consequence heading of the Confirm step (Figma 111:442 and 114:503). */
export function confirmationHeading(
  action: DeviceAction,
  eligible: number,
): string {
  switch (action) {
    case 'reboot':
      return 'Reboot interrupts active sessions';
    case 'disable':
      return `Block user access on ${deviceCountText(eligible)}`;
    case 'reenable':
      return `Restore access on ${deviceCountText(eligible)}`;
  }
}

/** The consequence paragraphs of the Confirm step. */
export function confirmationParagraphs(
  action: DeviceAction,
  eligible: number,
  excluded: number,
): readonly string[] {
  if (action === 'reboot')
    return [
      'The devices restart when the command executes. Users will lose their active sessions.',
      'Google accepting the request does not confirm execution. Track each device in the job.',
    ];
  const scope = `${eligible.toLocaleString(
    'en-US',
  )} eligible · ${excluded.toLocaleString(
    'en-US',
  )} excluded · Exact targets are recorded with the job.`;
  return action === 'disable'
    ? [
        'Disable blocks user access. These devices remain enrolled. Re-enable restores access.',
        scope,
      ]
    : [
        'Re-enable restores access to disabled devices. Users can sign in again.',
        scope,
      ];
}

/** "Send Reboot to 6 devices" (Figma 111:442) and the status confirmations. */
export function confirmationButton(
  action: DeviceAction,
  eligible: number,
): string {
  return action === 'reboot'
    ? `Send Reboot to ${deviceCountText(eligible)}`
    : confirmationTitle(action, eligible);
}

/**
 * The acknowledgment of frame 111:442. Disable and Re-enable confirm with the filled
 * button, so they carry no checkbox (record design default of 2026-10-21).
 */
export function acknowledgementLabel(action: DeviceAction): string | null {
  return action === 'reboot'
    ? 'I understand that restarting these devices interrupts users.'
    : null;
}

/** "6 devices · 6 Reboot commands. Google changes have not completed." */
export function receiptActionLine(
  action: DeviceAction,
  job: JobDetail,
): string {
  const devices = job.scope.deviceCount ?? job.progress.total ?? 0;
  const operations = job.progress.total ?? job.scope.deviceCount ?? 0;
  const noun =
    action === 'reboot'
      ? `Reboot ${operations === 1 ? 'command' : 'commands'}`
      : actionNoun(action, operations);
  return `${deviceCountText(devices)} · ${operations.toLocaleString(
    'en-US',
  )} ${noun}. ${receiptCompletionSentence(job)}`;
}

/** "Reboot devices", the job action label of the receipt. */
export function jobActionLabel(action: DeviceAction): string {
  return `${ACTION_LABELS[action]} devices`;
}

/** The third table column of the Review step (mockup choice 4). */
export function targetColumnLabel(action: DeviceAction): string {
  return action === 'reboot' ? 'Command' : 'Status change';
}

/** The excluded cell of the Review step: "Not sent" for a command (mockup choice 4). */
export function notSentText(action: DeviceAction): string {
  return action === 'reboot' ? 'Not sent' : 'Not changed';
}

/** "Reboot targets". */
export function targetsLabel(action: DeviceAction): string {
  return `${ACTION_LABELS[action]} targets`;
}

/** "Frozen Reboot targets". */
export function targetsCaption(action: DeviceAction): string {
  return `Frozen ${ACTION_LABELS[action]} targets`;
}

/** The table label of the no-eligible card, which lists selected devices. */
export const SELECTED_DEVICES = 'Selected devices';

/** The third cell of one target row. */
export function targetCommandText(
  action: DeviceAction,
  target: DeviceActionTarget,
): string {
  return target.disposition === 'excluded'
    ? notSentText(action)
    : ACTION_LABELS[action];
}

/** The exclusion reasons of section 2, in the step 4 frame style. */
export function exclusionReasonText(reason: string | null): string {
  switch (reason) {
    case 'device-disabled':
      return 'Device is disabled';
    case 'device-deprovisioned':
      return 'Device is deprovisioned';
    case 'device-active':
      return 'Device is active';
    case 'status-unknown':
      return 'Device status is unknown';
    case 'removed':
      return 'Removed from inventory';
    case 'invalid-device-id':
      return 'Device ID cannot be written';
    default:
      return 'Device cannot take this action';
  }
}

/** A second line under the third cell, or an empty string. */
export function targetNote(target: DeviceActionTarget): string {
  return target.disposition === 'excluded'
    ? `Excluded · ${exclusionReasonText(target.exclusionReason)}`
    : '';
}

/** The device cell of a target row. */
export function targetDeviceText(target: DeviceActionTarget): string {
  return target.serialNumber || target.deviceId;
}

/** Google's status value in the record's words: Active, Disabled, Deprovisioned. */
export function observedStatusText(status: string | null): string {
  switch (status) {
    case 'ACTIVE':
      return 'Active';
    case 'DISABLED':
      return 'Disabled';
    case 'DEPROVISIONED':
      return 'Deprovisioned';
    case null:
      return 'No status';
    default:
      return status;
  }
}

/** The short reason label of the no-eligible count line. */
function reasonLabel(reason: string | null): string {
  switch (reason) {
    case 'device-active':
      return 'Already active';
    case 'device-disabled':
      return 'Disabled';
    case 'device-deprovisioned':
      return 'Deprovisioned';
    case 'status-unknown':
      return 'Status unknown';
    case 'removed':
      return 'Removed';
    case 'invalid-device-id':
      return 'Unusable device ID';
    default:
      return 'Excluded';
  }
}

/** "Nothing to re-enable". */
export function noEligibleTitle(action: DeviceAction): string {
  switch (action) {
    case 'reboot':
      return 'Nothing to reboot';
    case 'disable':
      return 'Nothing to disable';
    case 'reenable':
      return 'Nothing to re-enable';
  }
}

/** "No devices can be re-enabled". */
export function noEligibleHeading(action: DeviceAction): string {
  switch (action) {
    case 'reboot':
      return 'No devices can be rebooted';
    case 'disable':
      return 'No devices can be disabled';
    case 'reenable':
      return 'No devices can be re-enabled';
  }
}

/**
 * The three paragraphs of the no-eligible card (mockup choice 9). The first paragraph
 * names the reason when every target shares one, so the count line stays true.
 */
export function noEligibleParagraphs(
  action: DeviceAction,
  targets: readonly DeviceActionTarget[],
): readonly string[] {
  const excluded = targets.filter(
    (target) => target.disposition === 'excluded',
  );
  const count = excluded.length.toLocaleString('en-US');
  const reasons = new Set(excluded.map((target) => target.exclusionReason));
  const uniform = reasons.size === 1 ? [...reasons][0] : null;
  const allActive = action === 'reenable' && uniform === 'device-active';
  const first = allActive
    ? `All ${count} devices are already active.`
    : `${count} selected ${excluded.length === 1 ? 'device' : 'devices'} cannot take this action.`;
  const second = uniform
    ? `Eligible: 0 · ${reasonLabel(uniform)}: ${count}. No job will be created.`
    : `Eligible: 0 · ${count} excluded. No job will be created.`;
  const third =
    action === 'reenable'
      ? 'Select disabled devices to re-enable access.'
      : `Select active devices to ${action === 'reboot' ? 'reboot them' : 'disable them'}.`;
  return [first, second, third];
}

const NO_JOB = 'No job created';

const backToDevices = (primary = false): FlowAction => ({
  id: 'back-to-devices',
  label: 'Back to devices',
  primary,
});
const changeAction = (primary = false): FlowAction => ({
  id: 'back-to-choose',
  label: 'Change action',
  primary,
});
const openConnection: FlowAction = {
  id: 'open-google-connection',
  label: 'Open Google connection',
  primary: true,
};
const retry: FlowAction = { id: 'retry', label: 'Retry', primary: true };
const backToJobs: FlowAction = {
  id: 'back-to-jobs',
  label: 'View jobs',
  primary: true,
};

export interface ActionProblemContext {
  family: DeviceActionFamily;
  /** The chosen action, when the step that failed has one. */
  action: DeviceAction | null;
  /** The frozen targets of a no-eligible preview. */
  targets?: readonly DeviceActionTarget[];
  displayId?: string | null;
  expiresAt?: string | null;
  canOpenConnection?: boolean;
}

/**
 * One stalled state of a command or status sheet, in the step 4 problem frame. The
 * copy names the action instead of a draft, because these flows hold no draft.
 */
export function actionProblem(
  kind: FlowProblemKind,
  context: ActionProblemContext,
): FlowProblem {
  const family = FAMILY_COPY[context.family];
  const action = context.action;
  const connection = context.canOpenConnection ? openConnection : null;
  const expired = `The preview expired${
    context.expiresAt ? ` at ${formatTimestamp(context.expiresAt)}` : ''
  }. Its approval controls are no longer valid.`;
  switch (kind) {
    case 'preview-expired':
      return {
        kind,
        title: 'Preview expired',
        subtitle: NO_JOB,
        heading: 'Prepare a new preview before confirming',
        paragraphs: [
          expired,
          'Choose the action again to prepare a new preview. It rechecks targets, permissions, statuses, and expiry.',
        ],
        actions: [backToDevices(), changeAction(true)],
      };
    case 'preview-changed':
      return {
        kind,
        title: 'Preview changed',
        subtitle: NO_JOB,
        heading: 'Review the current targets in a new preview',
        paragraphs: [
          'The approved scope changed after this preview was prepared. Its approval controls are no longer valid.',
          'Choose the action again to prepare a new preview.',
        ],
        actions: [backToDevices(), changeAction(true)],
      };
    case 'permission-changed':
      return {
        kind,
        title: 'Your access changed',
        subtitle: NO_JOB,
        heading: 'Review your access before you create the job',
        paragraphs: [
          'Your permissions changed after this preview was prepared. The preview can no longer become a job.',
          family.permissionMessage,
        ],
        actions: [backToDevices(true)],
      };
    case 'connection-changed':
      return {
        kind,
        title: 'The Google connection changed',
        subtitle: NO_JOB,
        heading: 'Reconnect Google Workspace before you create the job',
        paragraphs: [
          'The Google connection changed after this preview was prepared. Its approval controls are no longer valid.',
          'Check the Google connection, then prepare a new preview.',
        ],
        actions: [backToDevices(), connection ?? changeAction(true)],
      };
    case 'connection-required':
      return {
        kind,
        title: 'Google Workspace is not connected',
        subtitle: NO_JOB,
        heading: 'Connect Google Workspace to send this action',
        paragraphs: [
          'Campus Commander has no Google Workspace connection for this customer. Connect it, then prepare a new preview.',
        ],
        actions: [backToDevices(), connection ?? changeAction(true)],
      };
    case 'nothing-to-update': {
      const target = action ?? 'reboot';
      return {
        kind,
        title: noEligibleTitle(target),
        subtitle: `${(context.targets?.length ?? 0).toLocaleString(
          'en-US',
        )} selected ${
          context.targets?.length === 1 ? 'device' : 'devices'
        } · ${NO_JOB}`,
        heading: noEligibleHeading(target),
        paragraphs: noEligibleParagraphs(target, context.targets ?? []),
        actions: [
          backToDevices(),
          ...(context.family === 'status' ? [changeAction(true)] : []),
        ],
      };
    }
    case 'forbidden':
      return {
        kind,
        title: `${family.menuLabel} is unavailable`,
        subtitle: NO_JOB,
        heading: 'Your access does not permit this action',
        paragraphs: [family.permissionMessage],
        actions: [backToDevices(true)],
      };
    case 'preview-not-found':
      return {
        kind,
        title: 'Preview not found',
        subtitle: NO_JOB,
        heading: 'This preview is unavailable',
        paragraphs: [
          'The preview does not exist or belongs to another person. Choose the action again to prepare a new preview.',
        ],
        actions: [backToDevices(), changeAction(true)],
      };
    case 'selection-expired':
      return {
        kind,
        title: 'Selection expired',
        subtitle: NO_JOB,
        heading: 'Select the devices again',
        paragraphs: [
          'The browsing selection expired. Return to Devices and select the devices again before you prepare a preview.',
        ],
        actions: [backToDevices(true)],
      };
    case 'selection-too-large':
      return {
        kind,
        title: 'The selection is too large',
        subtitle: NO_JOB,
        heading: 'Narrow the filters and select again',
        paragraphs: [
          'The selection holds more than 100,000 devices. Narrow the filters before you prepare a new preview.',
        ],
        actions: [backToDevices(true)],
      };
    case 'nothing-selected':
      return {
        kind,
        title: 'No devices are selected',
        subtitle: NO_JOB,
        heading: 'Select the devices again',
        paragraphs: [
          'The selection holds no devices. Return to Devices and select the devices again before you prepare a preview.',
        ],
        actions: [backToDevices(true)],
      };
    case 'confirm-uncertain':
      return {
        kind,
        title: 'The confirmation did not finish',
        subtitle: 'The result is unknown',
        heading: 'Retry the confirmation',
        paragraphs: [
          `Campus Commander did not answer the confirmation, or the answer was not readable. The ${family.jobNoun} may exist.`,
          'Retry sends the same confirmation. If the job exists, Campus Commander returns its receipt.',
        ],
        actions: [backToDevices(), retry],
      };
    case 'confirm-receipt-unavailable':
      return {
        kind,
        title: `The ${family.jobNoun} may exist`,
        subtitle: 'The receipt is unavailable',
        heading: 'Check Jobs for this job',
        paragraphs: [
          `Campus Commander could not return the receipt for this confirmation. The ${family.jobNoun} may exist.`,
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
        subtitle: NO_JOB,
        heading: 'Check the connection and retry',
        paragraphs: [
          'Campus Commander did not answer. Check the connection and retry.',
        ],
        actions: [backToDevices(), retry],
      };
  }
}
