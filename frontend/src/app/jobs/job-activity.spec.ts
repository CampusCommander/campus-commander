import { Component, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { JobActivity, JobSummary } from '@campus/application-contracts';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { JobActivity as JobActivityPanel } from './job-activity';
import { JobActivityStore } from './job-activity.store';

const maya = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const customerId = 'C0123456';

@Component({ selector: 'app-test-route', template: '' })
class TestRoute {}

const job = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'UPD-014',
  revision: 1,
  action: 'update-device-annotations',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 48 },
  requestedBy: { id: maya, displayName: 'Maya Chen' },
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

const activity = (overrides: Partial<JobActivity> = {}): JobActivity => ({
  running: { count: 0, jobs: [] },
  waiting: { count: 0, jobs: [] },
  recent: { count: 0, jobs: [], nextExpiryAt: null },
  attention: false,
  seenAt: null,
  observedAt: '2026-10-19T12:00:00.000Z',
  ...overrides,
});

interface Options {
  grants?: string[];
  summary?: JobActivity | null;
  live?: boolean;
  error?: string;
}

function configure(options: Options = {}) {
  const summary = signal<JobActivity | null>(options.summary ?? null);
  const grants = options.grants ?? ['jobs:read'];
  const store = {
    summary,
    loading: computed(() => summary() === null && !options.error),
    loaded: computed(() => summary() !== null),
    error: signal(options.error ?? ''),
    live: signal(options.live ?? false),
    runningCount: computed(() => summary()?.running.count ?? 0),
    attention: computed(() => summary()?.attention ?? false),
    seen: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({
    imports: [JobActivityPanel],
    providers: [
      provideRouter([{ path: '**', component: TestRoute }]),
      {
        provide: AuthStore,
        useValue: {
          session: signal({
            identity: {
              id: maya,
              displayName: 'Maya Chen',
              permissionVersion: 1,
              permissions: [],
              grants: grants.map((action) => ({
                action,
                scope: { kind: 'district', customerId },
              })),
              preferences: { theme: 'light', navigationCollapsed: false },
            },
            csrfToken: 'a'.repeat(64),
            expiresAt: '2026-10-20T12:00:00.000Z',
          }),
          metadata: signal({ phase: 3 }),
        },
      },
      { provide: JobActivityStore, useValue: store },
    ],
  });
  return { store, summary };
}

async function render() {
  const fixture = TestBed.createComponent(JobActivityPanel);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

type Fixture = Awaited<ReturnType<typeof render>>;

const button = (fixture: Fixture) =>
  (fixture.nativeElement as HTMLElement).querySelector(
    'button[aria-haspopup="dialog"]',
  ) as HTMLButtonElement | null;

const dialog = (fixture: Fixture) =>
  (fixture.nativeElement as HTMLElement).querySelector('[role="dialog"]');

async function open(fixture: Fixture) {
  button(fixture)?.click();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

it('shows no button without jobs:read or devices:read', async () => {
  configure({ grants: ['schools:read'] });
  const fixture = await render();
  expect(button(fixture)).toBeNull();
});

it('shows the bell alone when no job runs', async () => {
  configure({ summary: activity() });
  const fixture = await render();
  expect(button(fixture)?.getAttribute('aria-label')).toBe(
    'Activity: no jobs running',
  );
  expect(
    (fixture.nativeElement as HTMLElement).querySelector('.ring'),
  ).toBeNull();
  expect(
    (fixture.nativeElement as HTMLElement).querySelector('.badge'),
  ).toBeNull();
  expect(
    (fixture.nativeElement as HTMLElement).querySelector('.attention-dot'),
  ).toBeNull();
});

it('shows the ring and the running count from running.count', async () => {
  configure({
    summary: activity({ running: { count: 2, jobs: [job()] } }),
  });
  const fixture = await render();
  expect(button(fixture)?.getAttribute('aria-label')).toBe(
    'Activity: 2 jobs running',
  );
  expect(
    (fixture.nativeElement as HTMLElement).querySelector('.ring'),
  ).not.toBeNull();
  expect(
    (fixture.nativeElement as HTMLElement).querySelector('.badge')?.textContent,
  ).toBe('2');
});

it('shows the amber dot when activity needs attention', async () => {
  configure({
    summary: activity({
      recent: {
        count: 1,
        jobs: [job({ displayId: 'UPD-006', status: 'failed' })],
        nextExpiryAt: null,
      },
      attention: true,
    }),
  });
  const fixture = await render();
  expect(button(fixture)?.getAttribute('aria-label')).toBe(
    'Activity: no jobs running, needs attention',
  );
  expect(
    (fixture.nativeElement as HTMLElement).querySelector('.attention-dot'),
  ).not.toBeNull();
});

it('shows the ring, the badge, and the dot together', async () => {
  configure({
    summary: activity({
      running: { count: 1, jobs: [job()] },
      attention: true,
    }),
  });
  const fixture = await render();
  expect(button(fixture)?.getAttribute('aria-label')).toBe(
    'Activity: 1 job running, needs attention',
  );
  const element = fixture.nativeElement as HTMLElement;
  expect(element.querySelector('.ring')).not.toBeNull();
  expect(element.querySelector('.badge')?.textContent).toBe('1');
  expect(element.querySelector('.attention-dot')).not.toBeNull();
});

it('opens the dialog, marks the activity seen, and lists the sections', async () => {
  const { store } = configure({
    live: true,
    summary: activity({
      running: { count: 2, jobs: [job()] },
      waiting: {
        count: 1,
        jobs: [
          job({
            jobId: '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
            displayId: 'UPD-013',
            status: 'held',
            scope: { kind: 'devices', deviceCount: 24 },
            startedAt: null,
            progress: {
              total: 24,
              succeeded: 0,
              failed: 0,
              unknown: 0,
              skipped: 0,
              pending: 24,
            },
          }),
        ],
      },
      recent: {
        count: 1,
        jobs: [
          job({
            jobId: '2f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
            displayId: 'UPD-003',
            status: 'completed-with-errors',
            finishedAt: '2026-10-19T11:58:00.000Z',
            startedAt: '2026-10-19T11:50:00.000Z',
            progress: {
              total: 6,
              succeeded: 5,
              failed: 1,
              unknown: 0,
              skipped: 0,
              pending: 0,
            },
          }),
        ],
        nextExpiryAt: null,
      },
    }),
  });
  const fixture = await render();
  await open(fixture);

  const panel = dialog(fixture);
  expect(panel?.getAttribute('aria-labelledby')).toBe('activity-title');
  expect(panel?.textContent).toContain('District activity');
  expect(panel?.textContent).toContain('Running · 2');
  expect(panel?.textContent).toContain('Waiting · 1');
  expect(panel?.textContent).toContain('Recent · 1 · last 24 hours');
  expect(panel?.textContent).toContain('UPD-014 · Update device annotations');
  expect(panel?.textContent).toContain('36 of 48 complete · Maya Chen');
  expect(panel?.textContent).toContain(
    'Held · Google backoff · Starts when Google allows',
  );
  expect(panel?.textContent).toContain(
    'Completed with errors · 5 succeeded · 1 failed',
  );
  expect(panel?.textContent).not.toContain('Starts at');
  expect(panel?.querySelector('.bar.indeterminate')).toBeNull();
  expect(panel?.textContent).toContain('Updated live');
  expect(store.seen).toHaveBeenCalledTimes(1);
  expect(panel).toBe(document.activeElement);
});

it('opens the running job and the Jobs page from the panel', async () => {
  configure({ summary: activity({ running: { count: 1, jobs: [job()] } }) });
  const fixture = await render();
  await open(fixture);

  const row = dialog(fixture)?.querySelector('a.row');
  expect(row?.getAttribute('href')).toBe('/jobs/UPD-014');
  expect(
    dialog(fixture)?.querySelector('.panel-foot a')?.getAttribute('href'),
  ).toBe('/jobs');
  expect(dialog(fixture)?.querySelector('a[href="/account"]')).toBeNull();
});

it('shows the read count and an indeterminate bar for a job without a total', async () => {
  configure({
    summary: activity({
      running: {
        count: 1,
        jobs: [
          job({
            action: 'refresh-inventory',
            displayId: 'REF-031',
            progress: {
              total: null,
              succeeded: 3200,
              failed: 0,
              unknown: 0,
              skipped: 0,
              pending: null,
            },
          }),
        ],
      },
    }),
  });
  const fixture = await render();
  await open(fixture);
  expect(dialog(fixture)?.textContent).toContain('3,200 devices read');
  expect(dialog(fixture)?.querySelector('.bar.indeterminate')).not.toBeNull();
});

it('shows one sentence when all three sections are empty', async () => {
  configure({ summary: activity() });
  const fixture = await render();
  await open(fixture);
  expect(dialog(fixture)?.textContent).toContain(
    'No jobs are running or waiting. No job finished in the last 24 hours.',
  );
  expect(dialog(fixture)?.querySelector('.section')).toBeNull();
});

it('shows the paused sentence when the stream is closed', async () => {
  configure({ summary: activity(), live: false });
  const fixture = await render();
  await open(fixture);
  expect(dialog(fixture)?.textContent).toContain(
    'Updates pause while the connection is down',
  );
  expect(dialog(fixture)?.textContent).not.toContain('Updated live');
});

it('shows the section counts with capped rows and keeps View all jobs', async () => {
  const running = Array.from({ length: 50 }, (_, index) =>
    job({
      jobId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      displayId: `UPD-${String(100 + index)}`,
    }),
  );
  configure({
    summary: activity({ running: { count: 60, jobs: running } }),
  });
  const fixture = await render();
  await open(fixture);
  expect(dialog(fixture)?.textContent).toContain('Running · 60');
  expect(dialog(fixture)?.querySelectorAll('a.row')).toHaveLength(50);
  expect(dialog(fixture)?.textContent).toContain('View all jobs');
});

it('closes on Escape and returns focus to the button', async () => {
  configure({ summary: activity() });
  const fixture = await render();
  await open(fixture);
  expect(dialog(fixture)).not.toBeNull();

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  fixture.detectChanges();
  expect(dialog(fixture)).toBeNull();
  expect(document.activeElement).toBe(button(fixture));
});

it('toggles closed with the button', async () => {
  configure({ summary: activity() });
  const fixture = await render();
  await open(fixture);
  button(fixture)?.click();
  fixture.detectChanges();
  expect(dialog(fixture)).toBeNull();
});

it('closes on an outside click without returning focus', async () => {
  configure({ summary: activity() });
  const fixture = await render();
  await open(fixture);
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  outside.click();
  fixture.detectChanges();
  expect(dialog(fixture)).toBeNull();
  expect(document.activeElement).toBe(outside);
  outside.remove();
});

it('shows the loading sentence until the first read answers', async () => {
  configure();
  const fixture = await render();
  await open(fixture);
  expect(dialog(fixture)?.textContent).toContain('Loading job activity');
});

it('shows the error sentence when the summary is unavailable', async () => {
  configure({ error: 'Activity is unavailable.' });
  const fixture = await render();
  expect(button(fixture)?.getAttribute('aria-label')).toBe(
    'Activity: unavailable',
  );
  await open(fixture);
  const alert = dialog(fixture)?.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('Activity is unavailable.');
});
