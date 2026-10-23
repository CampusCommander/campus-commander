import type {
  DeviceActionPreview,
  DeviceActionTarget,
} from '@campus/application-contracts';
import {
  ACTION_FROZEN_TARGETS,
  CHANGE_STATUS_PERMISSION_MESSAGE,
  FAMILY_COPY,
  SEND_COMMAND_PERMISSION_MESSAGE,
  acknowledgementLabel,
  actionConsequence,
  actionProblem,
  confirmationButton,
  confirmationHeading,
  confirmationMetaLine,
  confirmationParagraphs,
  confirmationTitle,
  deviceActionNote,
  exclusionReasonText,
  noEligibleHeading,
  noEligibleParagraphs,
  noEligibleTitle,
  notSentText,
  observedStatusText,
  receiptActionLine,
  reviewCountLine,
  reviewTitle,
  targetCommandText,
  targetNote,
  targetSummaryText,
  targetColumnLabel,
  targetsCaption,
  targetsLabel,
} from './device-action-messages';
import { deviceCountText } from './device-update-messages';

const preview: DeviceActionPreview = {
  previewId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayId: 'PV-002',
  action: 'reboot',
  commandType: 'REBOOT',
  statusAction: null,
  deprovisionReason: null,
  selected: 8,
  eligible: 6,
  excluded: 2,
  oldestObservedAt: '2026-10-20T10:00:00.000Z',
  stale: false,
  preparedAt: '2026-10-20T19:02:00.000Z',
  expiresAt: '2026-10-20T19:17:00.000Z',
  manifestDigest: 'a'.repeat(64),
};

const excluded = (
  index: number,
  observedStatus: string,
  exclusionReason: string,
): DeviceActionTarget => ({
  deviceId: `device-${index}`,
  serialNumber: `C0A1-000${index}`,
  orgUnitPath: '/School A',
  observedStatus,
  observedAt: '2026-10-20T18:50:00.000Z',
  disposition: 'excluded',
  exclusionReason,
});

it('words the target summary in the mockup form and keeps the verb with the count', () => {
  expect(targetSummaryText('reboot', 6, 8)).toBe(
    '6 of 8 selected devices are active.',
  );
  expect(targetSummaryText('disable', 6, 8)).toBe(
    '6 of 8 selected devices are active.',
  );
  expect(targetSummaryText('reenable', 1, 8)).toBe(
    '1 of 8 selected devices is disabled.',
  );
  expect(targetSummaryText('reenable', 0, 8)).toBe(
    '0 of 8 selected devices are disabled.',
  );
  expect(targetSummaryText('reboot', 1, 1)).toBe(
    '1 of 1 selected device is active.',
  );
});

it('titles each step in the approved form', () => {
  expect(reviewTitle('reboot', 6)).toBe('Review 6 Reboot commands');
  expect(reviewTitle('disable', 1)).toBe('Review 1 Disable status change');
  expect(confirmationTitle('reboot', 6)).toBe('Reboot 6 devices');
  expect(confirmationTitle('disable', 6)).toBe('Disable 6 devices');
  expect(confirmationTitle('reenable', 1)).toBe('Re-enable 1 device');
  expect(reviewCountLine('reboot', preview)).toBe(
    '8 devices · 6 commands · 2 excluded',
  );
  expect(reviewCountLine('disable', preview)).toBe(
    '8 devices · 6 status changes · 2 excluded',
  );
  expect(confirmationMetaLine('reboot', preview)).toBe(
    'Preview PV-002 · 8 devices · 6 commands',
  );
  expect(deviceCountText(1)).toBe('1 device');
});

