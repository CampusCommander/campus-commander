import { Component, computed, input, output, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import type { JobList, JobSummary } from '@campus/application-contracts';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { JobFilterEditor } from './job-filter';
import { JobsPage } from './jobs';
import { JobsStore } from './jobs.store';
import type { JobFilter } from './job-fields';

@Component({
  selector: 'app-job-filter',
  template: '<p class="filter-stub"></p>',
})
class FilterStub {
  readonly editing = input<JobFilter | null>(null);
  readonly requesters = input<unknown>();
  readonly applied = output<JobFilter>();
  readonly closed = output<void>();
}

const job = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'UPD-014',
  revision: 1,
  action: 'update-device-annotations',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 48 },
  requestedBy: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: 'Maya Chen',
  },
  createdAt: '2026-10-19T12:00:00.000Z',
  startedAt: '2026-10-19T12:00:00.000Z',
  finishedAt: null,
  progress: {
    total: 48,
    succeeded: 36,
    failed: 0,
    unknown: 0,
    skipped: 0,
    pending: 12,
  },
  failure: null,
  ...overrides,
});

const page = (
  jobs: JobSummary[],
  nextCursor: string | null = null,
  matching = jobs.length,
): JobList => ({
  jobs,
  matching,
  nextCursor,
  observedAt: '2026-10-19T12:01:00.000Z',
});

function setup(options: {
  page?: JobList | null;
  filters?: JobFilter[];
  loading?: boolean;
  loaded?: boolean;
  reading?: boolean;
  offline?: boolean;
  stale?: boolean;
  error?: string;
  hasPrevious?: boolean;
  shownIndex?: number;
  grants?: { action: string }[];
}) {
  const pageSignal = signal<JobList | null>(options.page ?? null);
  const filters = signal<JobFilter[]>(options.filters ?? []);
  const store = {
    filters,
    page: pageSignal,
    loading: signal(options.loading ?? false),
    loaded: signal(options.loaded ?? true),
    reading: signal(options.reading ?? false),
    refreshing: signal(false),
    offline: signal(options.offline ?? false),
    stale: signal(options.stale ?? false),
    error: signal(options.error ?? ''),
    pageIndex: signal(0),
    shownIndex: signal(options.shownIndex ?? 0),
    hasPrevious: computed(() => options.hasPrevious ?? false),
    hasNext: computed(() => !!pageSignal()?.nextCursor),
    init: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    setFilters: vi.fn((next: JobFilter[]) => filters.set(next)),
    clearFilters: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    requesters: vi.fn().mockResolvedValue([]),
  };
  const grants =
    options.grants ??
    ([{ action: 'jobs:read' }, { action: 'devices:read' }] as {
      action: string;
    }[]);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: JobsStore, useValue: store },
      {
        provide: AuthStore,
        useValue: {
          metadata: signal({ phase: 3 }),
          session: signal({
            identity: {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              grants,
            },
          }),
        },
      },
    ],
  });
  TestBed.overrideComponent(JobsPage, {
    remove: { imports: [JobFilterEditor] },
    add: { imports: [FilterStub] },
  });
  const fixture = TestBed.createComponent(JobsPage);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
  const headers = () =>
    [...element.querySelectorAll('th')].map((header) =>
      header.textContent?.trim(),
    );
  const link = (name: string) =>
    [...element.querySelectorAll('a')].find(
      (candidate) => candidate.getAttribute('aria-label') === name,
    );
  const label = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === name,
    );
  return { store, element, button, headers, link, label, fixture };
}

it('shows the eight fields in the six-column frame composition', () => {
  const { element, headers, link } = setup({
    page: page([
      job(),
      job({
        jobId: '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
        displayId: 'REF-004',
        action: 'refresh-inventory',
        status: 'completed',
        scope: { kind: 'devices', deviceCount: 128 },
        progress: {
          total: null,
          succeeded: 128,
          failed: 0,
          unknown: 0,
          skipped: 0,
          pending: null,
        },
        startedAt: '2026-10-19T12:00:00.000Z',
        finishedAt: '2026-10-19T12:00:42.000Z',
      }),
    ]),
  });
  expect(headers()).toEqual([
    'Job',
    'Status',
    'Progress',
    'Scope',
    'Requested by',
    'Created',
  ]);
  const rows = [...element.querySelectorAll('tbody tr')];
  expect(rows).toHaveLength(2);
  const first = rows[0].textContent ?? '';
  expect(first).toContain('UPD-014');
  expect(first).toContain('Update device annotations');
  expect(first).toContain('Running');
  expect(first).toContain('36 of 48 complete');
  expect(first).toContain('12 pending');
  expect(first).toContain('48 devices');
  expect(first).toContain('Maya Chen');
  expect(first).toContain('Elapsed ');
  const second = rows[1].textContent ?? '';
  expect(second).toContain('REF-004');
  expect(second).toContain('Refresh inventory');
  expect(second).toContain('128 devices read');
  expect(second).toContain('Refresh complete');
  expect(second).toContain('42s');
  const details = link('Open details for job UPD-014');
  expect(details?.getAttribute('href')).toBe('/jobs/UPD-014');
});

it('shows the count, read time, and row range in the footer', () => {
  const { element } = setup({
    page: page([job(), job({ displayId: 'REF-004' })]),
  });
  const footer = element.querySelector('.grid-footer')?.textContent ?? '';
  expect(footer).toContain('2 jobs');
  expect(footer).toContain('Updated');
  expect(footer).toContain('Rows 1–2 of 2');
  expect(element.querySelector('[aria-label="Previous page"]')).toHaveProperty(
    'disabled',
    true,
  );
  expect(element.querySelector('[aria-label="Next page"]')).toHaveProperty(
    'disabled',
    true,
  );
});

