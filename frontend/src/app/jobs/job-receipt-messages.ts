import type { JobDetail } from '@campus/application-contracts';
import { deviceCountText } from '../devices/device-update-messages';
import { JOB_STATUS_LABELS } from './job-fields';

/** "Job UPD-006 · Accepted". */
export function receiptSubtitle(job: JobDetail): string {
  return `Job ${job.displayId} · ${JOB_STATUS_LABELS[job.status]}`;
}

/**
 * "5 devices · 15 field changes. Google changes have not completed."
 * The frame names both counters, so the line keeps both. A reload can return a finished
 * job, so the last sentence follows the returned status. A replayed receipt has no frozen
 * preview, so its line names the device count only.
 */
export function receiptCountLine(
  job: JobDetail,
  fieldChanges: number | null,
): string {
  const devices = job.scope.deviceCount ?? job.progress.total ?? 0;
  const completion = receiptCompletionSentence(job);
  if (fieldChanges === null)
    return `${deviceCountText(devices)}. ${completion}`;
  const rows = fieldChanges.toLocaleString('en-US');
  return `${deviceCountText(devices)} · ${rows} ${
    fieldChanges === 1 ? 'field change' : 'field changes'
  }. ${completion}`;
}

/** The completion sentence of the status that the job read returned. */
export function receiptCompletionSentence(job: JobDetail): string {
  switch (job.status) {
    case 'completed':
      return 'All Google changes completed.';
    case 'completed-with-errors':
      return 'Some Google changes did not complete.';
    case 'needs-review':
      return 'Some Google changes need review.';
    case 'failed':
      return 'Google changes did not complete.';
    default:
      return 'Google changes have not completed.';
  }
}

/** The durable receipt copy of frame 104:74, revised for the bulk action sheet. */
export const RECEIPT_HEADING = 'Your job is saved';
export const RECEIPT_NEXT_STEP =
  'You can close this panel and follow progress in Jobs.';
