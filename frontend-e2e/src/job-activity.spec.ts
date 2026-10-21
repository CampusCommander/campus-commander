import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { JobSummary } from '@campus/application-contracts';

const customerId = 'C0123456';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'Maya Chen',
};

interface State {
  running: boolean;
  waiting: boolean;
  recent: boolean;
  attention: boolean;
  failSeen: boolean;
}

/** The activity summary of the approved mockup. Durations start at test time. */
function summary(state: State) {
  const now = Date.now();
  const started = new Date(now - 128_000).toISOString();
  const job = (overrides: Partial<JobSummary>): JobSummary => ({
    jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    displayId: 'UPD-014',
    revision: 3,
    action: 'update-device-annotations',
    status: 'running',
    scope: { kind: 'devices', deviceCount: 48 },
    requestedBy: person,
    createdAt: new Date(now - 300_000).toISOString(),
    startedAt: started,
    finishedAt: null,
    progress: {
      total: 48,
      succeeded: 36,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 0,
      pending: 12,
    },
    failure: null,
    ...overrides,
  });
  const running = state.running
    ? [
        job({
          jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
          displayId: 'UPD-014',
          action: 'update-device-annotations',
          status: 'running',
        }),
        job({
          jobId: '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
          displayId: 'REF-031',
          action: 'refresh-inventory',
          status: 'running',
          scope: { kind: 'all-devices', deviceCount: null },
          requestedBy: {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            displayName: 'District Admin',
          },
          startedAt: new Date(now - 72_000).toISOString(),
          progress: {
            total: null,
            succeeded: 3200,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            pending: null,
          },
        }),
      ]
    : [];
  const waiting = state.waiting
    ? [
        job({
          jobId: '2f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
          displayId: 'UPD-013',
          action: 'update-device-annotations',
          status: 'held',
          scope: { kind: 'devices', deviceCount: 24 },
          startedAt: null,
          progress: {
            total: 24,
            succeeded: 0,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            pending: 24,
          },
        }),
      ]
    : [];
  const recent = state.recent
    ? [
        job({
          jobId: '3f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
          displayId: 'UPD-006',
          action: 'update-device-annotations',
          status: 'needs-review',
          scope: { kind: 'devices', deviceCount: 6 },
          startedAt: new Date(now - 30 * 60_000).toISOString(),
          finishedAt: new Date(now - 29 * 60_000).toISOString(),
          progress: {
            total: 6,
            succeeded: 4,
            failed: 1,
            unknown: 1,
            skipped: 0,
            expired: 0,
            pending: 0,
          },
        }),
        job({
          jobId: '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
          displayId: 'REF-030',
          action: 'refresh-inventory',
          status: 'completed',
          scope: { kind: 'all-devices', deviceCount: null },
          startedAt: new Date(now - 40 * 60_000).toISOString(),
          finishedAt: new Date(now - 37 * 60_000).toISOString(),
          progress: {
            total: null,
            succeeded: 7000,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            pending: null,
          },
        }),
        job({
          jobId: '5f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
          displayId: 'UPD-003',
          action: 'update-device-annotations',
          status: 'completed-with-errors',
          scope: { kind: 'devices', deviceCount: 6 },
          startedAt: new Date(now - 70 * 60_000).toISOString(),
          finishedAt: new Date(now - 68 * 60_000).toISOString(),
          progress: {
            total: 6,
            succeeded: 5,
            failed: 1,
            unknown: 0,
            skipped: 0,
            expired: 0,
            pending: 0,
          },
        }),
      ]
    : [];
  const oldestRecent = recent.at(-1)?.finishedAt ?? null;
  return {
    running: { count: running.length, jobs: running },
    waiting: { count: waiting.length, jobs: waiting },
    recent: {
      count: recent.length,
      jobs: recent,
      nextExpiryAt: oldestRecent
        ? new Date(Date.parse(oldestRecent) + 86_400_000).toISOString()
        : null,
    },
    attention: state.attention,
    seenAt: state.attention ? null : new Date(now - 60_000).toISOString(),
    observedAt: new Date(now).toISOString(),
  };
}

