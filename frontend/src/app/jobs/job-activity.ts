import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import type { JobStatus, JobSummary } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import {
  actionLabel,
  formatClockTime,
  formatDuration,
  formatTimestamp,
  progressPercent,
  recentLine,
  runningLine,
  scopeLabel,
  statusTone,
  waitingLine,
} from './job-fields';
import { JobActivityStore } from './job-activity.store';
import { jobsReadable } from './jobs.store';

/**
 * The Activity button of the shell header and its panel (card F5).
 * The panel is a non-modal dialog: the trigger opens and closes it, and Escape closes it
 * and returns focus to the trigger.
 */
@Component({
  selector: 'app-job-activity',
  imports: [RouterLink, MatButtonModule, MatIconModule],
  templateUrl: './job-activity.html',
  styleUrl: './job-activity.css',
  host: {
    '(document:keydown.escape)': 'close()',
    '(document:click)': 'onDocumentClick($event)',
  },
})
export class JobActivity {
  protected readonly store = inject(JobActivityStore);
  private readonly auth = inject(AuthStore);
  private readonly element = inject(ElementRef<HTMLElement>);
  private readonly injector = inject(Injector);
  private readonly trigger = viewChild('trigger', { read: ElementRef });
  private readonly panel = viewChild('panel', { read: ElementRef });
  protected readonly open = signal(false);
  protected readonly readable = computed(() => jobsReadable(this.auth));

  /** The accessible name states the running count and the attention state. */
  protected readonly buttonLabel = computed(() => {
    const summary = this.store.summary();
    if (!summary) {
      return this.store.error()
        ? 'Activity: unavailable'
        : 'Activity: loading job activity';
    }
    const count = summary.running.count;
    const running =
      count === 0
        ? 'no jobs running'
        : count === 1
          ? '1 job running'
          : `${count.toLocaleString('en-US')} jobs running`;
    return summary.attention
      ? `Activity: ${running}, needs attention`
      : `Activity: ${running}`;
  });

  protected readonly statusTone = statusTone;
  protected readonly actionLabel = actionLabel;
  protected readonly scopeLabel = scopeLabel;
  protected readonly runningLine = runningLine;
  protected readonly waitingLine = waitingLine;
  protected readonly recentLine = recentLine;
  protected readonly progressPercent = progressPercent;
  protected readonly formatTimestamp = formatTimestamp;
  protected readonly clockTime = formatClockTime;

  protected count(value: number): string {
    return value.toLocaleString('en-US');
  }

  /** The time since `startedAt` (mockup note 1). */
  protected elapsed(job: JobSummary): string {
    return job.startedAt
      ? formatDuration(job.startedAt, new Date().toISOString())
      : '';
  }

  /** One icon per status tone. An unknown outcome never reads as success (mockup note 5). */
  protected recentIcon(status: JobStatus): string {
    switch (statusTone(status)) {
      case 'success':
        return 'check_circle';
      case 'warning':
        return 'warning';
      case 'error':
        return 'error';
      default:
        return 'info';
    }
  }

  protected toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    this.open.set(true);
    // Each opening marks the activity seen (design 3.4).
    void this.store.seen();
    afterNextRender(() => this.panel()?.nativeElement?.focus(), {
      injector: this.injector,
    });
  }

  protected close(returnFocus = true): void {
    if (!this.open()) return;
    this.open.set(false);
    if (returnFocus) this.trigger()?.nativeElement?.focus();
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (!this.open()) return;
    if (!this.element.nativeElement.contains(event.target as Node))
      this.close(false);
  }
}
