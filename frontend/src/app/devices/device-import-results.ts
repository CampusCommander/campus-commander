import {
  DEVICE_IMPORT_FAILED_OUTCOMES,
  DEVICE_IMPORT_REPORT_PAGE_SIZE,
  type DeviceImportReportLine,
  type JobExecutionCounts,
  type JobImportPlan,
  type JobOperation,
  type JobOutcome,
  type JobSummary,
} from '@campus/application-contracts';
import {
  OUTCOME_LABELS,
  outcomeNotes,
  rowFailureText,
  outcomeTone,
  type OutcomeTone,
} from '../jobs/job-detail-fields';
import {
  JOB_STATUS_LABELS,
  actionLabel,
  formatTimestamp,
  progressLines,
  statusTone,
  type JobStatusTone,
} from '../jobs/job-fields';

/**
 * The execution results of an import (design section 8, states 17 and 17b).
 *
 * The dialog reads the IMP detail for `planJobs` and `executionCounts`, one page of the report
 * route for the changes, and one operations page per job of that page. This module turns those
 * answers into the copy of the count sum, the jobs band, and the Result column. Every literal
 * comes from the approved mockup, from `job-detail-fields.ts`, or from `job-fields.ts`.
 */

/** The Not run chip of a change that Execute left out (design section 8). */
export const NOT_RUN_LABEL = 'Not run';

/** The two views of the results table (design section 8, ruling 4). */
export const RESULTS_TABS = ['proposed', 'failed'] as const;
export type ResultsView = (typeof RESULTS_TABS)[number];

/** The tab labels of the results: All changes, then Failed. */
export const RESULTS_TAB_LABELS: Readonly<Record<ResultsView, string>> =
  Object.freeze({
    proposed: 'All changes',
    failed: 'Failed',
  });

/** One count term of the sum: the outcome key and its chip tone. */
interface CountTermKey {
  readonly key: keyof JobExecutionCounts;
  readonly label: string;
  readonly tone: OutcomeTone;
}

/** The outcome terms of the count sum, in the order of design section 8. */
const COUNT_TERMS: readonly CountTermKey[] = Object.freeze([
  { key: 'succeeded', label: OUTCOME_LABELS.succeeded, tone: 'success' },
  { key: 'failed', label: OUTCOME_LABELS.failed, tone: 'error' },
  { key: 'unknown', label: OUTCOME_LABELS.unknown, tone: 'warning' },
  { key: 'skipped', label: OUTCOME_LABELS.skipped, tone: 'neutral' },
  { key: 'expired', label: OUTCOME_LABELS.expired, tone: 'warning' },
  { key: 'cancelled', label: OUTCOME_LABELS.cancelled, tone: 'neutral' },
  { key: 'pending', label: OUTCOME_LABELS.pending, tone: 'neutral' },
  { key: 'notRun', label: NOT_RUN_LABEL, tone: 'neutral' },
]);

/** One term of the count sum, as the approved mockup draws it. */
export interface ResultCountTerm {
  readonly label: string;
  readonly value: string;
  readonly tone: OutcomeTone;
}

/** The count sum: `11 changes = 10 Succeeded + 1 Failed` (states 17 and 17b). */
export function resultCountSum(counts: JobExecutionCounts): {
  readonly total: number;
  readonly terms: readonly ResultCountTerm[];
} {
  const terms = COUNT_TERMS.filter((term) => counts[term.key] > 0).map(
    (term) => ({
      label: term.label,
      value: counts[term.key].toLocaleString('en-US'),
      tone: term.tone,
    }),
  );
  const total = COUNT_TERMS.reduce(
    (sum: number, term) => sum + counts[term.key],
    0,
  );
  return { total, terms };
}

/** "changes", or "change" for a plan of one change. */
export function resultChangeUnit(total: number): string {
  return total === 1 ? 'change' : 'changes';
}

/** The pager of the results: `Rows 1–9 of 11 changes` (states 17 and 17b). */
export function resultPagerText(
  page: number,
  shown: number,
  total: number,
): string {
  const unit = resultChangeUnit(total);
  if (total === 0) return `0 ${unit}`;
  const start = page * DEVICE_IMPORT_REPORT_PAGE_SIZE + 1;
  const end = start + Math.max(0, shown - 1);
  return `Rows ${start}–${end} of ${total.toLocaleString('en-US')} ${unit}`;
}

/** A job that a person can no longer change (design section 8). */
export function isFinal(status: JobSummary['status']): boolean {
  return (
    status === 'completed' ||
    status === 'completed-with-errors' ||
    status === 'failed' ||
    status === 'needs-review' ||
    status === 'cancelled'
  );
}

/**
 * The end line of state 17b. Every job final ends the live line, and the line names the latest
 * finish of the plan. `Finished` is the label of `JOB_STATUS_LABELS`.
 */
