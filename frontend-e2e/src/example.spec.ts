import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/application', (route) =>
    route.fulfill({
      json: {
        phase: 1,
        authenticationConfigured: false,
        version: 'test',
        build: 'synthetic',
      },
    }),
  );
});

test('shows the Phase 1 startup boundary', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Campus Commander startup');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Application service started',
  );
  await expect(
    page.getByRole('status').filter({ hasText: 'Frontend process running' }),
  ).toHaveText(/Frontend process running/);
  await expect(page.getByText('Google Workspace features')).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
});

test('refreshes readiness when a dependency fails', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/startup', async (route) => {
    requests += 1;
    const status = requests === 1 ? 'ready' : 'not-ready';
    await route.fulfill({
      status: requests === 1 ? 200 : 503,
      json: {
        phase: 1,
        status,
        checks: [{ name: 'database', status }],
      },
    });
  });
  await page.goto('/');
  await expect(
    page.getByText('Installation checks ready', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Installation needs attention', { exact: true }),
  ).toBeVisible({ timeout: 16000 });
});

test('rejects an empty readiness report', async ({ page }) => {
  await page.route('**/api/startup', (route) =>
    route.fulfill({
      json: {
        phase: 1,
        status: 'ready',
        checks: [],
      },
    }),
  );
  await page.goto('/');
  await expect(
    page.getByText('Installation status unavailable', { exact: true }),
  ).toBeVisible();
});

test('marks cached checks stale after connection loss', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/startup', async (route) => {
    requests += 1;
    if (requests > 1) return route.abort('failed');
    await route.fulfill({
      json: {
        phase: 1,
        status: 'ready',
        checks: [{ name: 'database', status: 'ready' }],
      },
    });
  });
  await page.goto('/');
  await expect(
    page.getByText('Installation checks ready', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Previous checks are stale.', { exact: true }),
  ).toBeVisible({ timeout: 16000 });
  await expect(
    page.getByText('database: ready (previous observation)', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('time')).toHaveAttribute('datetime', /^\d{4}-/);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`fits a narrow viewport in the ${colorScheme} theme`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
