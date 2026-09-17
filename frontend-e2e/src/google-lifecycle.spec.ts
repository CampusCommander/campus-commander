import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const customerId = 'C0123456',
  principal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const account = {
  type: 'service_account',
  client_id: '123456789',
  private_key: 'synthetic-private-key-never-store',
};
const observation = {
  customerId,
  primaryDomain: 'fixture.invalid',
  domains: [
    { name: 'fixture.invalid', primary: true, verified: true, aliases: [] },
  ],
};
const checkedAt = new Date().toISOString();
async function fixture(page: Page, manage = true) {
  let current = {
    customerId,
    generation: 1,
    credentialId: randomUUID(),
    active: true,
    keyId: 'key-1',
  };
  let subject = 'original@fixture.invalid';
  let candidate: Record<string, unknown> | null = null;
  let preferences = { theme: 'light', navigationCollapsed: false };
  let mode:
    | 'ok'
    | 'offline'
    | 'wrong'
    | 'lost-before-stage'
    | 'lost-disconnect'
    | 'rejected-stage'
    | 'lost-stage'
    | 'lost-activation'
    | 'key-unavailable' = 'ok';
  let writes = 0;
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
          id: principal,
          displayName: 'Fixture admin',
          permissionVersion: 1,
          permissions: ['identity:read'],
          grants: [
            'connection:read',
            ...(manage ? ['connection:manage'] : []),
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
    mode === 'offline'
      ? route.abort()
      : route.fulfill({
          json: {
            connection: {
              customerId,
              generation: current.generation,
              observation,
              observedAt: checkedAt,
              confirmedAt: checkedAt,
              clientId: account.client_id,
              subject,
            },
          },
        }),
  );
  await page.route('**/api/google-connection/health', (route) =>
    route.fulfill({
      json: {
        health: {
          customerId,
          generation: current.generation,
          connectionState: current.active ? 'active' : 'disconnected',
          observedAt: new Date().toISOString(),
          backgroundFailure: null,
          check: null,
          capabilities: ['customer-identity', 'domain-observations'].map(
            (capability) => ({
              capability,
              scopeVerified: true,
              failure: null,
              checkedAt,
              lastSucceededAt: checkedAt,
              correlationId: null,
            }),
          ),
        },
      },
    }),
  );
  await page.route('**/api/google-connection/credentials', (route) =>
    mode === 'offline'
      ? route.abort()
      : route.fulfill({
          json: { credential: current, configuredKeyIds: ['key-1', 'key-2'] },
        }),
  );
  await page.route('**/api/google-connection/replacements', async (route) => {
    writes++;
    if (mode === 'lost-before-stage') return route.abort();
    if (mode === 'rejected-stage')
      return route.fulfill({ status: 400, json: { reason: 'invalid-input' } });
    const input = route.request().postDataJSON();
    expect(input.customerId).toBe(customerId);
    expect(input.generation).toBe(current.generation);
    expect(input.serviceAccount.private_key).toBe(account.private_key);
    candidate = {
      id: input.id,
      status: mode === 'wrong' ? 'failed' : 'ready',
      expectedCustomerId: customerId,
      expectedGeneration: current.generation,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      clientId: account.client_id,
      subject: input.subject,
      observation: mode === 'wrong' ? null : observation,
      observedAt: checkedAt,
      failure: mode === 'wrong' ? 'wrong-customer' : null,
    };
    if (mode === 'lost-stage') return route.abort();
    return route.fulfill({ status: 201, json: candidate });
  });
  await page.route('**/api/google-connection/candidates/*', (route) =>
    candidate
      ? route.fulfill({ json: candidate })
      : route.fulfill({
          status: 403,
          json: { reason: 'candidate-unavailable' },
        }),
  );
  await page.route(
    '**/api/google-connection/replacements/*/activate',
    async (route) => {
      writes++;
      const input = route.request().postDataJSON();
      expect(input).toEqual({
        customerId,
        generation: current.generation,
        confirmed: true,
        keyId: input.keyId,
      });
      subject = String(candidate?.['subject']);
      current = {
        ...current,
        credentialId: String(candidate?.['id']),
        generation: current.generation + 1,
        keyId: input.keyId,
        active: true,
      };
      candidate = { ...candidate, status: 'consumed' };
      if (mode === 'lost-activation') return route.abort();
      return route.fulfill({ status: 201, json: current });
    },
  );
  await page.route(
    '**/api/google-connection/credentials/rotate-key',
    (route) => {
      writes++;
      const input = route.request().postDataJSON();
      expect(input).toEqual({
        customerId,
        generation: current.generation,
        confirmed: true,
        keyId: 'key-2',
      });
      if (mode === 'key-unavailable')
        return route.fulfill({
          status: 503,
          json: { reason: 'key-unavailable' },
        });
      current = {
        ...current,
        generation: current.generation + 1,
        credentialId: randomUUID(),
        keyId: input.keyId,
      };
      return route.fulfill({ status: 201, json: current });
    },
  );
  await page.route(
    '**/api/google-connection/credentials/disconnect',
    (route) => {
      writes++;
      expect(route.request().postDataJSON()).toEqual({
        customerId,
        generation: current.generation,
        confirmed: true,
      });
      current = {
        ...current,
        generation: current.generation + 1,
        credentialId: randomUUID(),
        active: false,
      };
      if (mode === 'lost-disconnect') return route.abort();
      return route.fulfill({ status: 201, json: current });
    },
  );
  await page.goto('/google-connection');
  await expect(
    page.getByRole('heading', {
      name: 'Background Google credentials',
      exact: true,
    }),
  ).toBeVisible();
  if (manage)
    await expect(
      page.getByRole('button', {
        name: 'Replace Google credentials',
        exact: true,
      }),
    ).toBeEnabled();
  return {
    setMode: (value: typeof mode) => {
      mode = value;
    },
    writes: () => writes,
    expire: () => {
      candidate = {
        ...candidate,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
    },
    changeGeneration: () => {
      current = { ...current, generation: current.generation + 1 };
    },
  };
}
const confirm = (page: Page) =>
  page.getByRole('checkbox', {
    name: 'I reviewed this credential change and its effect on background access',
    exact: true,
  });
async function stage(page: Page) {
  await page
    .getByRole('button', { name: /^(Replace|Reconnect) Google credentials$/ })
    .click();
  await page
    .getByLabel('Replacement service-account JSON key file')
    .setInputFiles({
      name: 'replacement.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(account)),
    });
  await page
    .getByLabel('Replacement delegated administrator email')
    .fill('replacement@fixture.invalid');
  await page
    .getByRole('button', { name: 'Check replacement credentials', exact: true })
    .click();
}
async function chooseKey(page: Page, name: string, key: string) {
  await page.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: key, exact: true }).click();
}

