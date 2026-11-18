import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installLiveStreams } from './live-streams';

/**
 * Card K17: the Custom attributes tab and the read-only category dialog.
 *
 * The mocked API answers the category read of B section 10 row 1 and the Refresh of
 * B section 9. The three states of the approved frames are: 01 the category list,
 * 09 the read-only dialog, and 11 the empty state.
 */

const customerId = 'C0123456';
const scratch = process.env['UM_SHOTS'] ?? 'test-results/um-k17-shots';
test.beforeAll(() => mkdirSync(scratch, { recursive: true }));

const now = Date.now();
const at = (hoursAgo: number) =>
  new Date(now - hoursAgo * 3_600_000).toISOString();
const observedAt = at(2);

const grants = [
  { action: 'users:read', scope: { kind: 'district', customerId } },
  { action: 'connection:diagnose', scope: { kind: 'district', customerId } },
];

const categories = {
  categories: [
    {
      schemaId: 'schema-student',
      schemaName: 'Student',
      displayName: 'Student information',
      etag: '"student-etag"',
      fields: [
        {
          fieldId: 'Student.grade_level',
          fieldName: 'grade_level',
          displayName: 'Grade level',
          fieldType: 'INT64',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: { minValue: 0, maxValue: 13 },
          holders: 4,
        },
        {
          fieldId: 'Student.homeroom',
          fieldName: 'homeroom',
          displayName: 'Homeroom',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ADMINS_AND_SELF',
          numericIndexingSpec: null,
          holders: 4,
        },
      ],
      holders: 4,
      readAt: observedAt,
    },
    {
      schemaId: 'schema-device',
      schemaName: 'Device',
      displayName: 'Device program',
      etag: '"device-etag"',
      fields: [
        {
          fieldId: 'Device.take_home',
          fieldName: 'take_home',
          displayName: 'Take-home approved',
          fieldType: 'BOOL',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 3,
        },
      ],
      holders: 3,
      readAt: observedAt,
    },
    {
      schemaId: 'schema-staff',
      schemaName: 'Staff',
      displayName: 'Staff information',
      etag: '"staff-etag"',
      fields: [
        {
          fieldId: 'Staff.building',
          fieldName: 'building',
          displayName: 'Building',
          fieldType: 'STRING',
          multiValued: true,
          indexed: false,
          readAccessType: 'ADMINS_AND_SELF',
          numericIndexingSpec: null,
          holders: 2,
        },
      ],
      holders: 2,
      readAt: observedAt,
    },
  ],
  limits: {
    categories: 3,
    categoryLimit: 100,
    attributes: 4,
    attributeLimit: 100,
  },
  observedAt,
};

/** The refreshed set: one more category, read now (B section 9). */
const refreshed = {
  categories: [
    ...categories.categories,
    {
      schemaId: 'schema-transport',
      schemaName: 'Transportation',
      displayName: 'Transportation',
      etag: '"transport-etag"',
      fields: [
        {
          fieldId: 'Transportation.route',
          fieldName: 'route',
          displayName: 'Route',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 1,
        },
      ],
      holders: 1,
      readAt: at(0),
    },
  ],
  limits: {
    categories: 4,
    categoryLimit: 100,
    attributes: 5,
    attributeLimit: 100,
  },
  observedAt: at(0),
};

const rows = [
  {
    userId: '110000000000000000001',
    primaryEmail: 'aaliyah.brooks@example.org',
    orgUnitPath: '/Students/High School',
    givenName: 'Aaliyah',
    familyName: 'Brooks',
    fullName: 'Aaliyah Brooks',
    suspended: false,
    suspensionReason: null,
    archived: false,
    lastLoginTime: at(1),
    creationTime: at(24 * 400),
    twoStepEnrolled: true,
    department: null,
    title: null,
    aliases: [],
    customSchemas: { Student: { grade_level: '11', homeroom: '118' } },
    lastEntitySync: observedAt,
    stale: false,
    recordVersion: 1,
  },
];

const sync = {
  customerId,
  generation: 1,
  status: 'ready',
  observedAt,
  userCount: rows.length,
  failure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
};

