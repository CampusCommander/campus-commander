import { Component, computed, input } from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';

export type JobStatusValue =
  | 'accepted'
  | 'queued'
  | 'running'
  | 'completed'
  | 'completed-with-errors'
  | 'failed'
  | 'cancelled';

interface OutcomeCount {
  label: string;
  count: number;
}

const STATUS_LABELS: Record<JobStatusValue, string> = {
  accepted: 'Accepted',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  'completed-with-errors': 'Completed with errors',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

@Component({
  selector: 'app-job-status',
  imports: [MatProgressBarModule],
  templateUrl: './job-status.html',
  styleUrl: './job-status.css',
})
export class JobStatus {
  readonly status = input.required<JobStatusValue>();
  readonly succeeded = input<number | null>(null);
  readonly failed = input<number | null>(null);
  readonly unknown = input<number | null>(null);
  readonly pending = input<number | null>(null);
  readonly skipped = input<number | null>(null);
  readonly cancelled = input<number | null>(null);
  readonly total = input<number | null>(null);
  protected readonly label = computed(() => STATUS_LABELS[this.status()]);
  protected readonly statusClass = computed(() => {
    switch (this.status()) {
      case 'completed':
        return 'job-status-success';
      case 'completed-with-errors':
        return 'job-status-warning';
      case 'failed':
        return 'job-status-error';
      default:
        return '';
    }
  });
  protected readonly outcomes = computed<OutcomeCount[]>(() => {
    const entries: OutcomeCount[] = [];
    const add = (label: string, count: number | null) => {
      if (count !== null) entries.push({ label, count });
    };
    add('succeeded', this.succeeded());
    add('failed', this.failed());
    add('unknown', this.unknown());
    add('pending', this.pending());
    add('skipped', this.skipped());
    add('cancelled', this.cancelled());
    return entries;
  });
  protected readonly showProgress = computed(
    () =>
      this.status() === 'accepted' ||
      this.status() === 'queued' ||
      this.status() === 'running',
  );
  protected readonly progress = computed<number | null>(() => {
    const total = this.total();
    if (!total || total <= 0) return null;
    const finished =
      (this.succeeded() ?? 0) +
      (this.failed() ?? 0) +
      (this.unknown() ?? 0) +
      (this.skipped() ?? 0) +
      (this.cancelled() ?? 0);
    return Math.min(100, Math.round((finished / total) * 100));
  });
}
