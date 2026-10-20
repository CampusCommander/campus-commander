import {
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  OnInit,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import type { JobStatus } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { devicesReadable } from '../devices/devices.store';
import { JobFilterEditor } from './job-filter';
import {
  actionLabel,
  durationLine,
  formatTimestamp,
  jobFilterLabel,
  progressLines,
  scopeLabel,
  statusTone,
  type JobFilter,
  JOB_STATUS_LABELS,
} from './job-fields';
import { JOBS_PAGE_SIZE, JobsStore } from './jobs.store';

@Component({
  selector: 'app-jobs',
  imports: [RouterLink, MatButtonModule, MatIconModule, JobFilterEditor],
  templateUrl: './jobs.html',
  styleUrl: './jobs.css',
})
export class JobsPage implements OnInit, OnDestroy {
  protected readonly store = inject(JobsStore);
  private readonly auth = inject(AuthStore);
  private readonly injector = inject(Injector);
  private readonly chips = viewChildren<ElementRef<HTMLButtonElement>>('chip');
  protected readonly filters = this.store.filters;
  protected readonly editingIndex = signal<number | null>(null);
  protected readonly editing = computed(() => {
    const index = this.editingIndex();
    return index === null ? null : (this.filters()[index] ?? null);
  });
  protected readonly rows = computed(() => this.store.page()?.jobs ?? []);
  protected readonly canOpenDevices = computed(() =>
    devicesReadable(this.auth),
  );
  protected readonly noJobs = computed(
    () =>
      this.store.loaded() &&
      (this.store.page()?.matching ?? 0) === 0 &&
      this.filters().length === 0,
  );
  protected readonly noMatches = computed(
    () =>
      this.store.loaded() &&
      (this.store.page()?.matching ?? 0) === 0 &&
      this.filters().length > 0,
  );
  /** Loading, no jobs, no matches, unavailable, stale, and offline (jobs-grid.json). */
  protected readonly footerCount = computed(() => {
    const page = this.store.page();
    if (this.store.loading() && !page) return 'Loading job count';
    const matching = page?.matching ?? 0;
    const filtered = this.filters().length > 0;
    const count = `${matching.toLocaleString('en-US')} ${
      filtered
        ? `matching ${matching === 1 ? 'job' : 'jobs'}`
        : matching === 1
          ? 'job'
          : 'jobs'
    }`;
    if (!page?.observedAt) return count;
    const time = formatTimestamp(page.observedAt);
    return this.store.offline()
      ? `${count} · Last received ${time}`
      : `${count} · Updated ${time}`;
  });
  protected readonly footerRows = computed(() => {
    const page = this.store.page();
    if (!page) return '—';
    if (page.jobs.length === 0) return '0 rows';
    const start = this.store.shownIndex() * JOBS_PAGE_SIZE + 1;
    const end = start + page.jobs.length - 1;
    return `Rows ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')} of ${page.matching.toLocaleString('en-US')}`;
  });
  protected readonly statusLabel = (status: JobStatus) =>
    JOB_STATUS_LABELS[status];
  protected readonly statusTone = statusTone;
  protected readonly actionLabel = actionLabel;
  protected readonly scopeLabel = scopeLabel;
  protected readonly progressLines = progressLines;
  protected readonly formatTimestamp = formatTimestamp;
  protected readonly durationLine = durationLine;
  protected readonly filterLabel = jobFilterLabel;
  protected readonly loadRequesters = (query: string) =>
    this.store.requesters(query);

  ngOnInit(): void {
    void this.store.init();
  }

  ngOnDestroy(): void {
    this.store.leave();
  }

  protected refresh(): void {
    void this.store.refresh();
  }

  protected previous(): void {
    this.store.previous();
  }

  protected next(): void {
    this.store.next();
  }

  /** One filter per field. A chip for a filtered field replaces that filter. */
  protected apply(filter: JobFilter): void {
    const index = this.editingIndex();
    const current = this.filters();
    const at =
      index !== null && index < current.length
        ? index
        : current.findIndex((item) => item.field === filter.field);
    // The editor emits closed next. editorClosed() clears the index and restores focus.
    this.store.setFilters(
      at === -1
        ? [...current, filter]
        : current.map((item, position) => (position === at ? filter : item)),
    );
  }

  protected remove(index: number): void {
    this.editingIndex.set(null);
    this.store.setFilters(
      this.filters().filter((_, position) => position !== index),
    );
  }

  protected clear(): void {
    this.editingIndex.set(null);
    this.store.clearFilters();
  }

  /** After a chip edit closes, focus returns to that chip (GRID-04). */
  protected editorClosed(): void {
    const index = this.editingIndex();
    this.editingIndex.set(null);
    if (index === null) return;
    afterNextRender(() => this.chips()[index]?.nativeElement.focus(), {
      injector: this.injector,
    });
  }
}
