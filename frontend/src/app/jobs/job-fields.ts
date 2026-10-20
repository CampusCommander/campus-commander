import {
  JOB_ACTION_LABELS,
  jobDisplayIdSchema,
  type JobAction,
  type JobPerson,
  type JobProgress,
  type JobScope,
  type JobStatus,
  type JobSummary,
} from '@campus/application-contracts';

/** The seven server filters of the Jobs grid (design 2.5). */
export type JobFilter =
  | { field: 'jobId'; value: string }
  | { field: 'status'; values: JobStatus[] }
  | { field: 'action'; values: JobAction[] }
  | { field: 'entityType'; values: 'device'[] }
  | { field: 'requestedBy'; id: string; displayName: string }
  | {
      field: 'createdAt' | 'finishedAt';
      from: string | null;
      to: string | null;
      /** The frame shortcut. The stored bounds are absolute. */
      preset?: 'last-7-days';
    };

export type JobFilterFieldId = JobFilter['field'];
export type JobFilterKind =
  | 'text'
  | 'status'
  | 'action'
  | 'entityType'
  | 'person'
  | 'range';

export interface JobFilterField {
  id: JobFilterFieldId;
  label: string;
  kind: JobFilterKind;
}

export const JOB_FILTER_FIELDS: readonly JobFilterField[] = [
  { id: 'jobId', label: 'Job ID', kind: 'text' },
  { id: 'status', label: 'Status', kind: 'status' },
  { id: 'action', label: 'Action', kind: 'action' },
  { id: 'entityType', label: 'Entity type', kind: 'entityType' },
  { id: 'requestedBy', label: 'Requested by', kind: 'person' },
  { id: 'createdAt', label: 'Created', kind: 'range' },
  { id: 'finishedAt', label: 'Finished', kind: 'range' },
];

export const JOB_STATUS_LABELS: Readonly<Record<JobStatus, string>> = {
  accepted: 'Accepted',
  queued: 'Queued',
  held: 'Held',
  running: 'Running',
  completed: 'Completed',
  'completed-with-errors': 'Completed with errors',
  failed: 'Failed',
  'needs-review': 'Needs review',
};

export const JOB_STATUSES: readonly JobStatus[] = Object.keys(
  JOB_STATUS_LABELS,
) as JobStatus[];

export const JOB_ACTIONS: readonly JobAction[] = [
  'update-device-annotations',
  'refresh-inventory',
];

/** One tone per status for the chip dot and label (UI-04). */
export type JobStatusTone =
  | 'neutral'
  | 'info'
  | 'warning'
  | 'error'
  | 'success';

export function statusTone(status: JobStatus): JobStatusTone {
  switch (status) {
    case 'running':
      return 'info';
    case 'held':
    case 'needs-review':
      return 'warning';
    case 'completed-with-errors':
    case 'failed':
      return 'error';
    case 'completed':
      return 'success';
    default:
      return 'neutral';
  }
}

export function actionLabel(action: JobAction): string {
  return JOB_ACTION_LABELS[action];
}

export function scopeLabel(scope: JobScope): string {
  if (scope.kind === 'all-devices' || scope.deviceCount === null)
    return 'All devices';
  const count = scope.deviceCount.toLocaleString('en-US');
  return `${count} ${scope.deviceCount === 1 ? 'device' : 'devices'}`;
}

const count = (value: number) => value.toLocaleString('en-US');

