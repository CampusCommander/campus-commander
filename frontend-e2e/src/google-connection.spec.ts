import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const principal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const csrf = 'a'.repeat(64);
const account = {
  type: 'service_account',
  client_id: '123456789',
  private_key: 'synthetic-private-key-never-store',
};
const observation = {
  customerId: 'C0123456',
  primaryDomain: 'example.invalid',
  domains: [
    {
      name: 'example.invalid',
      primary: true,
      verified: true,
      aliases: [{ name: 'alias.invalid', verified: false }],
    },
    { name: 'secondary.invalid', primary: false, verified: true, aliases: [] },
  ],
};
const ready = (id = randomUUID()) => ({
  id,
  status: 'ready',
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  clientId: account.client_id,
  subject: 'admin@example.invalid',
  observation,
  observedAt: new Date().toISOString(),
  failure: null,
});
const connected = () => ({
  customerId: observation.customerId,
  generation: 1,
  observation,
  observedAt: new Date().toISOString(),
  confirmedAt: new Date().toISOString(),
  clientId: account.client_id,
  subject: 'admin@example.invalid',
});

async function fixture(page: Page, manage = true, phase = 3) {
  await page.route('**/api/application', (route) =>
    route.fulfill({
      json: {
        phase,
        authenticationConfigured: true,
        version: 'test',
        build: 'synthetic',
      },
    }),
  );
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        identity: {
          id: principal,
          displayName: 'Fixture administrator',
          permissionVersion: 1,
          permissions: ['identity:read'],
          grants: [
            'connection:read',
            ...(manage ? ['connection:manage'] : []),
          ].map((action) => ({ action, scope: { kind: 'platform' } })),
          preferences: { theme: 'light', navigationCollapsed: false },
        },
        csrfToken: csrf,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    }),
  );
  await page.route('**/api/google-connection', (route) =>
    route.fulfill({ json: { connection: null } }),
  );
  await page.goto('/google-connection');
  if (phase === 3)
    await expect(
      page.getByRole('heading', {
        name: 'Google customer connection',
        exact: true,
      }),
    ).toBeVisible();
}
async function select(page: Page) {
  await page.getByLabel('Service-account JSON key file').setInputFiles({
    name: 'fixture-service-account.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(account)),
  });
  await expect(
    page.getByLabel('Service account client ID', { exact: true }),
  ).toHaveValue(account.client_id);
  await page
    .getByLabel('Delegated administrator email')
    .fill('admin@example.invalid');
}