interface MockOptions {
  /** The category read and the Refresh answer this failure (R11). */
  categoriesFail?: boolean;
  /** The category read answers no category (CA state 11). */
  emptyCategories?: boolean;
  /** The stored theme preference. */
  theme?: 'system' | 'light' | 'dark';
}

async function signIn(page: Page, options: MockOptions = {}) {
  await installLiveStreams(page);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
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
            displayName: 'District operator',
            permissionVersion: 1,
            permissions: [],
            grants,
            preferences: {
              theme: options.theme ?? 'light',
              navigationCollapsed: false,
            },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    if (path === '/api/users/sync') return route.fulfill({ json: { sync } });
    if (path === '/api/users/attribute-categories') {
      if (options.categoriesFail)
        return route.fulfill({
          status: 503,
          json: {
            reason: 'user-schema-read-failed',
            failure: 'scope-mismatch',
          },
        });
      return route.fulfill({
        json: options.emptyCategories
          ? {
              categories: [],
              limits: {
                categories: 0,
                categoryLimit: 100,
                attributes: 0,
                attributeLimit: 100,
              },
              observedAt: null,
            }
          : categories,
      });
    }
    if (path === '/api/users/attribute-categories/refresh') {
      if (options.categoriesFail)
        return route.fulfill({
          status: 503,
          json: {
            reason: 'user-schema-read-failed',
            failure: 'scope-mismatch',
          },
        });
      return route.fulfill({ json: refreshed });
    }
    if (path === '/api/users/org-units')
      return route.fulfill({ json: { orgUnits: [] } });
    if (path === '/api/users/query')
      return route.fulfill({
        json: {
          page: {
            rows,
            matching: rows.length,
            total: rows.length,
            observedAt,
            refreshJobId: null,
          },
        },
      });
    if (path === '/api/users/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (path === '/api/users/selection')
      return route.fulfill({
        json: {
          selection: {
            terms: [{ type: 'all', predicates: [] }],
            added: 0,
            excluded: 0,
            selectedCount: 0,
            expiredAt: null,
          },
        },
      });
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (path === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (path === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    if (path === '/api/jobs/activity')
      return route.fulfill({ json: { summary: null } });
    if (path === '/api/auth/preferences')
      return route.fulfill({ json: request.postDataJSON() });
    return route.fulfill({ status: 404, json: {} });
  });
}

/** Opens the Users page and the Custom attributes tab of a 1440 x 900 viewport. */
async function openAttributes(page: Page, options: MockOptions = {}) {
  await signIn(page, options);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/users');
  await expect(
    page.getByRole('heading', { name: 'Users', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('tab', { name: 'Custom attributes', exact: true })
    .click();
  await page.evaluate(() => document.fonts.ready);
}

const table = (page: Page) =>
  page.getByRole('table', { name: 'Categories', exact: true });

/** Waits out the tab ink-bar animation and clears the pointer state before a capture. */
async function settle(page: Page) {
  await page.mouse.move(8, 892);
  await page.waitForTimeout(400);
}

test('CA state 01: the category list without the Last changed column', async ({
  page,
}) => {
  await openAttributes(page);
  await expect(
    page.getByRole('tab', { name: 'Custom attributes', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByText('3 of 100 categories used · 4 of 100 attributes used'),
  ).toBeVisible();
  // Default 2 drops the Last changed column.
  await expect(
    page.getByRole('columnheader', { name: 'Last changed' }),
  ).toHaveCount(0);
  const headers = await table(page).getByRole('columnheader').count();
  expect(headers).toBe(4);
  for (const name of [
    'Category',
    'Category name',
    'Attributes',
    'Users with values',
  ]) {
    await expect(
      table(page).getByRole('columnheader', { name, exact: true }),
    ).toHaveCount(1);
  }
  // The order is the display name, not the order of the read.
  const names = await table(page)
    .locator('tbody tr td:first-child')
    .allTextContents();
  expect(names.map((text) => text.trim())).toEqual([
    'Device program',
    'Staff information',
    'Student information',
  ]);
  await expect(
    table(page).getByRole('row', { name: /Student information/ }),
  ).toContainText('4');
  // Interim: no Create category before card K18.
  await expect(
    page.getByRole('button', { name: 'Create category' }),
  ).toHaveCount(0);
  await settle(page);
  await page.screenshot({
    path: `${scratch}/k17-01-categories-list.png`,
    fullPage: false,
  });
});

test('CA state 01 in the dark theme keeps the same surfaces (UI-10)', async ({
  page,
}) => {
  await openAttributes(page, { theme: 'dark' });
  await expect(
    page.getByText('3 of 100 categories used · 4 of 100 attributes used'),
  ).toBeVisible();
  await expect(
    table(page).getByRole('button', { name: 'Open category Device program' }),
  ).toBeVisible();
  await settle(page);
  await page.screenshot({
    path: `${scratch}/k17-01-categories-list-dark.png`,
    fullPage: false,
  });
});

test('CA state 09: the read-only category dialog', async ({ page }) => {
  await openAttributes(page);
  const link = page.getByRole('button', {
    name: 'Open category Student information',
  });
  await link.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('heading', { name: 'Student information', exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText('Display name');
  await expect(dialog).toContainText('Student');
  await expect(dialog).toContainText('Grade level');
  await expect(dialog).toContainText('Whole number');
  await expect(dialog).toContainText('Admins and the user');
  await expect(dialog).toContainText('Everyone in the organization');
  // Every value is a plain cell, and the yes-or-no boxes are disabled.
  await expect(
    dialog.getByRole('checkbox', { name: 'Multiple values for Grade level' }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('checkbox', { name: 'Searchable Grade level' }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('checkbox', { name: 'Multiple values for Homeroom' }),
  ).toBeDisabled();
  // No category action draws for a person without User Schema Manage (choice 12).
  await expect(
    dialog.getByRole('button', { name: 'Delete category' }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Create category' }),
  ).toHaveCount(0);
  const add = dialog.getByRole('button', { name: 'Add attribute' });
  await expect(add).toBeDisabled();
  await expect(dialog).toContainText(
    'Requires the User Schema Manage permission.',
  );
  // The dialog takes the focus, so a screen reader starts at its title.
  await expect(
    dialog.getByRole('heading', { name: 'Student information', exact: true }),
  ).toBeFocused();
  await page.mouse.move(8, 892);
  await page.waitForTimeout(400);
  await page.screenshot({
    path: `${scratch}/k17-09-read-only.png`,
    fullPage: false,
  });
  // UI-09: the focus returns to the opening control.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(link).toBeFocused();
  await expect(
    page.getByRole('tab', { name: 'Custom attributes', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
});

test('CA state 11: the empty state of a domain without a category', async ({
  page,
}) => {
  await openAttributes(page, { emptyCategories: true });
  await expect(page.getByText('No categories yet')).toBeVisible();
  await expect(
    page.getByText(
      'Google Workspace holds no custom attribute categories for this domain.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText('0 of 100 categories used · 0 of 100 attributes used'),
  ).toBeVisible();
  await expect(table(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Create category' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await settle(page);
  await page.screenshot({
    path: `${scratch}/k17-11-empty.png`,
    fullPage: false,
  });
});

test('Refresh reads Google again and the list takes the new set (B section 9)', async ({
  page,
}) => {
  await openAttributes(page);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByText('4 of 100 categories used · 5 of 100 attributes used'),
  ).toBeVisible();
  await expect(
    table(page).getByRole('row', { name: /Transportation/ }),
  ).toBeVisible();
});

test('a missing schema scope names the fix and keeps the Users tab', async ({
  page,
}) => {
  await openAttributes(page, { categoriesFail: true });
  await expect(
    page.getByRole('heading', {
      name: 'Custom attribute categories are unavailable',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(
    'Custom attribute categories are unavailable. Add',
  );
  await expect(page.getByRole('alert')).toContainText(
    'https://www.googleapis.com/auth/admin.directory.userschema.readonly',
  );
  await expect(
    page.getByRole('link', { name: 'Open Google connection' }),
  ).toBeVisible();
  // The failure stays in the tab: the Users view still lists the directory.
  await page.getByRole('tab', { name: 'Users', exact: true }).click();
  await expect(
    page.getByRole('gridcell', { name: 'Aaliyah Brooks', exact: true }),
  ).toBeVisible();
});
