import {
  DEPROVISION_REASON_LABELS,
  DEVICE_UPDATE_FIELD_LABELS,
  jobOperationFieldSchema,
  type JobCommandState,
  type JobDetail,
  type JobFailedActivityOperation,
  type JobOperation,
  type JobOutcome,
  type JobProgress,
  type JobUnknownActivityOperation,
} from '@campus/application-contracts';
import type { AuthStore } from '../auth.store';
import { statusText } from '../devices/device-fields';
import { deviceCountText } from '../devices/device-update-messages';
import { formatDuration, formatTimestamp } from './job-fields';

/** The outcome tones of the shared status chip (UI-04). */
export type OutcomeTone = 'neutral' | 'info' | 'warning' | 'error' | 'success';

export const OUTCOME_LABELS: Readonly<Record<JobOutcome, string>> = {
  pending: 'Pending',
  succeeded: 'Succeeded',
  failed: 'Failed',
  unknown: 'Unknown',
  skipped: 'Skipped',
  expired: 'Expired',
};

export function outcomeTone(outcome: JobOutcome): OutcomeTone {
  switch (outcome) {
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'error';
    case 'unknown':
    case 'expired':
      return 'warning';
    default:
      return 'neutral';
  }
}

/**
 * The chip of one issued command state (step 5 mockup, note 12).
 * Pending delivery is neutral. Acknowledged is info. Google reports `sent`
 * between them, so the plain state name carries the same neutral tone.
 */
const COMMAND_STATE_CHIPS: Readonly<
  Record<JobCommandState, { label: string; tone: OutcomeTone }>
> = {
  'pending-delivery': { label: 'Pending delivery', tone: 'neutral' },
  sent: { label: 'Sent', tone: 'neutral' },
  acknowledged: { label: 'Acknowledged', tone: 'info' },
};

/** The chip of one operation. A command in flight shows its stored command state. */
export function operationChip(operation: JobOperation): {
  label: string;
  tone: OutcomeTone;
} {
  if (operation.outcome === 'pending' && operation.commandState)
    return COMMAND_STATE_CHIPS[operation.commandState];
  return {
    label: OUTCOME_LABELS[operation.outcome],
    tone: outcomeTone(operation.outcome),
  };
}

/**
 * The notes under an outcome chip (mockup state 09, DEVICE-02).
 * A command that still waits, or settled unknown, keeps Google's expiry, because the
 * command stays armed at Google. An unknown row that closed the watch window names the
 * window (record ruling 2).
 */
export function outcomeNotes(
  operation: JobOperation,
  now = new Date(),
): readonly string[] {
  if (!isCommandOperation(operation)) return [];
  const notes: string[] = [];
  if (
    operation.outcome === 'unknown' &&
    operation.outcomeReason === 'not-observed'
  )
    notes.push('No result in 30 days');
  if (
    operation.commandExpiresAt &&
    (operation.outcome === 'pending' || operation.outcome === 'unknown')
  )
    notes.push(`Expires ${formatTimestamp(operation.commandExpiresAt, now)}`);
  return notes;
}

/** One counter of the outcome row. Order follows the frame. */
export interface JobCounter {
  key: string;
  label: string;
  value: number | null;
  tone: OutcomeTone;
}

/**
 * The seven counters of the command job detail (step 5 mockup, note 11).
 * Expired follows Unknown. Pending counts Pending delivery and Acknowledged.
 * Cancellation is outside this slice (design 1.2), so Cancelled stays at zero.
 */
export function jobCounters(progress: JobProgress): readonly JobCounter[] {
  return [
    {
      key: 'succeeded',
      label: 'Succeeded',
      value: progress.succeeded,
      tone: 'success',
    },
    { key: 'failed', label: 'Failed', value: progress.failed, tone: 'error' },
    {
      key: 'unknown',
      label: 'Unknown',
      value: progress.unknown,
      tone: 'warning',
    },
    {
      key: 'expired',
      label: 'Expired',
      value: progress.expired,
      tone: 'warning',
    },
    {
      key: 'pending',
      label: 'Pending',
      value: progress.pending,
      tone: 'neutral',
    },
    {
      key: 'skipped',
      label: 'Skipped',
      value: progress.skipped,
      tone: 'neutral',
    },
    { key: 'cancelled', label: 'Cancelled', value: 0, tone: 'neutral' },
  ];
}

/** The failed, unknown, and expired operations that the attention filter reads. */
export function attentionCount(job: JobDetail): number {
  return job.progress.failed + job.progress.unknown + job.progress.expired;
}