test('replacement freezes customer and generation, confirms key, and keeps secrets out of storage', async ({
  page,
}) => {
  const state = await fixture(page);
  await stage(page);
  await expect(
    page.getByRole('heading', {
      name: 'Review credential replacement',
      exact: true,
    }),
  ).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Activate replacement', exact: true }),
  ).toBeDisabled();
  await chooseKey(page, 'Replacement encryption key ID', 'key-2');
  await confirm(page).check();
  await chooseKey(page, 'Replacement encryption key ID', 'key-1');
  await expect(confirm(page)).not.toBeChecked();
  await confirm(page).check();
  const activate = page.getByRole('button', {
    name: 'Activate replacement',
    exact: true,
  });
  await expect(activate).toBeEnabled();
  await activate.focus();
  await expect(activate).toBeFocused();
  await activate.press('Enter');
  await expect(
    page.getByText('Replacement activated for the confirmed customer.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Replacement activated' }),
  ).toBeFocused();
  expect(state.writes()).toBe(2);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    ),
  ).not.toContain(account.private_key);
  expect(await page.locator('body').textContent()).not.toContain(
    account.private_key,
  );
});

test('unknown staging and activation recover after reload without duplicate writes', async ({
  page,
}) => {
  const state = await fixture(page);
  state.setMode('lost-stage');
  await stage(page);
  await expect(
    page.getByText('The replacement result is unknown.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Close review', exact: true }),
  ).toBeDisabled();
  state.setMode('ok');
  await page.reload();
  await expect(confirm(page)).toBeVisible();
  await chooseKey(page, 'Replacement encryption key ID', 'key-1');
  await confirm(page).check();
  state.setMode('lost-activation');
  await page
    .getByRole('button', { name: 'Activate replacement', exact: true })
    .click();
  await expect(
    page.getByText('The credential change result is unknown.', {
      exact: false,
    }),
  ).toBeVisible();
  state.setMode('ok');
  await page.reload();
  await expect(
    page.getByText('The replacement was activated.', { exact: false }),
  ).toBeVisible();
  expect(state.writes()).toBe(2);
  expect(
    await page.evaluate(
      ({ principal, customerId }) =>
        sessionStorage.getItem(
          `cc:google-replacement:${principal}:${customerId}`,
        ),
      { principal, customerId },
    ),
  ).toBeNull();
});