export function resultEndLine(
  jobs: readonly JobSummary[],
  now: Date | number = new Date(),
): string | null {
  if (jobs.length === 0) return null;
  if (!jobs.every((job) => isFinal(job.status))) return null;
  const ended = jobs
    .map((job) => job.finishedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  return ended ? `Finished ${formatTimestamp(ended, new Date(now))}` : null;
}

/** The `Executed by` line of the action bar (states 17 and 17b). */
export function planExecutedLine(
  plan: JobImportPlan | null,
  now: Date | number = new Date(),
): string {
  const by = plan?.changedBy?.displayName;
  const at = plan?.changedAt
    ? formatTimestamp(plan.changedAt, new Date(now))
    : null;
  return by && at ? `Executed by ${by} · ${at}` : 'Executed';
}

/** One job of the results band. */
export interface ResultJobView {
  readonly displayId: string;
  readonly action: string;
  readonly status: string;
  readonly tone: JobStatusTone;
  /** The progress lines that carry a count, joined with ` · ` (states 17 and 17b). */
  readonly progress: string;
  /** The determinate bar of a running job, or null. */
  readonly percent: number | null;
}

/**
 * The jobs of the plan in a compact band (design section 8). The approved mockup shows the
 * counter lines only: `6 of 6 complete`, and `0 succeeded · 1 failed`. The sentences of
 * `progressLines` that carry no count stay out of the band.
 */
export function resultJobViews(
  jobs: readonly JobSummary[],
): readonly ResultJobView[] {
  return jobs.map((job) => ({
    displayId: job.displayId,
    action: actionLabel(job.action),
    status: JOB_STATUS_LABELS[job.status],
    tone: statusTone(job.status),
    progress: resultProgressText(job),
    percent: job.status === 'running' ? resultJobPercent(job) : null,
  }));
}

/** The counter lines of one job, joined with ` · `. */
export function resultProgressText(job: JobSummary): string {
  return progressLines(job)
    .filter((line) => /^[\d,]+ /.test(line))
    .join(' · ');
}

/** The share of the settled operations of one job, or null when it has no total. */
export function resultJobPercent(job: JobSummary): number | null {
  const total = job.progress.total;
  if (total === null || total <= 0) return null;
  const settled =
    job.progress.succeeded +
    job.progress.failed +
    job.progress.unknown +
    job.progress.skipped +
    job.progress.expired +
    job.progress.cancelled;
  return Math.min(100, Math.round((settled / total) * 100));
}

/** The job of the plan that ran one change. */
export function jobOfLine(
  line: DeviceImportReportLine,
  jobs: readonly JobSummary[],
): JobSummary | null {
  if (!line.jobDisplayId) return null;
  return jobs.find((job) => job.displayId === line.jobDisplayId) ?? null;
}

/** The operation of one change, from the one operations page of its job. */
export function operationOfLine(
  line: DeviceImportReportLine,
  operations: ReadonlyMap<string, JobOperation>,
): JobOperation | null {
  if (!line.jobDisplayId || line.operationNumber === null) return null;
  return operations.get(`${line.jobDisplayId}-${line.operationNumber}`) ?? null;
}

/**
 * The Result cell of one change: the outcome chip, the failure text of `rowFailureText` under
 * it, and the notes under that (design section 8). A change that Execute left out reads the
 * Not run chip with its reason. A status change of a waiting job names the job it waits for.
 */
export interface ResultCellView {
  readonly chip: { readonly label: string; readonly tone: OutcomeTone };
  readonly failure: string;
  readonly notes: readonly string[];
}

export function resultCell(
  line: DeviceImportReportLine,
  jobs: readonly JobSummary[],
  operations: ReadonlyMap<string, JobOperation>,
): ResultCellView {
  if (line.notRun)
    return {
      chip: { label: NOT_RUN_LABEL, tone: 'neutral' },
      failure: '',
      notes: [line.notRun.text],
    };
  const outcome: JobOutcome | null = line.outcome;
  if (outcome === null)
    return { chip: { label: '', tone: 'neutral' }, failure: '', notes: [] };
  const job = jobOfLine(line, jobs);
  const operation = operationOfLine(line, operations);
  const failure =
    operation && job ? (rowFailureText(job, operation) ?? '') : '';
  // A status job starts after the update job of the plan ends (design section 3).
  const waitsFor =
    outcome === 'pending' && line.change?.type === 'status'
      ? updateJobOf(jobs)?.displayId
      : null;
  return {
    chip: { label: OUTCOME_LABELS[outcome], tone: outcomeTone(outcome) },
    failure,
    notes: waitsFor
      ? [`Starts after ${waitsFor} ends`]
      : operation && job
        ? [...outcomeNotes(job, operation)]
        : [],
  };
}

/** The update job of a plan: the one job that runs before the status jobs (design section 3). */
export function updateJobOf(jobs: readonly JobSummary[]): JobSummary | null {
  return jobs.find((job) => job.action === 'update-device-annotations') ?? null;
}

/** The outcomes of the Failed tab, from the one constant of the contract (design section 8). */
export const FAILED_OUTCOMES = DEVICE_IMPORT_FAILED_OUTCOMES;