it('keeps the shown page range and blocks paging during a read', () => {
  const { element } = setup({
    page: page([job()], 'cursor-3', 51),
    shownIndex: 1,
    hasPrevious: true,
    reading: true,
  });
  const footer = element.querySelector('.grid-footer')?.textContent ?? '';
  expect(footer).toContain('Rows 51–51 of 51');
  expect(footer).toContain('51 jobs');
  expect(element.querySelector('[aria-label="Previous page"]')).toHaveProperty(
    'disabled',
    true,
  );
  expect(element.querySelector('[aria-label="Next page"]')).toHaveProperty(
    'disabled',
    true,
  );
});

it('uses the API cursor for Previous and Next', () => {
  const { store, element } = setup({
    page: page([job()], 'cursor-2'),
    hasPrevious: true,
  });
  (
    element.querySelector('[aria-label="Next page"]') as HTMLButtonElement
  ).click();
  expect(store.next).toHaveBeenCalled();
  (
    element.querySelector('[aria-label="Previous page"]') as HTMLButtonElement
  ).click();
  expect(store.previous).toHaveBeenCalled();
});

it('shows the loading state', () => {
  const { element } = setup({ page: null, loading: true, loaded: false });
  expect(element.textContent).toContain('Loading jobs');
  expect(element.textContent).toContain(
    'Retrieving job status and operation counts.',
  );
  expect(element.textContent).toContain('Loading job count');
  expect(element.textContent).toContain('—');
});

it('shows no jobs with Open Devices', () => {
  const { element } = setup({ page: page([]) });
  expect(element.textContent).toContain('No jobs yet');
  expect(element.textContent).toContain(
    'Submitted updates, commands, imports, and exports will appear here.',
  );
  expect(
    [...element.querySelectorAll('a')]
      .find((candidate) => candidate.textContent?.trim() === 'Open Devices')
      ?.getAttribute('href'),
  ).toBe('/devices');
  expect(element.textContent).toContain('0 jobs');
  expect(element.textContent).toContain('0 rows');
});

it('does not offer Open Devices without devices:read', () => {
  const { element } = setup({
    page: page([]),
    grants: [{ action: 'jobs:read' }],
  });
  expect(element.textContent).toContain('No jobs yet');
  expect(element.textContent).not.toContain('Open Devices');
});

it('shows no matches with Clear filters', () => {
  const { store, element, button } = setup({
    page: page([]),
    filters: [{ field: 'jobId', value: 'UPD-999' }],
  });
  expect(element.textContent).toContain('No jobs match these filters');
  expect(element.textContent).toContain(
    'Change or clear the filters to view jobs.',
  );
  button('Clear filters')?.click();
  expect(store.clearFilters).toHaveBeenCalled();
});

it('shows the offline state with the last received rows and a disabled Refresh', () => {
  const { element, button } = setup({ page: page([job()]), offline: true });
  expect(element.textContent).toContain(
    'Offline · Showing the last received job state',
  );
  expect(element.textContent).toContain(
    'Reconnect to receive current outcomes. Existing jobs continue on the server.',
  );
  expect(element.textContent).toContain('Last received');
  expect(element.textContent).toContain('UPD-014');
  expect(button('Refresh')).toHaveProperty('disabled', true);
});

it('shows the stale state and rereads with Refresh', () => {
  const { store, element, button } = setup({
    page: page([job()]),
    stale: true,
  });
  expect(element.textContent).toContain('Job state is stale');
  expect(element.textContent).toContain(
    'Showing the last received job state. Current data stays visible during refresh.',
  );
  expect(element.textContent).toContain('UPD-014');
  button('Refresh')?.click();
  expect(store.refresh).toHaveBeenCalled();
});

it('shows the unavailable state', () => {
  const { element } = setup({
    page: null,
    loaded: false,
    error: 'Job status is unavailable.',
  });
  const alert = element.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('Job status is unavailable.');
});

it('renders filter chips, removes one, and opens its editor', () => {
  const filters: JobFilter[] = [
    { field: 'status', values: ['needs-review', 'completed-with-errors'] },
    { field: 'jobId', value: 'UPD-006' },
  ];
  const { store, button, label, fixture } = setup({
    page: page([job()]),
    filters,
  });
  expect(button('Status: Needs review, Completed with errors')).toBeDefined();
  label('Remove filter Job ID: UPD-006')?.click();
  fixture.detectChanges();
  expect(store.setFilters).toHaveBeenCalledWith([filters[0]]);
  button('Status: Needs review, Completed with errors')?.click();
  fixture.detectChanges();
  const editor = fixture.debugElement.query(By.directive(FilterStub))
    .componentInstance as FilterStub;
  expect(editor.editing()).toEqual(filters[0]);
});

it('replaces the filter of a field that already has one', () => {
  const filters: JobFilter[] = [{ field: 'status', values: ['held'] }];
  const { store, fixture } = setup({ page: page([job()]), filters });
  const editor = fixture.debugElement.query(By.directive(FilterStub))
    .componentInstance as FilterStub;
  editor.applied.emit({ field: 'status', values: ['running'] });
  expect(store.setFilters).toHaveBeenCalledWith([
    { field: 'status', values: ['running'] },
  ]);
});

it('opens the stream on mount and closes it on leave', () => {
  const { store, fixture } = setup({ page: page([job()]) });
  expect(store.init).toHaveBeenCalled();
  fixture.destroy();
  expect(store.leave).toHaveBeenCalled();
});