/** The operations that the job records. A running full sync holds null. */
export function operationTotal(job: JobDetail): number {
  return job.progress.total ?? job.scope.deviceCount ?? 0;
}

/** The second line of the identity card of frame 104:209. */
export function identityLine(job: JobDetail, now = new Date()): string {
  const duration = job.startedAt
    ? `Duration: ${formatDuration(job.startedAt, job.finishedAt ?? now.toISOString())}`
    : 'Duration: not started';
  return `Requested by ${job.requestedBy.displayName} · ${formatTimestamp(
    job.createdAt,
    now,
  )} · ${duration}`;
}

/** The card heading of frame 104:209: "UPD-006 · 6 devices". */
export function scopeHeading(job: JobDetail): string {
  const count = job.scope.deviceCount;
  return count === null
    ? job.displayId
    : `${job.displayId} · ${deviceCountText(count)}`;
}

/** "Annotated location". The label of each writable field, or a dash without one. */
export function fieldLabel(field: JobOperation['field']): string {
  return field === null ? '—' : DEVICE_UPDATE_FIELD_LABELS[field];
}

/** The Operation cell of one row. A command or status row names its action. */
export function operationLabel(operation: JobOperation): string {
  switch (operation.operation) {
    case 'reboot':
      return 'Reboot';
    case 'wipe-users':
      return 'Wipe user data';
    case 'powerwash':
      return 'Powerwash';
    case 'disable':
      return 'Disable';
    case 'reenable':
      return 'Re-enable';
    case 'deprovision':
      return 'Deprovision';
    default:
      return fieldLabel(operation.field);
  }
}

/** A command row has no Reconcile action (record default 4). */
export function isCommandOperation(operation: JobOperation): boolean {
  return (
    operation.operation === 'reboot' ||
    operation.operation === 'wipe-users' ||
    operation.operation === 'powerwash'
  );
}

/** A command job offers no Reconcile for any operation (record default 4, D13). */
export function isCommandJob(job: Pick<JobDetail, 'action'>): boolean {
  return (
    job.action === 'reboot-devices' ||
    job.action === 'wipe-user-data' ||
    job.action === 'powerwash-devices'
  );
}

/** A before value. A command reads "—", as in Figma 99:73. */
export function beforeText(operation: JobOperation): string {
  switch (operation.operation) {
    case 'reboot':
    case 'wipe-users':
    case 'powerwash':
      return '—';
    case 'disable':
    case 'reenable':
    case 'deprovision':
      return operation.baselineValue
        ? statusText(operation.baselineValue)
        : '—';
    default:
      return operation.baselineValue ?? 'Not set';
  }
}

/** A requested value. A command repeats its action; a status change names the status. */
export function requestedText(operation: JobOperation): string {
  switch (operation.operation) {
    case 'reboot':
      return 'Reboot';
    case 'wipe-users':
      return 'Wipe user data';
    case 'powerwash':
      return 'Powerwash';
    case 'disable':
      return operation.requestedValue
        ? statusText(operation.requestedValue)
        : 'Disabled';
    case 'reenable':
      return operation.requestedValue
        ? statusText(operation.requestedValue)
        : 'Active';
    case 'deprovision':
      return operation.requestedValue
        ? statusText(operation.requestedValue)
        : 'Deprovisioned';
    case 'move':
      // A Move always carries its destination path (addendum section 1).
      return operation.requestedValue ?? '—';
    default:
      return operation.requestedValue ?? 'Clear value';
  }
}

/** The time of one operation, as in the frame. The full time stays on the element. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The operation number of an update or status ID (`STS-002-12` gives `12`, `UPD-001-2-notes`
 * gives `2`). An update row names its field, and the field never changes the number.
 */
export function operationNumber(operationId: string): string | null {
  // Commands offer no reconciliation (record default 4), so a CMD- ID stays invalid.
  const match = /^(?:UPD|STS)-\d{3,}-(\d+)(?:-(.+))?$/.exec(operationId);
  if (!match) return null;
  const field = match[2];
  if (field !== undefined && !jobOperationFieldSchema.safeParse(field).success)
    return null;
  return match[1] ?? null;
}

/**
 * Reconcile of an update operation needs jobs:read and devices:write
 * (2026-10-16-device-write-jobs-design.md:469, OQ6). Reconcile of a status
 * operation needs jobs:read and devices:status (2026-10-21-device-command-jobs-design.md:241).
 * A Deprovision operation needs jobs:read and devices:deprovision (record ruling 1).
 * A command row offers none, because the operations grid excludes it (record default 4, D13).
 */