test('recovers lost import and confirmation responses without browser credential storage', async ({
  page,
}) => {
  await fixture(page);
  let candidate = ready();
  let connection: ReturnType<typeof connected> | null = null;
  let confirmations = 0;
  await page.route('**/api/google-connection', (route) =>
    route.fulfill({ json: { connection } }),
  );
  await page.route('**/api/google-connection/candidates', async (route) => {
    const input = route.request().postDataJSON();
    expect(input.serviceAccount.private_key).toBe(account.private_key);
    expect(route.request().headers()['x-csrf-token']).toBe(csrf);
    candidate = ready(input.id);
    await route.abort('failed');
  });
  await page.route('**/api/google-connection/candidates/*', (route) =>
    route.fulfill({ json: candidate }),
  );
  await page.route(
    '**/api/google-connection/candidates/*/confirm',
    async (route) => {
      confirmations += 1;
      expect(route.request().postDataJSON()).toEqual({
        customerId: observation.customerId,
        confirmed: true,
      });
      connection = connected();
      await route.abort('failed');
    },
  );
  await select(page);
  await page
    .getByRole('button', { name: 'Check credentials', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'credential result is unknown',
  );
  await expect(
    page.getByRole('button', { name: 'Start another import' }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByText('secondary.invalid — Secondary domain.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Confirm customer', exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    ),
  ).not.toContain(account.private_key);
  expect(await page.locator('body').textContent()).not.toContain(
    account.private_key,
  );
  await page
    .getByRole('checkbox', {
      name: 'I verified this customer ID and primary domain',
    })
    .check();
  await expect(
    page.getByRole('button', { name: 'Confirm customer', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Confirm customer', exact: true })
    .focus();
  await expect(
    page.getByRole('button', { name: 'Confirm customer', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Confirmation did not return a result',
  );
  await page.getByRole('button', { name: 'Refresh saved status' }).click();
  await expect(
    page.getByRole('heading', { name: 'Customer connected', exact: true }),
  ).toBeVisible();
  expect(confirmations).toBe(1);
  expect(
    await page.evaluate(
      (key) => sessionStorage.getItem(key),
      `cc:google-candidate:${principal}`,
    ),
  ).toBeNull();
  await page.reload();
  await expect(
    page
      .getByRole('navigation')
      .getByText(observation.customerId, { exact: true }),
  ).toBeVisible();
});

test('offline status preserves ordinary inputs and requires refresh before submission', async ({
  page,
}) => {
  await fixture(page);
  await select(page);
  const offline = (route: import('@playwright/test').Route) =>
    route.abort('internetdisconnected');
  await page.route('**/api/google-connection', offline);
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Refresh saved status' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Saved connection status is unavailable',
  );
  await expect(page.getByLabel('Delegated administrator email')).toHaveValue(
    'admin@example.invalid',
  );
  await expect(
    page.getByRole('button', { name: 'Check credentials', exact: true }),
  ).toBeDisabled();
  await page.context().setOffline(false);
  await page.unroute('**/api/google-connection', offline);
  await page.getByRole('button', { name: 'Refresh saved status' }).click();
  await expect(
    page.getByRole('button', { name: 'Check credentials', exact: true }),
  ).toBeEnabled();
});

test('rate-limited staging explains rejection and permits another import', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/google-connection/candidates', (route) =>
    route.fulfill({ status: 429, json: { reason: 'busy' } }),
  );
  await select(page);
  await page
    .getByRole('button', { name: 'Check credentials', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'credential check limit was reached',
  );
  expect(
    await page.evaluate(
      (key) => sessionStorage.getItem(key),
      `cc:google-candidate:${principal}`,
    ),
  ).toBeNull();
  await expect(
    page.getByRole('heading', { name: 'Import a service account' }),
  ).toBeVisible();
  await expect(
    page.getByText('No key file selected.', { exact: true }),
  ).toBeVisible();
});

test('expired review cannot confirm and a read-only user cannot import', async ({
  page,
}) => {
  await fixture(page);
  const candidate = {
    ...ready(),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  };
  await page.evaluate(
    ({ principal, id }) =>
      sessionStorage.setItem(`cc:google-candidate:${principal}`, id),
    { principal, id: candidate.id },
  );
  await page.route('**/api/google-connection/candidates/*', (route) =>
    route.fulfill({ json: candidate }),
  );
  await page.reload();
  await expect(
    page.getByText('This review expired.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Confirm customer', exact: true }),
  ).toHaveCount(0);
  await fixture(page, false);
  await expect(
    page.getByRole('heading', { name: 'Import a service account' }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      'A platform administrator with Manage Google credentials access',
      { exact: false },
    ),
  ).toBeVisible();
});

test('phase two does not expose customer onboarding', async ({ page }) => {
  await fixture(page, true, 2);
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole('link', { name: 'Google customer connection' }),
  ).toHaveCount(0);
});

test('access interruption clears the private file before the same administrator resumes', async ({
  page,
}) => {
  await fixture(page);
  await select(page);
  const interrupted = (route: import('@playwright/test').Route) =>
    route.fulfill({
      status: 401,
      json: { code: 'access-changed' },
    });
  await page.route('**/api/google-connection', interrupted);
  await page.getByRole('button', { name: 'Refresh saved status' }).click();
  await expect(
    page.getByRole('button', { name: 'Recheck access' }),
  ).toBeVisible();
  await page.unroute('**/api/google-connection', interrupted);
  await page.getByRole('button', { name: 'Recheck access' }).click();
  await expect(
    page.getByText('No key file selected.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Check credentials', exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel('Delegated administrator email')).toHaveValue(
    'admin@example.invalid',
  );
});

test('customer import and review meet automated accessibility and overflow checks', async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.getByText('Configure Google delegation', { exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset['theme'] = theme;
    }, theme);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('mat-label').first()).toHaveCSS(
      'color',
      theme === 'dark' ? 'rgb(154, 160, 166)' : 'rgb(95, 99, 104)',
    );
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`import-${theme}.png`),
      fullPage: true,
    });
  }
  await page.route('**/api/google-connection/candidates', (route) =>
    route.fulfill({
      status: 201,
      json: ready(route.request().postDataJSON().id),
    }),
  );
  await select(page);
  await page
    .getByRole('button', { name: 'Check credentials', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Confirm customer', exact: true }),
  ).toBeDisabled();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset['theme'] = theme;
    }, theme);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`review-${theme}.png`),
      fullPage: true,
    });
  }
  for (const [width, zoom] of [
    [1280, '2'],
    [320, '1'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((zoom) => {
      document.body.style.zoom = zoom;
    }, zoom);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});
