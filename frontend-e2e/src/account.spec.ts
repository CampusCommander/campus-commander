import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Grant } from '@campus/application-contracts';

async function signIn(page: Page, grants: Grant[]) {
  let preferences = { theme: 'light', navigationCollapsed: false };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
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
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            displayName: 'Review administrator',
            permissionVersion: 1,
            permissions: ['identity:read'],
            grants,
            preferences,
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (path === '/api/auth/preferences') {
      preferences = route.request().postDataJSON();
      return route.fulfill({ json: {} });
    }
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (path === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (path === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/account');
  await expect(
    page.getByRole('heading', { name: 'Your account', exact: true }),
  ).toBeVisible();
}

test('account directs an administrator to current tasks with keyboard access and both themes', async ({
  page,
}, testInfo) => {
  await signIn(page, [
    { action: 'connection:read', scope: { kind: 'platform' } },
    { action: 'customer:read', scope: { kind: 'platform' } },
    { action: 'schools:read', scope: { kind: 'platform' } },
    { action: 'platform-users:read', scope: { kind: 'platform' } },
  ]);
  const tasks = page.getByRole('region', { name: 'Start here' });
  await expect(tasks.getByRole('link')).toHaveCount(5);
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitem', { name: `Use ${theme} theme` }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: testInfo.outputPath(`account-${theme}.png`),
      fullPage: true,
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  const link = tasks.getByRole('link', { name: 'Review Google connection' });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/google-connection$/);
  await expect(
    page.getByRole('heading', {
      name: 'Google customer connection',
      exact: true,
    }),
  ).toBeVisible();
});

test('account limits guidance to assigned school access and hides unavailable diagnostics', async ({
  page,
}) => {
  await signIn(page, [
    {
      action: 'schools:read',
      scope: {
        kind: 'school',
        customerId: 'C0123456',
        schoolId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    },
  ]);
  const tasks = page.getByRole('region', { name: 'Start here' });
  await expect(tasks.getByRole('link')).toHaveCount(1);
  await expect(
    tasks.getByRole('link', { name: 'Browse schools' }),
  ).toHaveAttribute('href', '/schools');
  await expect(
    page.getByRole('link', { name: 'Open Diagnostics' }),
  ).toHaveCount(0);
  await signIn(page, []);
  await expect(page.getByRole('region', { name: 'Start here' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Help' })).toBeVisible();
});
