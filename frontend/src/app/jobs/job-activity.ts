import {
  Component,
  DestroyRef,
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
  private readonly destroyRef = inject(DestroyRef);
  private readonly trigger = viewChild('trigger', { read: ElementRef });
  private readonly panel = viewChild('panel', { read: ElementRef });
  protected readonly open = signal(false);
  protected readonly readable = computed(() => jobsReadable(this.auth));
  /** The space between the panel and the viewport edge. It matches `--cc-space-sm`. */
  private static readonly PANEL_MARGIN = 8;
  /** Re-places the open panel when the viewport changes size. */
  private readonly placeOnResize = () => this.place();

  constructor() {
    this.destroyRef.onDestroy(() =>
      window.removeEventListener('resize', this.placeOnResize),
    );
  }

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
  /**
   * An export or import row returns to its dialog on the Devices page (design section 9, built
   * behavior 5). Only the requester's own row does. Another kind of row, or another person's
   * row, keeps the job page.
   */
  protected readonly rowLink = (job: JobSummary): string[] =>
    this.opensDialog(job) ? ['/devices'] : ['/jobs', job.displayId];
  protected readonly rowQuery = (
    job: JobSummary,
  ): Record<string, string> | undefined =>
    this.opensDialog(job) ? { job: job.displayId } : undefined;
  private opensDialog(job: JobSummary): boolean {
    return rowOpensDialog(job, this.auth.session()?.identity.id ?? null);
  }
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
    window.addEventListener('resize', this.placeOnResize);
    afterNextRender(
      () => {
        this.place();
        this.panel()?.nativeElement?.focus();
      },
      { injector: this.injector },
    );
  }

  protected close(returnFocus = true): void {
    if (!this.open()) return;
    this.open.set(false);
    window.removeEventListener('resize', this.placeOnResize);
    if (returnFocus) this.trigger()?.nativeElement?.focus();
  }

  /**
   * Keeps the panel inside the viewport. The panel is anchored to the button, and a
   * narrow header leaves less horizontal room to the left than the panel width. A
   * negative right offset moves the panel left just enough to keep both edges onscreen.
   * The bottom-sheet rule overrides this offset below the breakpoint.
   */
  private place(): void {
    const panel = this.panel()?.nativeElement as HTMLElement | undefined;
    const trigger = this.trigger()?.nativeElement as HTMLElement | undefined;
    if (!panel || !trigger) return;
    const width = panel.getBoundingClientRect().width;
    const available = trigger.getBoundingClientRect().right;
    const shift = Math.max(
      0,
      Math.ceil(JobActivity.PANEL_MARGIN - (available - width)),
    );
    panel.style.setProperty('--shift', `${-shift}px`);
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (!this.open()) return;
    if (!this.element.nativeElement.contains(event.target as Node))
      this.close(false);
  }
}

/** The two job kinds whose row opens the Devices dialog (design section 9, behavior 5). */
function rowOpensDialog(job: JobSummary, viewerId: string | null): boolean {
  if (viewerId === null || job.requestedBy.id !== viewerId) return false;
  return (
    job.action === 'export-devices' || job.action === 'validate-device-import'
  );
}