test('wrong-customer and expired reviews cannot activate replacements', async ({
  page,
}) => {
  const state = await fixture(page);
  state.setMode('wrong');
  await stage(page);
  await expect(
    page.getByText(
      'The failed replacement did not change the current credential.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Activate replacement', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Close review', exact: true }).click();
  state.setMode('ok');
  await stage(page);
  await expect(confirm(page)).toBeVisible();
  state.expire();
  await page
    .getByRole('button', { name: 'Refresh credential status', exact: true })
    .click();
  await expect(
    page.getByText('This replacement review expired', { exact: false }),
  ).toBeVisible();
  await expect(confirm(page)).toHaveCount(0);
});

test('stale generation and offline reads require a fresh review while preserving ordinary inputs', async ({
  page,
}) => {
  const state = await fixture(page);
  await page
    .getByRole('button', { name: 'Replace Google credentials', exact: true })
    .click();
  await page
    .getByLabel('Replacement delegated administrator email')
    .fill('replacement@fixture.invalid');
  state.setMode('offline');
  await page
    .getByRole('button', { name: 'Refresh credential status', exact: true })
    .click();
  await expect(
    page.getByText('Credential status is unavailable', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Replacement delegated administrator email'),
  ).toHaveValue('replacement@fixture.invalid');
  await expect(
    page.getByRole('button', {
      name: 'Check replacement credentials',
      exact: true,
    }),
  ).toBeDisabled();
  state.setMode('ok');
  await page
    .getByRole('button', { name: 'Refresh credential status', exact: true })
    .click();
  await page.getByRole('button', { name: 'Close review', exact: true }).click();
  await stage(page);
  await confirm(page).check();
  state.changeGeneration();
  await page
    .getByRole('button', { name: 'Refresh credential status', exact: true })
    .click();
  await expect(
    page.getByText('The reviewed generation differs', { exact: false }),
  ).toBeVisible();
  await expect(confirm(page)).toHaveCount(0);
});

test('key rotation handles missing keys and disconnect requires a separate destructive review', async ({
  page,
}) => {
  const state = await fixture(page);
  await page
    .getByRole('button', { name: 'Rotate encryption key', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Confirm key rotation', exact: true }),
  ).toBeDisabled();
  await chooseKey(page, 'New encryption key ID', 'key-2');
  await confirm(page).check();
  state.setMode('key-unavailable');
  await page
    .getByRole('button', { name: 'Confirm key rotation', exact: true })
    .click();
  await expect(
    page.getByText('The selected encryption key is unavailable.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(confirm(page)).not.toBeChecked();
  state.setMode('ok');
  await page
    .getByRole('button', { name: 'Refresh credential status', exact: true })
    .click();
  await confirm(page).check();
  await page
    .getByRole('button', { name: 'Confirm key rotation', exact: true })
    .click();
  await expect(
    page.getByText('Encryption key rotated.', { exact: false }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Disconnect background access', exact: true })
    .click();
  await expect(
    page.getByText('This action does not revoke the service account', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Confirm local disconnect', exact: true }),
  ).toBeDisabled();
  await confirm(page).check();
  await page
    .getByRole('button', { name: 'Confirm local disconnect', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Reconnect Google credentials',
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByText('Google background access disconnected', { exact: true }),
  ).toBeVisible();
  expect(state.writes()).toBe(3);
  await stage(page);
  await confirm(page).check();
  await page
    .getByRole('button', { name: 'Activate replacement', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Replace Google credentials',
      exact: true,
    }),
  ).toBeEnabled();
});

test('a staging request lost before acceptance can recover without reloading', async ({
  page,
}) => {
  const state = await fixture(page);
  state.setMode('lost-before-stage');
  await stage(page);
  await expect(
    page.getByText('The replacement result is unknown.', { exact: false }),
  ).toBeVisible();
  state.setMode('ok');
  await page
    .getByRole('button', { name: 'Refresh credential status', exact: true })
    .click();
  await expect(
    page.getByText('This replacement review is unavailable.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Replace Google credentials',
      exact: true,
    }),
  ).toBeEnabled();
  expect(state.writes()).toBe(1);
  await stage(page);
  await expect(confirm(page)).toBeVisible();
});

test('a lost disconnect response refreshes into reconnection without obsolete confirmation', async ({
  page,
}) => {
  const state = await fixture(page);
  await page
    .getByRole('button', { name: 'Disconnect background access', exact: true })
    .click();
  await confirm(page).check();
  state.setMode('lost-disconnect');
  await page
    .getByRole('button', { name: 'Confirm local disconnect', exact: true })
    .click();
  await expect(
    page.getByText('The credential change result is unknown.', {
      exact: false,
    }),
  ).toBeVisible();
  state.setMode('ok');
  await page
    .getByRole('button', { name: 'Refresh credential status', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Reconnect Google credentials',
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Confirm local disconnect', exact: true }),
  ).toHaveCount(0);
  expect(state.writes()).toBe(1);
});

test('staging progress and definite rejection retain focus', async ({
  page,
}) => {
  const state = await fixture(page);
  let release: () => void = () => {
    throw new Error('Request not started');
  };
  await page.route('**/api/google-connection/replacements', async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fallback();
  });
  state.setMode('rejected-stage');
  await stage(page);
  await expect(
    page.getByRole('heading', {
      name: 'Review credential replacement',
      exact: true,
    }),
  ).toBeFocused();
  release();
  const failure = page
    .getByRole('status')
    .filter({ hasText: 'The replacement was not staged.' });
  await expect(failure).toBeVisible();
  await expect(failure).toBeFocused();
});

test('read-only operators cannot manage credentials', async ({ page }) => {
  await fixture(page, false);
  await expect(
    page.getByText(
      'A platform administrator with Manage Google credentials access must replace',
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Replace Google credentials',
      exact: true,
    }),
  ).toHaveCount(0);
});

for (const theme of ['light', 'dark'])
  test(`credential reviews support ${theme} accessibility and reflow`, async ({
    page,
  }, testInfo) => {
    await fixture(page);
    await page
      .getByRole('button', { name: 'Choose theme', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: `Use ${theme} theme`, exact: true })
      .click();
    await stage(page);
    const replacement = await new AxeBuilder({ page }).analyze();
    expect(replacement.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`replacement-${theme}.png`),
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'Close review', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: 'Disconnect background access',
        exact: true,
      })
      .click();
    await confirm(page).check();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`disconnect-${theme}.png`),
      fullPage: true,
    });
    for (const [width, zoom] of [
      [320, '1'],
      [1280, '2'],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((zoom) => {
        document.documentElement.style.zoom = zoom;
      }, zoom);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      await expect(
        page.getByRole('button', {
          name: 'Confirm local disconnect',
          exact: true,
        }),
      ).toBeVisible();
    }
  });