it('keeps the approved confirmation copy of each action', () => {
  expect(confirmationHeading('reboot', 6)).toBe(
    'Reboot interrupts active sessions',
  );
  expect(confirmationHeading('disable', 6)).toBe(
    'Block user access on 6 devices',
  );
  expect(confirmationParagraphs('reboot', 6, 2)).toContain(
    'Google accepting the request does not confirm execution. Track each device in the job.',
  );
  expect(confirmationParagraphs('disable', 6, 2)).toContain(
    '6 eligible · 2 excluded · Exact targets are recorded with the job.',
  );
  expect(confirmationButton('reboot', 6)).toBe('Send Reboot to 6 devices');
  expect(confirmationButton('disable', 6)).toBe('Disable 6 devices');
  expect(acknowledgementLabel('reboot')).toBe(
    'I understand that restarting these devices interrupts users.',
  );
  expect(acknowledgementLabel('disable')).toBeNull();
  expect(acknowledgementLabel('reenable')).toBeNull();
});

it('names the command and status columns of the review table', () => {
  expect(targetColumnLabel('reboot')).toBe('Command');
  expect(targetColumnLabel('disable')).toBe('Status change');
  expect(notSentText('reboot')).toBe('Not sent');
  expect(notSentText('reenable')).toBe('Not changed');
  expect(targetsLabel('reboot')).toBe('Reboot targets');
  expect(targetsCaption('reenable')).toBe('Frozen Re-enable targets');
  expect(ACTION_FROZEN_TARGETS).toBe(
    'Targets are frozen. New matching devices will not join this job.',
  );
});

it('writes every exclusion reason in the step 4 frame form', () => {
  expect(exclusionReasonText('device-disabled')).toBe('Device is disabled');
  expect(exclusionReasonText('device-deprovisioned')).toBe(
    'Device is deprovisioned',
  );
  expect(exclusionReasonText('device-active')).toBe('Device is active');
  expect(exclusionReasonText('status-unknown')).toBe(
    'Device status is unknown',
  );
  expect(exclusionReasonText('removed')).toBe('Removed from inventory');
  expect(exclusionReasonText('invalid-device-id')).toBe(
    'Device ID cannot be written',
  );
  const target = excluded(7, 'DISABLED', 'device-disabled');
  expect(targetNote(target)).toBe('Excluded · Device is disabled');
  expect(targetCommandText('reboot', target)).toBe('Not sent');
  expect(targetCommandText('reenable', target)).toBe('Not changed');
});

it('shows Google status values in the record words', () => {
  expect(observedStatusText('ACTIVE')).toBe('Active');
  expect(observedStatusText('DISABLED')).toBe('Disabled');
  expect(observedStatusText('DEPROVISIONED')).toBe('Deprovisioned');
  expect(observedStatusText('RETIRED')).toBe('RETIRED');
  expect(observedStatusText(null)).toBe('No status');
});

it('counts the receipt with the action name of the command', () => {
  const job = {
    scope: { kind: 'devices' as const, deviceCount: 6 },
    progress: { total: 6 },
    status: 'running' as const,
  };
  expect(
    receiptActionLine(
      'reboot',
      job as unknown as Parameters<typeof receiptActionLine>[1],
    ),
  ).toBe('6 devices · 6 Reboot commands. Google changes have not completed.');
  expect(
    receiptActionLine(
      'disable',
      job as unknown as Parameters<typeof receiptActionLine>[1],
    ),
  ).toBe('6 devices · 6 status changes. Google changes have not completed.');
});

it('states the no-eligible case without claiming a job', () => {
  const active = [
    excluded(1, 'ACTIVE', 'device-active'),
    excluded(2, 'ACTIVE', 'device-active'),
    excluded(3, 'ACTIVE', 'device-active'),
  ];
  expect(noEligibleTitle('reenable')).toBe('Nothing to re-enable');
  expect(noEligibleHeading('reenable')).toBe('No devices can be re-enabled');
  expect(noEligibleParagraphs('reenable', active)).toEqual([
    'All 3 devices are already active.',
    'Eligible: 0 · Already active: 3. No job will be created.',
    'Select disabled devices to re-enable access.',
  ]);
  const mixed = [
    excluded(1, 'ACTIVE', 'device-active'),
    excluded(2, 'DEPROVISIONED', 'device-deprovisioned'),
  ];
  expect(noEligibleParagraphs('reenable', mixed)).toEqual([
    '2 selected devices cannot take this action.',
    'Eligible: 0 · 2 excluded. No job will be created.',
    'Select disabled devices to re-enable access.',
  ]);
  expect(noEligibleParagraphs('reboot', active)).toEqual([
    '3 selected devices cannot take this action.',
    'Eligible: 0 · Already active: 3. No job will be created.',
    'Select active devices to reboot them.',
  ]);
});