/**
 * The stream is replaced because Playwright cannot hold an SSE response open with
 * `route.fulfill`. The fake opens once and relays `job-changed` events on command.
 */
async function fakeStream(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as {
      __jobSources: {
        readyState: number;
        emit: (type: string, event: Event) => void;
      }[];
      __emitJobChanged: (payload: unknown) => void;
    };
    state.__jobSources = [];
    class FakeEventSource {
      readyState = 0;
      private readonly listeners = new Map<
        string,
        ((event: Event) => void)[]
      >();
      constructor() {
        setTimeout(() => {
          this.readyState = 1;
          this.emit('open', new Event('open'));
        }, 0);
        state.__jobSources.push(this);
      }
      addEventListener(type: string, listener: (event: Event) => void) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      close() {
        this.readyState = 2;
      }
      emit(type: string, event: Event) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    (window as unknown as { EventSource: unknown }).EventSource =
      FakeEventSource;
    state.__emitJobChanged = (payload: unknown) => {
      for (const source of state.__jobSources) {
        if (source.readyState === 2) continue;
        source.emit(
          'job-changed',
          new MessageEvent('job-changed', { data: JSON.stringify(payload) }),
        );
      }
    };
  });
}

async function signIn(page: Page, state: State) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/application')
      return route.fulfill({
        json: {
          phase: 3,
          authenticationConfigured: true,
          version: 'development',
          build: 'client-review',
        },
      });
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          identity: {
            id: person.id,
            displayName: person.displayName,
            permissionVersion: 1,
            permissions: [],
            grants: ['jobs:read', 'devices:read'].map((action) => ({
              action,
              scope: { kind: 'district', customerId },
            })),
            preferences: { theme: 'light', navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    if (path === '/api/jobs/activity/seen') {
      if (state.failSeen) return route.fulfill({ status: 500 });
      state.attention = false;
      return route.fulfill({ json: { seenAt: new Date().toISOString() } });
    }
    if (path === '/api/jobs/activity')
      return route.fulfill({ json: summary(state) });
    if (path === '/api/jobs/events')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      });
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    return route.fulfill({ json: {} });
  });
}

/** A request that never settles, so a state stays on screen. */
const never = () => new Promise<void>(() => undefined);

const bell = (page: Page) => page.getByRole('button', { name: /^Activity:/ });
const dot = (page: Page) => page.locator('.attention-dot');