export function canReconcile(
  auth: InstanceType<typeof AuthStore>,
  job: Pick<JobDetail, 'action' | 'statusAction'>,
): boolean {
  if (auth.metadata()?.phase !== 3) return false;
  if (isCommandJob(job)) return false;
  const grants = auth.session()?.identity.grants ?? [];
  const action =
    job.statusAction === 'deprovision'
      ? 'devices:deprovision'
      : job.statusAction
        ? 'devices:status'
        : 'devices:write';
  return (
    grants.some((grant) => grant.action === 'jobs:read') &&
    grants.some((grant) => grant.action === action)
  );
}

/** The Deprovision reason of the identity card (record D12, Figma 106:203). */
export function reasonLine(
  job: Pick<JobDetail, 'deprovisionReason'>,
): string | null {
  return job.deprovisionReason
    ? `Deprovision reason: ${DEPROVISION_REASON_LABELS[job.deprovisionReason]}`
    : null;
}

const NUMBER_WORDS = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
] as const;

/** The frame spells "Twelve operations". Larger counts keep digits. */
function spellCount(value: number): string {
  return value >= 0 && value < NUMBER_WORDS.length
    ? NUMBER_WORDS[value]
    : value.toLocaleString('en-US');
}

/** The subject of a failure sentence. A command names its own reason. */
export type FailureSubject = 'update' | 'status change' | 'command';

/** The noun that a value-differs sentence reads after "requested". */
function requestedNoun(subject: FailureSubject): string {
  switch (subject) {
    case 'update':
      return 'value';
    case 'status change':
      return 'status';
    case 'command':
      return 'state';
  }
}

/**
 * One failure sentence of the Latest activity line (design 2.5, OQ9).
 * A 401 or 403 that is not a quota refusal reads as a permission failure.
 * A status job names its status change; the default subject keeps the update copy.
 * A command names its issue refusal. Only commandFailureSentence claims execution.
 */
export function failureSentence(
  operation: JobFailedActivityOperation,
  subject: FailureSubject = 'update',
): string {
  const serial = operation.serialNumber || operation.deviceId;
  if (
    (operation.googleStatus === 401 || operation.googleStatus === 403) &&
    operation.outcomeReason !== 'quota'
  )
    return `Permission failure on ${serial}.`;
  switch (operation.outcomeReason) {
    case 'not-found':
      return `${serial} was not found in Google Workspace.`;
    case 'quota':
      return `Google quota stopped the ${subject} for ${serial}.`;
    case 'value-differs':
      return `${serial} does not hold the requested ${requestedNoun(subject)}.`;
    case 'invalid-response':
      return `Google returned an invalid response for ${serial}.`;
    case 'ambiguous':
      return `The outcome for ${serial} is uncertain.`;
    default:
      return operation.outcomeReason
        ? `Google rejected the ${subject} for ${serial} (${operation.outcomeReason}).`
        : `The ${subject} failed for ${serial}.`;
  }
}

/**
 * One failure sentence of a command job. It names no retry and no reconciliation.
 * A `command-failed` settlement is the only evidence that a device executed the
 * command and failed. A `command-cancelled` settlement names Google's cancellation.
 * An issue refusal keeps its own reason.
 */
export function commandFailureSentence(
  operation: JobFailedActivityOperation,
): string {
  if (operation.outcomeReason === 'command-failed')
    return `${operation.serialNumber || operation.deviceId} reported an execution failure.`;
  if (operation.outcomeReason === 'command-cancelled')
    return `Google cancelled the command for ${operation.serialNumber || operation.deviceId}.`;
  return failureSentence(operation, 'command');
}

/**
 * The sentence under a failed row (mockup note 22). An update row names the app outcome, because a
 * read-back failure has no Google reason. A command or status row keeps the step 5 line, which
 * names the Google reason. A cancelled command carries no Google reason of its own.
 */
export function rowFailureText(
  job: Pick<JobDetail, 'changes'>,
  operation: JobOperation,
): string | null {
  if (operation.outcome !== 'failed') return null;
  if (
    isCommandOperation(operation) &&
    operation.outcomeReason === 'command-cancelled'
  )
    return 'Google cancelled the command.';
  if (job.changes === null) return operation.googleReason;
  return failureSentence(operation, 'update');
}

/**
 * The parts of a value in the Before and Requested cells. An OU path breaks after each slash
 * (mockup note 17), so the cell renders a word break between the parts. A value without a leading
 * slash is one part.
 */
export function pathParts(value: string): string[] {
  if (!value.startsWith('/')) return [value];
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '/' || index === start) continue;
    parts.push(value.slice(start, index + 1));
    start = index + 1;
  }
  if (start < value.length) parts.push(value.slice(start));
  return parts;
}