it('carries the action title and the sheet subtitle of the no-eligible card', () => {
  const active = [excluded(1, 'ACTIVE', 'device-active')];
  const problem = actionProblem('nothing-to-update', {
    family: 'status',
    action: 'reenable',
    targets: active,
  });
  expect(problem.title).toBe('Nothing to re-enable');
  expect(problem.subtitle).toBe('1 selected device · No job created');
  expect(problem.heading).toBe('No devices can be re-enabled');
  expect(problem.actions.map((action) => action.label)).toEqual([
    'Back to devices',
    'Change action',
  ]);
  expect(problem.actions[1].primary).toBe(true);
  const command = actionProblem('nothing-to-update', {
    family: 'command',
    action: 'reboot',
    targets: active,
  });
  expect(command.title).toBe('Nothing to reboot');
  expect(command.actions.map((action) => action.label)).toEqual([
    'Back to devices',
  ]);
});

it('names the family permission in each problem that a permission can cause', () => {
  expect(
    actionProblem('forbidden', { family: 'command', action: 'reboot' }).title,
  ).toBe('Send command is unavailable');
  expect(
    actionProblem('forbidden', { family: 'status', action: 'disable' })
      .paragraphs,
  ).toEqual([CHANGE_STATUS_PERMISSION_MESSAGE]);
  expect(FAMILY_COPY.command.permissionMessage).toBe(
    SEND_COMMAND_PERMISSION_MESSAGE,
  );
  expect(FAMILY_COPY.status.permissionMessage).toBe(
    CHANGE_STATUS_PERMISSION_MESSAGE,
  );
});

it('names the family action in the menu note of each entry', () => {
  const granted = {
    scope: 'https://www.googleapis.com/auth/admin.directory.device.chromeos',
    failure: null,
    checkedAt: '2026-10-20T19:00:00.000Z',
  };
  const shared = {
    offline: false,
    canRead: true,
    canBulk: true,
    selectionCount: 8,
    access: { state: 'granted' as const, ...granted },
    accessLoading: false,
  };
  expect(
    deviceActionNote({ ...shared, family: 'command', canAction: true }),
  ).toBeNull();
  expect(
    deviceActionNote({ ...shared, family: 'command', canAction: false })?.text,
  ).toBe(SEND_COMMAND_PERMISSION_MESSAGE);
  expect(
    deviceActionNote({ ...shared, family: 'status', canAction: false })?.text,
  ).toBe(CHANGE_STATUS_PERMISSION_MESSAGE);
  expect(
    deviceActionNote({
      ...shared,
      family: 'status',
      canAction: true,
      selectionCount: 0,
    })?.text,
  ).toBe('Select one or more devices to update.');
  expect(
    deviceActionNote({
      ...shared,
      family: 'command',
      canAction: true,
      selectionCount: 0,
    })?.text,
  ).toBe('Select one or more devices to update.');
  expect(
    deviceActionNote({
      ...shared,
      family: 'command',
      canAction: true,
      offline: true,
    })?.text,
  ).toBe('Update device is unavailable while you are offline.');
});

it('words each command consequence from the record', () => {
  expect(actionConsequence('reboot')).toBe(
    'Restarts the devices and interrupts active sessions.',
  );
  expect(actionConsequence('disable')).toBe(
    'Blocks user access while keeping devices enrolled.',
  );
  expect(actionConsequence('reenable')).toBe(
    'Restores access to disabled devices.',
  );
});
