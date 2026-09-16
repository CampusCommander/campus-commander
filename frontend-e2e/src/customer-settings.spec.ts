import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import type {
  CustomerState,
  CustomerSettingsReceipt,
} from '@campus/application-contracts';
import { customerSettingsWriteSchema } from '@campus/application-contracts';

const principal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const initial = (): CustomerState => ({
  customerId: 'C0123456',
  primaryDomain: 'fixture.invalid',
  settings: { displayName: 'Fixture district' },
  revision: 0,
  lastRequestId: null,
  onboarding: {
    customerConfirmedAt: '2026-09-16T10:00:00Z',
    settingsConfirmedAt: null,
    lastGoogleObservationAt: '2026-09-16T10:00:00Z',
  },
});
async function fixture(page: Page, write = true, phase = 3) {
  let customer: CustomerState | null = initial();
  let csrf = 'a'.repeat(64);
  let interrupted = false;
  let readable = true;
  let preferences = { theme: 'light', navigationCollapsed: false };
  await page.route('**/api/application', (route) =>
    route.fulfill({
      json: {
        phase,
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
            ...(readable ? ['customer:read'] : []),
            ...(write ? ['customer:write'] : []),
          ].map((action) => ({ action, scope: { kind: 'platform' } })),
          preferences,
        },
        csrfToken: csrf,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    }),
  );
  await page.route('**/api/auth/preferences', (route) => {
    preferences = route.request().postDataJSON();
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/customer', (route) =>
    interrupted
      ? route.fulfill({ status: 401, json: { code: 'access-changed' } })
      : route.fulfill({ json: { customer } }),
  );
  await page.goto('/customer-settings');
  if (phase === 3)
    await expect(page.getByLabel('Customer display name')).toHaveValue(
      'Fixture district',
    );
  return {
    setCustomer: (value: CustomerState | null) => {
      customer = value;
    },
    denyRead: () => {
      readable = false;
    },
    interrupt: () => {
      interrupted = true;
    },
    resume: () => {
      interrupted = false;
      csrf = 'b'.repeat(64);
    },
    commit: (receipt: CustomerSettingsReceipt) => {
      customer = {
        ...initial(),
        revision: receipt.revision,
        settings: receipt.settings,
        lastRequestId: receipt.requestId,
        onboarding: {
          ...initial().onboarding,
          settingsConfirmedAt: receipt.savedAt,
        },
      };
    },
  };
}