/** One uncertain command sentence. A command has no reconciliation (record default 4). */
export function commandUncertainSentence(
  operation: JobUnknownActivityOperation,
): string {
  return `The outcome for ${
    operation.serialNumber || operation.deviceId
  } is uncertain.`;
}

/** One reconciliation sentence of the Latest activity line. */
export function reconciliationSentence(
  operation: JobUnknownActivityOperation,
): string {
  return `${operation.serialNumber || operation.deviceId} requires reconciliation before any retry.`;
}

/** The newest sample time of a sample line. */
function sampleTime(
  failed: readonly JobFailedActivityOperation[],
  unknown: readonly JobUnknownActivityOperation[],
): string {
  const samples = [...failed, ...unknown];
  return samples.reduce((newest, sample) =>
    Date.parse(sample.updatedAt) > Date.parse(newest.updatedAt)
      ? sample
      : newest,
  ).updatedAt;
}

/**
 * The first sample of each device. An update job answers one row per device and field, so one
 * device can supply several samples. Latest activity names each device once (mockup note 23).
 */
function sampleDevices<T extends { deviceId: string }>(
  samples: readonly T[],
): T[] {
  const devices = new Set<string>();
  return samples.filter((sample) => {
    if (devices.has(sample.deviceId)) return false;
    devices.add(sample.deviceId);
    return true;
  });
}

/** The noun of the confirmed operations in a write job. */
function writeSubject(job: JobDetail): { one: string; many: string } {
  return job.action === 'disable-devices' ||
    job.action === 'reenable-devices' ||
    job.action === 'deprovision-devices'
    ? { one: 'status change', many: 'status changes' }
    : { one: 'update', many: 'updates' };
}

/** The action name of a command job. The expiry sentence names its command. */
function commandName(action: JobDetail['action']): string {
  switch (action) {
    case 'wipe-user-data':
      return 'Wipe user data';
    case 'powerwash-devices':
      return 'Powerwash';
    default:
      return 'Reboot';
  }
}

/** The counter line of a write job of frame 228:4524. */
function updateCounterLine(job: JobDetail): string {
  const { succeeded, pending } = job.progress;
  const subject = writeSubject(job);
  const time = formatTime(job.latestActivity.at);
  const confirmed = `${succeeded.toLocaleString('en-US')} ${
    succeeded === 1 ? subject.one : subject.many
  } confirmed.`;
  if (pending !== null && pending > 0)
    return `${time} · ${confirmed} ${spellCount(pending)} ${
      pending === 1 ? 'operation remains' : 'operations remain'
    } pending.`;
  return `${time} · ${confirmed} No operations remain pending.`;
}

/**
 * The Latest activity line of a command job (step 5 mockup, note 12).
 * The line names expired commands, the failed and uncertain samples, and the
 * commands that wait for their device. It never offers reconciliation.
 */
function commandCounterLine(job: JobDetail): string {
  const { expired, pending, succeeded } = job.progress;
  const { failed, unknown } = job.latestActivity;
  const time = formatTime(job.latestActivity.at);
  const parts: string[] = [];
  if (expired > 0)
    parts.push(
      `${expired.toLocaleString('en-US')} ${commandName(job.action)} ${
        expired === 1 ? 'command' : 'commands'
      } expired before execution.`,
    );
  parts.push(...failed.operations.map(commandFailureSentence));
  const unshownFailed = failed.count - failed.operations.length;
  if (unshownFailed > 0)
    parts.push(
      `${unshownFailed.toLocaleString('en-US')} ${
        unshownFailed === 1 ? 'command failed.' : 'commands failed.'
      }`,
    );
  parts.push(...unknown.operations.map(commandUncertainSentence));
  const unshownUnknown = unknown.count - unknown.operations.length;
  if (unshownUnknown > 0)
    parts.push(
      `${unshownUnknown.toLocaleString('en-US')} ${
        unshownUnknown === 1 ? 'command outcome is' : 'command outcomes are'
      } uncertain.`,
    );
  if (pending !== null && pending > 0)
    parts.push(
      `${pending.toLocaleString('en-US')} ${
        pending === 1 ? 'command waits' : 'commands wait'
      } for device execution.`,
    );
  if (!parts.length)
    parts.push(
      `${succeeded.toLocaleString('en-US')} ${
        succeeded === 1 ? 'command confirmed.' : 'commands confirmed.'
      }`,
    );
  return `${time} · ${parts.join(' ')}`;
}