/** Relays one job-changed event through the fake stream. */
async function relay(page: Page, payload: Record<string, unknown>) {
  await page.evaluate((data) => {
    (
      window as unknown as { __emitJobChanged: (value: unknown) => void }
    ).__emitJobChanged(data);
  }, payload);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('shows the idle, running, and attention states and the open panel', async ({
  page,
}, testInfo) => {
  const state: State = {
    running: false,
    waiting: false,
    recent: false,
    attention: false,
    failSeen: false,
  };
  await fakeStream(page);
  await signIn(page, state);
  await page.goto('/account');

  await expect(bell(page)).toHaveAttribute(
    'aria-label',
    'Activity: no jobs running',
  );
  await expect(page.locator('.badge')).toHaveCount(0);
  await expect(dot(page)).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath('activity-idle.png') });

  state.running = true;
  state.waiting = true;
  state.recent = true;
  await relay(page, {
    type: 'job-changed',
    jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    displayId: 'UPD-014',
    revision: 9,
    requestedBy: person.id,
  });
  await expect(bell(page)).toHaveAttribute(
    'aria-label',
    'Activity: 2 jobs running',
  );
  await expect(page.locator('.ring')).toHaveCount(1);
  await expect(page.locator('.badge')).toHaveText('2');
  await expect(dot(page)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('activity-running.png') });

  state.attention = true;
  await relay(page, {
    type: 'job-changed',
    jobId: '3f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    displayId: 'UPD-006',
    revision: 4,
    requestedBy: person.id,
  });
  await expect(bell(page)).toHaveAttribute(
    'aria-label',
    'Activity: 2 jobs running, needs attention',
  );
  await expect(dot(page)).toHaveCount(1);
  await expect(page.locator('.ring')).toHaveCount(1);
  await expect(page.locator('.badge')).toHaveText('2');
  await page.screenshot({
    path: testInfo.outputPath('activity-attention.png'),
  });

  await bell(page).click();
  const panel = page.getByRole('dialog', { name: 'Activity' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('District activity')).toBeVisible();
  await expect(panel.getByText('Running · 2')).toBeVisible();
  await expect(panel.getByText('Waiting · 1')).toBeVisible();
  await expect(panel.getByText('Recent · 3 · last 24 hours')).toBeVisible();
  await expect(panel.getByText('36 of 48 complete · Maya Chen')).toBeVisible();
  await expect(
    panel.getByText('3,200 devices read · District Admin'),
  ).toBeVisible();
  await expect(
    panel.getByText('Held · Google backoff · Starts when Google allows'),
  ).toBeVisible();
  await expect(
    panel.getByText('Needs review · 4 succeeded · 1 failed · 1 unknown'),
  ).toBeVisible();
  await expect(
    panel.getByText('Completed with errors · 5 succeeded · 1 failed'),
  ).toBeVisible();
  await expect(panel.getByText('Updated live')).toBeVisible();
  await expect(
    panel.getByRole('link', { name: 'View all jobs' }),
  ).toHaveAttribute('href', '/jobs');
  await expect(panel.locator('a.row[href="/jobs/UPD-014"]')).toHaveCount(1);
  // The running row without a total shows an indeterminate bar.
  await expect(panel.locator('.bar.indeterminate')).toHaveCount(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('activity-panel-light.png'),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Choose theme' }).click();
  await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.cdk-overlay-container > *')).toHaveCount(0);
  // The theme menu is outside the panel, so it closes the panel. Reopen it.
  await bell(page).click();
  await expect(panel).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('activity-panel-dark.png'),
    fullPage: true,
  });

  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('activity-panel-320.png'),
    fullPage: true,
  });
});

test('keeps the whole panel inside the viewport above the breakpoint', async ({
  page,
}, testInfo) => {
  const state: State = {
    running: true,
    waiting: true,
    recent: true,
    attention: false,
    failSeen: false,
  };
  await fakeStream(page);
  await signIn(page, state);
  await page.goto('/account');
  const panel = page.getByRole('dialog', { name: 'Activity' });

  for (const width of [600, 561]) {
    await page.setViewportSize({ width, height: 900 });
    await bell(page).click();
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    // Both edges stay inside the viewport at 600 px and just above the 560 px
    // bottom-sheet breakpoint.
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
    if (width === 600)
      await page.screenshot({
        path: testInfo.outputPath('activity-panel-600.png'),
        fullPage: true,
      });
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  }
});

test('shows the loading sentence while the first summary is pending', async ({
  page,
}, testInfo) => {
  const state: State = {
    running: false,
    waiting: false,
    recent: false,
    attention: false,
    failSeen: false,
  };
  await fakeStream(page);
  await signIn(page, state);
  // Hold the first read open. The request ends when the test closes the page.
  await page.route('**/api/jobs/activity', never);
  await page.goto('/account');
  await bell(page).click();
  const panel = page.getByRole('dialog', { name: 'Activity' });
  await expect(panel.getByText('Loading job activity')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('activity-loading.png'),
    fullPage: true,
  });
});