test('preserves the draft during a conflict and requires explicit revision review', async ({
  page,
}) => {
  const state = await fixture(page);
  const writes: unknown[] = [];
  await page.route('**/api/customer/settings', async (route) => {
    const input = customerSettingsWriteSchema.parse(
      route.request().postDataJSON(),
    );
    writes.push(input);
    if (writes.length === 1) {
      state.setCustomer({
        ...initial(),
        revision: 1,
        settings: { displayName: 'Another administrator' },
      });
      await route.fulfill({
        status: 409,
        json: { reason: 'revision-conflict' },
      });
    } else {
      expect(input.expectedRevision).toBe(1);
      const receipt = {
        ...input,
        revision: 2,
        savedAt: new Date().toISOString(),
      };
      const { requestId, customerId, revision, savedAt, settings } = receipt;
      state.commit(receipt);
      await route.fulfill({
        status: 201,
        json: { requestId, customerId, revision, savedAt, settings },
      });
    }
  });
  await page.getByLabel('Customer display name').fill('My edited district');
  await page
    .getByRole('button', { name: 'Save customer settings', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Review the latest saved name' }),
  ).toBeVisible();
  await expect(page.getByLabel('Customer display name')).toHaveValue(
    'My edited district',
  );
  await expect(
    page.getByRole('button', { name: 'Save customer settings', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('Another administrator', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Keep my name and use latest revision' })
    .click();
  await expect(page.getByLabel('Customer display name')).toBeFocused();
  await page
    .getByRole('button', { name: 'Save customer settings', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Confirmed save receipt' }),
  ).toBeVisible();
  expect(writes).toHaveLength(2);
  await expect(page.getByRole('navigation')).toContainText(
    'My edited district',
  );
});

test('reloads a lost response and retries the exact request when no receipt exists', async ({
  page,
}) => {
  const state = await fixture(page);
  const writes: unknown[] = [];
  await page.route('**/api/customer/settings', async (route) => {
    const input = customerSettingsWriteSchema.parse(
      route.request().postDataJSON(),
    );
    writes.push(input);
    if (writes.length === 1) return route.abort('failed');
    expect(input).toEqual(writes[0]);
    const receipt = {
      requestId: input.requestId,
      customerId: input.customerId,
      settings: input.settings,
      revision: 1,
      savedAt: new Date().toISOString(),
    };
    state.commit(receipt);
    return route.fulfill({ status: 201, json: receipt });
  });
  await page.route('**/api/customer/receipts/*', (route) =>
    route.fulfill({ status: 404, json: { reason: 'receipt-not-found' } }),
  );
  await page.getByLabel('Customer display name').fill('Recover my name');
  await page
    .getByRole('button', { name: 'Save customer settings', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('save result is unknown');
  await page.reload();
  await expect(page.getByLabel('Customer display name')).toHaveValue(
    'Recover my name',
  );
  await expect(page.getByLabel('Customer display name')).toHaveAttribute(
    'readonly',
    'true',
  );
  await page.getByRole('button', { name: 'Check save receipt' }).click();
  await expect(page.getByRole('status')).toContainText(
    'No receipt is available yet',
  );
  await page.getByRole('button', { name: 'Retry same save' }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirmed save receipt' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) =>
        key.startsWith('cc.customer-settings'),
      ),
    ),
  ).toEqual([]);
});

test('recovers a committed receipt without another save', async ({ page }) => {
  const state = await fixture(page);
  let receipt: CustomerSettingsReceipt;
  let saves = 0;
  await page.route('**/api/customer/settings', async (route) => {
    saves++;
    const input = customerSettingsWriteSchema.parse(
      route.request().postDataJSON(),
    );
    receipt = {
      requestId: input.requestId,
      customerId: input.customerId,
      settings: input.settings,
      revision: 1,
      savedAt: new Date().toISOString(),
    };
    state.commit(receipt);
    await route.abort('failed');
  });
  await page.route('**/api/customer/receipts/*', (route) =>
    route.fulfill({ json: receipt }),
  );
  await page.getByLabel('Customer display name').fill('Committed district');
  await page
    .getByRole('button', { name: 'Save customer settings', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('save result is unknown');
  await page.reload();
  await page.getByRole('button', { name: 'Check save receipt' }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirmed save receipt' }),
  ).toBeVisible();
  expect(saves).toBe(1);
  await expect(
    page.getByRole('heading', { name: 'Confirmed save receipt' }),
  ).toBeFocused();
  await page.reload();
  await page.getByLabel('Customer display name').fill('Draft after reload');
  await page.getByRole('button', { name: 'View latest save receipt' }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirmed save receipt' }),
  ).toBeFocused();
  await expect(page.getByLabel('Customer display name')).toHaveValue(
    'Draft after reload',
  );
});

test('preserves ordinary input through offline refresh and renewed access', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByLabel('Customer display name').fill('Unsaved local name');
  const unavailable = (route: import('@playwright/test').Route) =>
    route.abort('internetdisconnected');
  await page.route('**/api/customer', unavailable);
  await page.getByRole('button', { name: 'Refresh saved settings' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Saved customer settings are unavailable',
  );
  await expect(page.getByLabel('Customer display name')).toHaveValue(
    'Unsaved local name',
  );
  await expect(
    page.getByRole('button', { name: 'Save customer settings', exact: true }),
  ).toBeDisabled();
  await page.unroute('**/api/customer', unavailable);
  state.interrupt();
  await page.getByRole('button', { name: 'Refresh saved settings' }).click();
  await expect(
    page.getByRole('button', { name: 'Recheck access' }),
  ).toBeVisible();
  state.resume();
  await page.getByRole('button', { name: 'Recheck access' }).click();
  await expect(page.getByLabel('Customer display name')).toHaveValue(
    'Unsaved local name',
  );
  await expect(
    page.getByRole('button', { name: 'Save customer settings', exact: true }),
  ).toBeEnabled();
});

test('shows read-only settings and excludes the page from Phase 2', async ({
  page,
}) => {
  await fixture(page, false);
  await expect(page.getByLabel('Customer display name')).toHaveAttribute(
    'readonly',
    'true',
  );
  await expect(
    page.getByRole('button', { name: 'Save customer settings', exact: true }),
  ).toBeDisabled();
  await fixture(page, false, 2);
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole('link', { name: 'Customer settings' }),
  ).toHaveCount(0);
});

test('supports keyboard editing, both themes, narrow screens, and zoom', async ({
  page,
}) => {
  await fixture(page);
  const name = page.getByLabel('Customer display name');
  await name.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Keyboard district');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Save customer settings', exact: true }),
  ).toBeFocused();
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitem', { name: `Use ${theme} theme` }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('mat-label')).toHaveCSS(
      'color',
      theme === 'dark' ? 'rgb(154, 160, 166)' : 'rgb(95, 99, 104)',
    );
    for (const item of await page.locator('.card li').all())
      await expect(item).toHaveCSS(
        'color',
        theme === 'dark' ? 'rgb(232, 234, 237)' : 'rgb(32, 33, 36)',
      );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
  for (const [width, zoom] of [
    [1280, '2'],
    [320, '1'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((zoom) => {
      document.body.style.zoom = zoom;
    }, zoom);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  }
  await expect(name).toHaveValue('Keyboard district');
});

test('explains revoked read access after session recovery', async ({
  page,
}) => {
  const state = await fixture(page);
  state.interrupt();
  await page.getByRole('button', { name: 'Refresh saved settings' }).click();
  await expect(
    page.getByRole('button', { name: 'Recheck access' }),
  ).toBeVisible();
  state.denyRead();
  state.resume();
  await page.getByRole('button', { name: 'Recheck access' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Your current access does not permit customer settings',
  );
  await expect(
    page.getByRole('link', { name: 'Return to your account' }),
  ).toBeVisible();
  await expect(page.getByLabel('Customer display name')).toHaveCount(0);
});

test('associates custom validation with the customer name', async ({
  page,
}) => {
  await fixture(page);
  const input = page.getByLabel('Customer display name');
  await input.fill('   ');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAttribute('aria-describedby', /name-error/);
  await expect(page.locator('#name-error')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save customer settings', exact: true }),
  ).toBeDisabled();
  await input.fill('Valid district');
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await expect(page.locator('#name-error')).toHaveCount(0);
});