/** The counter line of a progress cell. Pending leads, then the exceptions. */
function counterLine(progress: JobProgress): string {
  return [
    progress.pending ? `${count(progress.pending)} pending` : '',
    progress.failed ? `${count(progress.failed)} failed` : '',
    progress.unknown ? `${count(progress.unknown)} unknown` : '',
    progress.skipped ? `${count(progress.skipped)} skipped` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function updateProgress(job: JobSummary): [string, string] {
  const { status, progress } = job;
  const total = progress.total ?? progress.succeeded;
  switch (status) {
    case 'accepted':
      return ['Not started', 'Accepted'];
    case 'queued':
      return [
        `${count(progress.succeeded)} of ${count(total)} complete`,
        'Waiting for dispatch',
      ];
    case 'held':
      return ['Waiting to start', 'Google backoff'];
    case 'running':
      return [
        `${count(progress.succeeded)} of ${count(total)} complete`,
        counterLine(progress) || 'In progress',
      ];
    case 'completed':
      return [
        `${count(total)} of ${count(total)} complete`,
        'All updates confirmed',
      ];
    case 'completed-with-errors':
      return [
        `${count(progress.succeeded)} succeeded`,
        counterLine(progress) || 'Completed with errors',
      ];
    case 'failed':
      return [
        `${count(progress.succeeded)} succeeded`,
        counterLine(progress) || 'Job failed',
      ];
    case 'needs-review':
      return [
        `${count(progress.succeeded)} succeeded`,
        counterLine(progress) || 'Needs review',
      ];
    default:
      return ['Not started', 'In progress'];
  }
}

/** Refresh jobs hold no operations. Their progress lines follow the frame style. */
function refreshProgress(job: JobSummary): [string, string] {
  const { status, progress } = job;
  const read = `${count(progress.succeeded)} ${progress.succeeded === 1 ? 'device' : 'devices'} read`;
  switch (status) {
    case 'accepted':
      return ['Not started', 'Accepted'];
    case 'queued':
      return ['Not started', 'Waiting for dispatch'];
    case 'held':
      return ['Waiting to start', 'Google backoff'];
    case 'running':
      return [read, 'Refresh in progress'];
    case 'completed':
      return [read, 'Refresh complete'];
    case 'completed-with-errors':
      return [read, counterLine(progress) || 'Refresh completed with errors'];
    case 'failed':
      return [read, counterLine(progress) || 'Refresh failed'];
    case 'needs-review':
      return [read, 'Refresh needs review'];
    default:
      return ['Not started', 'In progress'];
  }
}

/** The two lines of a Progress cell. The first line is the primary state. */
export function progressLines(job: JobSummary): [string, string] {
  return job.action === 'refresh-inventory'
    ? refreshProgress(job)
    : updateProgress(job);
}

/** "10:40 AM". A Recent row carries its exact timestamp on the time element. */
export function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The one line of a Waiting row. A held job never promises a start time (mockup note 5). */
export function waitingLine(job: JobSummary): string {
  const label = JOB_STATUS_LABELS[job.status];
  return job.status === 'held'
    ? `${label} · Google backoff · Starts when Google allows`
    : `${label} · Waiting for dispatch`;
}

/** The status label with its counts for a Recent row. An unknown outcome keeps its label. */
export function recentLine(job: JobSummary): string {
  const label = JOB_STATUS_LABELS[job.status];
  const [primary, exceptions] = progressLines(job);
  switch (job.status) {
    case 'completed-with-errors':
    case 'failed':
    case 'needs-review':
      return `${label} · ${primary} · ${exceptions}`;
    default:
      return `${label} · ${primary}`;
  }
}

/** The share of a job that is complete. A job without a total has no determinate bar. */
export function progressPercent(job: JobSummary): number | null {
  const { total, succeeded } = job.progress;
  if (total === null || total === 0) return null;
  return Math.min(100, Math.round((succeeded / total) * 100));
}

/** The progress and requester line of a Running row. */
export function runningLine(job: JobSummary): string {
  return `${progressLines(job)[0]} · ${job.requestedBy.displayName}`;
}

/** "Sep 5, 10:40 AM". A different year carries its year to stay unambiguous. */
export function formatTimestamp(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return date.toLocaleString('en-US', options);
}

/** A short local date and time for a filter chip. */
export function formatFilterTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function durationSeconds(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return 0;
  return Math.floor((end - start) / 1000);
}

/** "18s", "2m 08s", or "1h 04m". */
export function formatDuration(startIso: string, endIso: string): string {
  const total = durationSeconds(startIso, endIso);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** The second line of a Created cell: the job duration. */
export function durationLine(job: JobSummary, now = new Date()): string {
  if (!job.startedAt) return 'Not started';
  if (job.finishedAt) return formatDuration(job.startedAt, job.finishedAt);
  return `Elapsed ${formatDuration(job.startedAt, now.toISOString())}`;
}

export function filterField(id: JobFilterFieldId): JobFilterField {
  const field = JOB_FILTER_FIELDS.find((candidate) => candidate.id === id);
  if (!field) throw new Error(`Unknown job filter field ${id}`);
  return field;
}

/** The chip text of one applied filter. */
export function jobFilterLabel(filter: JobFilter): string {
  const label = filterField(filter.field).label;
  switch (filter.field) {
    case 'jobId':
      return `${label}: ${filter.value}`;
    case 'status':
      return `${label}: ${filter.values
        .map((value) => JOB_STATUS_LABELS[value])
        .join(', ')}`;
    case 'action':
      return `${label}: ${filter.values.map(actionLabel).join(', ')}`;
    case 'entityType':
      return `${label}: Device`;
    case 'requestedBy':
      return `${label}: ${filter.displayName}`;
    default: {
      if (filter.preset === 'last-7-days') return `${label}: Last 7 days`;
      if (filter.from && filter.to)
        return `${label}: ${formatFilterTime(filter.from)} – ${formatFilterTime(filter.to)}`;
      if (filter.from)
        return `${label}: after ${formatFilterTime(filter.from)}`;
      if (filter.to) return `${label}: before ${formatFilterTime(filter.to)}`;
      return label;
    }
  }
}

/** A job ID filter accepts the display ID shapes of this slice. */
export function validJobId(value: string): boolean {
  return jobDisplayIdSchema.safeParse(value.trim()).success;
}

/** The query string of the list route. Only the seven server filters appear. */
export function jobFilterQuery(
  filters: readonly JobFilter[],
  cursor: string | null,
): string {
  const params = new URLSearchParams();
  for (const filter of filters) {
    switch (filter.field) {
      case 'jobId':
        params.set('jobId', filter.value);
        break;
      case 'status':
        if (filter.values.length) params.set('status', filter.values.join(','));
        break;
      case 'action':
        if (filter.values.length) params.set('action', filter.values.join(','));
        break;
      case 'entityType':
        if (filter.values.length) params.set('entityType', 'device');
        break;
      case 'requestedBy':
        params.set('requestedBy', filter.id);
        break;
      case 'createdAt':
        if (filter.from) params.set('createdFrom', filter.from);
        if (filter.to) params.set('createdTo', filter.to);
        break;
      case 'finishedAt':
        if (filter.from) params.set('finishedFrom', filter.from);
        if (filter.to) params.set('finishedTo', filter.to);
        break;
    }
  }
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function sameFilters(
  left: readonly JobFilter[],
  right: readonly JobFilter[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A `datetime-local` value in the browser's time zone. */
export function dateTimeInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dateTimeInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The frame's example window, as absolute bounds. */
export function lastSevenDays(now = new Date()): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
    to: now.toISOString(),
  };
}

export function personLabel(person: JobPerson): string {
  return person.displayName;
}
