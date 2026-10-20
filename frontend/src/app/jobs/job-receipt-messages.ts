import type { JobDetail } from '@campus/application-contracts';
import { deviceCountText } from '../devices/device-update-messages';
import { JOB_STATUS_LABELS } from './job-fields';

/** "Job UPD-006 · Accepted". */
export function receiptSubtitle(job: JobDetail): string {
  return `Job ${job.displayId} · ${JOB_STATUS_LABELS[job.status]}`;
}

/**
 * "6 devices · 6 annotated-location updates. Google changes have not completed."
 * The frame names both counters, so the line keeps both.
 */
export function receiptCountLine(job: JobDetail): string {
  const devices = job.scope.deviceCount ?? job.progress.total ?? 0;
  const updates = job.progress.total ?? job.scope.deviceCount ?? 0;
  const noun =
    job.mode === 'clear'
      ? 'annotated-location removals'
      : 'annotated-location updates';
  return `${deviceCountText(devices)} · ${updates.toLocaleString(
    'en-US',
  )} ${noun}. Google changes have not completed.`;
}

/** The durable receipt copy of frame 104:74. */
export const RECEIPT_HEADING = 'Your job is saved';
export const RECEIPT_NEXT_STEP =
  'You can leave this page. Return to Jobs to review progress and individual outcomes.';