test('shows the offline message when the summary cannot reach the server', async ({
  page,
}, testInfo) => {
  const state: State = {
    running: false,
    waiting: false,
    recent: false,
    attention: false,
    failSeen: false,
  };
  await fakeStream(page);
  await signIn(page, state);
  await page.route('**/api/jobs/activity', (route) => route.abort('failed'));
  await page.goto('/account');
  await bell(page).click();
  const panel = page.getByRole('dialog', { name: 'Activity' });
  await expect(panel.getByRole('alert')).toContainText(
    'Cannot reach Campus Commander. Activity is unavailable.',
  );
  await expect(bell(page)).toHaveAttribute(
    'aria-label',
    'Activity: unavailable',
  );
  await expect(panel.getByText('Loading job activity')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('activity-offline.png'),
    fullPage: true,
  });
});

test('clears the dot after the panel opens and seen succeeds', async ({
  page,
}) => {
  const state: State = {
    running: false,
    waiting: false,
    recent: true,
    attention: true,
    failSeen: false,
  };
  await fakeStream(page);
  await signIn(page, state);
  const seen: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/jobs/activity/seen'))
      seen.push(request.method());
  });
  await page.goto('/account');

  await expect(dot(page)).toHaveCount(1);
  await expect(bell(page)).toHaveAttribute(
    'aria-label',
    'Activity: no jobs running, needs attention',
  );
  await bell(page).click();
  await expect(page.getByRole('dialog', { name: 'Activity' })).toBeVisible();
  // No job event and no reconnect take part. The seen reread clears the dot.
  await expect(dot(page)).toHaveCount(0);
  await expect(bell(page)).toHaveAttribute(
    'aria-label',
    'Activity: no jobs running',
  );
  expect(seen).toEqual(['POST']);
});

test('keeps the dot when seen fails and sends it again on the next opening', async ({
  page,
}) => {
  const state: State = {
    running: false,
    waiting: false,
    recent: true,
    attention: true,
    failSeen: true,
  };
  await fakeStream(page);
  await signIn(page, state);
  let sent = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/jobs/activity/seen')) sent++;
  });
  await page.goto('/account');

  await bell(page).click();
  const panel = page.getByRole('dialog', { name: 'Activity' });
  await expect(panel).toBeVisible();
  await expect(dot(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await bell(page).click();
  await expect(panel).toBeVisible();
  await expect(dot(page)).toHaveCount(1);
  expect(sent).toBe(2);
});

test('opens a job detail and the Jobs page from the panel', async ({
  page,
}) => {
  const state: State = {
    running: true,
    waiting: false,
    recent: false,
    attention: false,
    failSeen: false,
  };
  await fakeStream(page);
  await signIn(page, state);
  await page.goto('/account');

  await bell(page).click();
  await page.locator('a.row[href="/jobs/UPD-014"]').click();
  await expect(page).toHaveURL(/\/jobs\/UPD-014$/);
  expect(new URL(page.url()).pathname).not.toBe('/account');

  await page.goto('/account');
  await bell(page).click();
  await page.getByRole('link', { name: 'View all jobs' }).click();
  await expect(page).toHaveURL(/\/jobs$/);
  expect(new URL(page.url()).pathname).toBe('/jobs');
});

test('moves the badge after a relayed terminal job-changed event', async ({
  page,
}) => {
  const state: State = {
    running: true,
    waiting: false,
    recent: false,
    attention: false,
    failSeen: false,
  };
  await fakeStream(page);
  await signIn(page, state);
  await page.goto('/account');
  await expect(bell(page)).toHaveAttribute(
    'aria-label',
    'Activity: 2 jobs running',
  );

  state.running = false;
  state.recent = true;
  await relay(page, {
    type: 'job-changed',
    jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    displayId: 'UPD-014',
    revision: 10,
    requestedBy: person.id,
  });
  await expect(bell(page)).toHaveAttribute(
    'aria-label',
    'Activity: no jobs running',
  );
  await expect(page.locator('.badge')).toHaveCount(0);
});