/** The drafted counter line of a refresh job. Its latest activity has no samples. */
function refreshCounterLine(job: JobDetail): string {
  const { succeeded, failed, pending } = job.progress;
  const time = formatTime(job.latestActivity.at);
  const parts = [
    `${succeeded.toLocaleString('en-US')} ${
      succeeded === 1 ? 'device' : 'devices'
    } read.`,
  ];
  // A refresh reports failed device counts without operation samples (section 2.5).
  if (failed > 0)
    parts.push(
      `${failed.toLocaleString('en-US')} ${
        failed === 1 ? 'device' : 'devices'
      } could not be read.`,
    );
  switch (job.status) {
    case 'completed':
      parts.push('The refresh completed.');
      break;
    case 'completed-with-errors':
      parts.push('The refresh completed with errors.');
      break;
    case 'failed':
      parts.push('The refresh failed.');
      break;
    case 'needs-review':
      parts.push('The refresh needs review.');
      break;
    default:
      parts.push(
        pending !== null && pending > 0
          ? `${spellCount(pending)} ${
              pending === 1 ? 'device remains' : 'devices remain'
            } to read.`
          : 'The refresh continues.',
      );
  }
  return `${time} · ${parts.join(' ')}`;
}

/**
 * The Latest activity line of section 2.5. Sample lines name each failed and unknown
 * operation of the whole job. Counters supply the time and totals when no sample exists.
 * A refresh job has no operations, so its counters always supply the line.
 */
export function latestActivityLine(job: JobDetail): string {
  if (job.action === 'refresh-inventory') return refreshCounterLine(job);
  if (isCommandJob(job)) return commandCounterLine(job);
  const subject =
    job.action === 'disable-devices' ||
    job.action === 'reenable-devices' ||
    job.action === 'deprovision-devices'
      ? 'status change'
      : 'update';
  const { failed, unknown } = job.latestActivity;
  // Every row of one device carries the result of its one PATCH, so its samples repeat.
  const failedSamples = sampleDevices(failed.operations);
  const unknownSamples = sampleDevices(unknown.operations);
  if (failedSamples.length || unknownSamples.length) {
    const sentences = [
      ...failedSamples.map((operation: JobFailedActivityOperation) =>
        failureSentence(operation, subject),
      ),
      ...unknownSamples.map(reconciliationSentence),
    ];
    return `${formatTime(sampleTime(failedSamples, unknownSamples))} · ${sentences.join(' ')}`;
  }
  if (failed.count || unknown.count) {
    const sentences = [
      ...(failed.count
        ? [
            `${failed.count.toLocaleString('en-US')} ${
              failed.count === 1 ? 'operation failed.' : 'operations failed.'
            }`,
          ]
        : []),
      ...(unknown.count
        ? [
            `${unknown.count.toLocaleString('en-US')} ${
              unknown.count === 1 ? 'operation requires' : 'operations require'
            } reconciliation before any retry.`,
          ]
        : []),
    ];
    return `${formatTime(job.latestActivity.at)} · ${sentences.join(' ')}`;
  }
  return updateCounterLine(job);
}

/**
 * The row total of a job, or null when the client cannot know it. An update job with more than one
 * change answers one row per device and field, and its header counts devices. One change keeps one
 * row per device, so its device total is exact.
 */
function rowTotal(job: JobDetail): string | null {
  if (job.changes !== null && job.changes.length > 1) return null;
  return operationTotal(job).toLocaleString('en-US');
}

/** The footer of the operations grid for the current filter and page. */
export function operationsFooter(
  job: JobDetail,
  options: {
    attention: boolean;
    pageIndex: number;
    pageSize: number;
    shown: number;
    hasNext: boolean;
  },
): string {
  const total = rowTotal(job);
  if (!options.shown)
    return options.attention
      ? total === null
        ? '0 matching operations'
        : `0 matching operations · ${total} total`
      : total === null
        ? '0 operations'
        : `0 of ${total} operations`;
  const start = options.pageIndex * options.pageSize + 1;
  const end = start + options.shown - 1;
  const range = `Rows ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')}`;
  if (options.attention) {
    // A multi-field job has no row total, so the range names the shown matching rows alone.
    if (total === null) return `${range} matching operations`;
    // The single-page frame 231:4707 reads "2 matching operations · 6 total".
    // A later page keeps its row range, so the range never collapses to a page length.
    if (options.pageIndex === 0 && !options.hasNext) {
      const matching = attentionCount(job);
      return `${matching.toLocaleString('en-US')} matching ${
        matching === 1 ? 'operation' : 'operations'
      } · ${total} total`;
    }
    return `${range} matching operations · ${total} total`;
  }
  return total === null ? range : `${range} of ${total} operations`;
}
