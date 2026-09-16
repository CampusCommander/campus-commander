import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import {
  googleHealthCheckSchema,
  type GoogleHealth,
} from '@campus/application-contracts';

const customerId = 'C0123456';
const initial = (): GoogleHealth => ({
  customerId,
  generation: 1,
  observedAt: new Date().toISOString(),
  backgroundFailure: null,
  check: null,
  capabilities: (['customer-identity', 'domain-observations'] as const).map(
    (capability) => ({
      capability,
      scopeVerified: true,
      failure: null,
      checkedAt: new Date().toISOString(),
      lastSucceededAt: new Date().toISOString(),
      correlationId: null,
    }),
  ),
});
async function fixture(page: Page, diagnose = true) {
  let health = initial();
  let mode: 'ok' | 'offline' | 'forbidden' = 'ok';
  let preferences = { theme: 'light', navigationCollapsed: false };
  await page.route('**/api/application', (route) =>
    route.fulfill({
      json: {
        phase: 3,
        authenticationConfigured: true,
        version: 'development',
        build: 'unreleased',
      },
    }),
  );
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        identity: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          displayName: 'Fixture admin',
          permissionVersion: 1,
          permissions: ['identity:read'],
          grants: [
            'connection:read',
            ...(diagnose ? ['connection:diagnose'] : []),
          ].map((action) => ({ action, scope: { kind: 'platform' } })),
          preferences,
        },
        csrfToken: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    }),
  );
  await page.route('**/api/auth/preferences', (route) => {
    preferences = route.request().postDataJSON();
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/google-connection', (route) =>
    route.fulfill({
      json: {
        connection: {
          customerId,
          generation: 1,
          clientId: '123456789',
          subject: 'admin@fixture.invalid',
          observedAt: health.observedAt,
          confirmedAt: health.observedAt,
          observation: {
            customerId,
            primaryDomain: 'fixture.invalid',
            domains: [
              {
                name: 'fixture.invalid',
                primary: true,
                verified: true,
                aliases: [],
              },
            ],
          },
        },
      },
    }),
  );
  await page.route('**/api/google-connection/health', (route) => {
    if (mode === 'offline') return route.abort();
    if (mode === 'forbidden')
      return route.fulfill({ status: 403, json: { reason: 'forbidden' } });
    return route.fulfill({ json: { health } });
  });
  await page.goto('/diagnostics');
  await expect(
    page.getByRole('heading', { name: 'Google capability health' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Check enabled Google capabilities' }),
  ).toBeVisible();
  return {
    health: () => health,
    setHealth: (value: GoogleHealth) => {
      health = value;
    },
    mode: (value: typeof mode) => {
      mode = value;
    },
  };
}

test('preserves partial access, uses only the selected scope, and shares the footer result', async ({
  page,
}) => {
  const state = await fixture(page);
  const partial = state.health();
  partial.capabilities[1].failure = 'delegation-not-authorized';
  partial.capabilities[1].scopeVerified = false;
  state.setHealth(partial);
  await page.getByRole('button', { name: 'Refresh Google status' }).click();
  const customer = page.getByRole('article', {
    name: 'Customer identity',
    exact: true,
  });
  const domains = page.getByRole('article', {
    name: 'Customer domains',
    exact: true,
  });
  await expect(customer).toContainText('Last check passed');
  await expect(domains).toContainText('Delegation not authorized');
  await expect(page.locator('footer')).toContainText(
    '1 of 2 capabilities need attention',
  );
  await page.route('**/api/google-connection/health/check', (route) => {
    const input = googleHealthCheckSchema.parse(route.request().postDataJSON());
    expect(input.capabilities).toEqual(['domain-observations']);
    const recovered = structuredClone(partial);
    recovered.capabilities[1].failure = null;
    recovered.capabilities[1].scopeVerified = true;
    return route.fulfill({ status: 201, json: { health: recovered } });
  });
  await page
    .getByRole('button', { name: 'Recheck Customer domains', exact: true })
    .click();
  await expect(domains).toContainText('Last check passed');
  await expect(page.locator('footer')).toContainText('2 last checks passed');
  await expect(
    page.locator('#google-health [role=status]').first(),
  ).toBeFocused();
  await page
    .getByText('Configure required Google authorization', { exact: true })
    .click();
  await expect(
    page.getByLabel('Required Google capability scopes'),
  ).not.toContainText('orgunit');
  await expect(
    page.getByLabel('Required Google capability scopes'),
  ).toContainText('customer.readonly');
  await expect(
    page.getByLabel('Required Google capability scopes'),
  ).toContainText('domain.readonly');
  await expect(
    page.getByText('2 required scopes from enabled, qualified capabilities.'),
  ).toBeVisible();
});

test('retains historical observations offline and clears them after read denial', async ({
  page,
}) => {
  const state = await fixture(page);
  state.mode('offline');
  await page.getByRole('button', { name: 'Refresh Google status' }).click();
  await expect(
    page.getByRole('article', { name: 'Customer identity', exact: true }),
  ).toContainText('Stale observation');
  await expect(
    page.getByRole('button', { name: 'Check enabled Google capabilities' }),
  ).toBeDisabled();
  await expect(page.locator('footer')).toContainText(
    'Google status unavailable',
  );
  state.mode('ok');
  await page.getByRole('button', { name: 'Refresh Google status' }).click();
  await expect(
    page.getByRole('button', { name: 'Check enabled Google capabilities' }),
  ).toBeEnabled();
  state.mode('forbidden');
  await page.getByRole('button', { name: 'Refresh Google status' }).click();
  await expect(
    page.getByRole('article', { name: 'Customer identity', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('footer')).toContainText(
    'Google status unavailable',
  );
});

test('shows stale success and expires a saved pending check without inventing a result', async ({
  page,
}) => {
  await page.clock.install();
  const state = await fixture(page);
  const old = state.health();
  old.capabilities.forEach((item) => {
    item.checkedAt = new Date(
      Date.parse(old.observedAt) - 600000,
    ).toISOString();
  });
  old.check = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    capabilities: ['domain-observations'],
    expiresAt: new Date(Date.parse(old.observedAt) + 2000).toISOString(),
    retryAt: new Date(Date.parse(old.observedAt) + 1000).toISOString(),
    finishedAt: null,
  };
  state.setHealth(old);
  await page.getByRole('button', { name: 'Refresh Google status' }).click();
  await expect(
    page.getByRole('button', { name: 'Check enabled Google capabilities' }),
  ).toBeDisabled();
  await expect(page.locator('footer')).toContainText('Google check running');
  await page.clock.fastForward(4000);
  await expect(page.locator('footer')).toContainText('Google check expired');
  await expect(
    page.getByRole('button', { name: 'Check enabled Google capabilities' }),
  ).toBeEnabled();
  await expect(
    page.getByRole('article', { name: 'Customer identity', exact: true }),
  ).toContainText('Stale observation');
});

test('supports read-only capability inspection', async ({ page }) => {
  await fixture(page, false);
  await expect(
    page.getByRole('button', { name: 'Check enabled Google capabilities' }),
  ).toBeDisabled();
  await expect(
    page.getByText('Your account can inspect Google status.', { exact: false }),
  ).toBeVisible();
});

test('recovers an uncertain request without submitting a second check', async ({
  page,
}) => {
  await fixture(page);
  let checks = 0;
  await page.route('**/api/google-connection/health/check', (route) => {
    checks += 1;
    return route.abort();
  });
  await page
    .getByRole('button', { name: 'Check enabled Google capabilities' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Check enabled Google capabilities' }),
  ).toBeDisabled();
  await expect(
    page.getByText('The Google check result is unknown.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Refresh Google status' }).click();
  await expect(
    page.getByRole('button', { name: 'Check enabled Google capabilities' }),
  ).toBeEnabled();
  expect(checks).toBe(1);
});

for (const theme of ['light', 'dark'])
  test(`Google capability health supports ${theme} accessibility and reflow`, async ({
    page,
  }) => {
    await fixture(page);
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page
      .getByRole('menuitem', { name: `Use ${theme} theme`, exact: true })
      .click();
    await page
      .getByText('Customer identity authorization and evidence', {
        exact: true,
      })
      .click();
    await page
      .getByText('Configure required Google authorization', { exact: true })
      .click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole('button', {
        name: 'Recheck Customer domains',
        exact: true,
      }),
    ).toBeVisible();
  });

test('health links focus details across routes and during repeated same-route navigation', async ({
  page,
}) => {
  await fixture(page);
  const footerLink = page.locator('footer a', { hasText: 'Google:' });
  const heading = page.getByRole('heading', {
    name: 'Google capability health',
  });
  await footerLink.click();
  await expect(heading).toBeFocused();
  await footerLink.click();
  await expect(heading).toBeFocused();
  await page
    .getByRole('link', { name: 'Google customer connection', exact: true })
    .click();
  await page
    .getByRole('link', { name: 'Inspect Google capability health' })
    .click();
  await expect(heading).toBeFocused();
});
