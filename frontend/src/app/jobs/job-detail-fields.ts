import type {
  JobDetail,
  JobFailedActivityOperation,
  JobOperation,
  JobOutcome,
  JobProgress,
  JobUnknownActivityOperation,
} from '@campus/application-contracts';
import type { AuthStore } from '../auth.store';
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
};

export function outcomeTone(outcome: JobOutcome): OutcomeTone {
  switch (outcome) {
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'error';
    case 'unknown':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** One counter of the outcome row. Order follows the frame. */
export interface JobCounter {
  key: string;
  label: string;
  value: number | null;
  tone: OutcomeTone;
}

/**
 * The six counters of frame 104:209. Cancellation is outside this slice
 * (design 1.2), so the frame's Cancelled counter stays at zero.
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

/** The failed and unknown operations that the attention filter reads. */
export function attentionCount(job: JobDetail): number {
  return job.progress.failed + job.progress.unknown;
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

/** "Annotated location". The only write field of this slice. */
export function fieldLabel(field: JobDetail['field']): string {
  return field === 'annotatedLocation' ? 'Annotated location' : '—';
}

/** A before value. A null baseline reads as "Not set". */
export function beforeText(operation: JobOperation): string {
  return operation.baselineValue ?? 'Not set';
}

/** A requested value. A clear reads as "Clear value", as on the draft page. */
export function requestedText(operation: JobOperation): string {
  return operation.requestedValue ?? 'Clear value';
}

/** The time of one operation, as in the frame. The full time stays on the element. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The operation number of `operationId` (`UPD-006-12` gives `12`). */
export function operationNumber(operationId: string): string | null {
  return /^UPD-\d{3,}-(\d+)$/.exec(operationId)?.[1] ?? null;
}

/** Reconcile needs jobs:read and devices:write (design 2.1, OQ6). */
export function canReconcile(auth: InstanceType<typeof AuthStore>): boolean {
  if (auth.metadata()?.phase !== 3) return false;
  const grants = auth.session()?.identity.grants ?? [];
  return (
    grants.some((grant) => grant.action === 'jobs:read') &&
    grants.some((grant) => grant.action === 'devices:write')
  );
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

/**
 * One failure sentence of the Latest activity line (design 2.5, OQ9).
 * A 401 or 403 that is not a quota refusal reads as a permission failure.
 */
export function failureSentence(operation: JobFailedActivityOperation): string {
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
      return `Google quota stopped the update for ${serial}.`;
    case 'value-differs':
      return `${serial} does not hold the requested value.`;
    case 'invalid-response':
      return `Google returned an invalid response for ${serial}.`;
    case 'ambiguous':
      return `The outcome for ${serial} is uncertain.`;
    default:
      return operation.outcomeReason
        ? `Google rejected the update for ${serial} (${operation.outcomeReason}).`
        : `The update failed for ${serial}.`;
  }
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

/** The counter line of a write job of frame 228:4524. */
function updateCounterLine(job: JobDetail): string {
  const { succeeded, pending } = job.progress;
  const time = formatTime(job.latestActivity.at);
  const confirmed = `${succeeded.toLocaleString('en-US')} ${
    succeeded === 1 ? 'update' : 'updates'
  } confirmed.`;
  if (pending !== null && pending > 0)
    return `${time} · ${confirmed} ${spellCount(pending)} ${
      pending === 1 ? 'operation remains' : 'operations remain'
    } pending.`;
  return `${time} · ${confirmed} No operations remain pending.`;
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
  const { failed, unknown } = job.latestActivity;
  if (failed.operations.length || unknown.operations.length) {
    const sentences = [
      ...failed.operations.map(failureSentence),
      ...unknown.operations.map(reconciliationSentence),
    ];
    return `${formatTime(sampleTime(failed.operations, unknown.operations))} · ${sentences.join(' ')}`;
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
  const total = operationTotal(job).toLocaleString('en-US');
  if (!options.shown)
    return options.attention
      ? `0 matching operations · ${total} total`
      : `0 of ${total} operations`;
  const start = options.pageIndex * options.pageSize + 1;
  const end = start + options.shown - 1;
  if (options.attention) {
    // The single-page frame 231:4707 reads "2 matching operations · 6 total".
    // A later page keeps its row range, so the range never collapses to a page length.
    if (options.pageIndex === 0 && !options.hasNext) {
      const matching = attentionCount(job);
      return `${matching.toLocaleString('en-US')} matching ${
        matching === 1 ? 'operation' : 'operations'
      } · ${total} total`;
    }
    return `Rows ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')} matching operations · ${total} total`;
  }
  return `Rows ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')} of ${total} operations`;
}
