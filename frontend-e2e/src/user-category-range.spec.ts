import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installLiveStreams } from './live-streams';

/**
 * Card K19: the number range inputs (CA states 13, 14, and 15).
 *
 * The mocked API answers the category read, the plan route of K15, the confirm,
 * and the category job. The browser suite proves the range line under each number
 * row, the pending look of a changed bound, the two errors of state 14, and the
 * review row of state 15. It also asserts the plan body that a saved range sends.
 */

const customerId = 'C0123456';
// The hand-off run points UM_SHOTS at the profile scratch folder. The default keeps
// screenshots under the ignored dist folder, never under a tracked worktree path.
const scratch =
  process.env['UM_SHOTS'] ?? '../dist/.playwright/frontend-e2e/um-k19-shots';
test.beforeAll(() => mkdirSync(scratch, { recursive: true }));

const now = Date.now();
const at = (minutesAgo: number) =>
  new Date(now - minutesAgo * 60_000).toISOString();
const observedAt = at(30);
const planId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';

const grants = [
  { action: 'users:read', scope: { kind: 'district', customerId } },
  { action: 'users:schema-manage', scope: { kind: 'district', customerId } },
];

const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'Review administrator',
};

interface FieldFixture {
  fieldId: string;
  fieldName: string;
  displayName: string;
  fieldType: 'STRING' | 'INT64' | 'BOOL';
  multiValued: boolean;
  indexed: boolean;
  readAccessType: 'ALL_DOMAIN_USERS' | 'ADMINS_AND_SELF';
  numericIndexingSpec: {
    minValue: number | null;
    maxValue: number | null;
  } | null;
  holders: number;
}

/** The five attributes of Student information in the approved mockup. */
const studentFields: FieldFixture[] = [
  {
    fieldId: 'Student.StudentId',
    fieldName: 'StudentId',
    displayName: 'Student ID',
    fieldType: 'STRING',
    multiValued: false,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
    holders: 4,
  },
  {
    fieldId: 'Student.GradeLevel',
    fieldName: 'GradeLevel',
    displayName: 'Grade level',
    fieldType: 'INT64',
    multiValued: false,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
    holders: 4,
  },
  {
    fieldId: 'Student.GraduationYear',
    fieldName: 'GraduationYear',
    displayName: 'Graduation year',
    fieldType: 'INT64',
    multiValued: false,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
    holders: 3,
  },
  {
    fieldId: 'Student.Homeroom',
    fieldName: 'Homeroom',
    displayName: 'Homeroom',
    fieldType: 'STRING',
    multiValued: false,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
    holders: 4,
  },
  {
    fieldId: 'Student.Programs',
    fieldName: 'Programs',
    displayName: 'Programs',
    fieldType: 'STRING',
    multiValued: true,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
    holders: 2,
  },
];

const categories = {
  categories: [
    {
      schemaId: 'Student',
      schemaName: 'StudentInfo',
      displayName: 'Student information',
      etag: '"student-etag"',
      fields: studentFields,
      holders: 4,
      readAt: observedAt,
    },
  ],
  limits: {
    categories: 3,
    categoryLimit: 100,
    attributes: 10,
    attributeLimit: 100,
  },
  observedAt,
};

/** The plan of a range-only edit (composition choice 8). */
const rangePlan = {
  planId,
  kind: 'edit-category',
  method: 'update',
  schemaId: 'Student',
  schemaName: 'StudentInfo',
  displayName: 'Student information',
  baseEtag: '"student-etag"',
  changes: [
    {
      change: 'changed',
      fieldId: 'Student.GradeLevel',
      fieldName: 'GradeLevel',
      displayName: 'Grade level',
      properties: ['numericIndexingSpec'],
      holders: null,
    },
  ],
  phrase: null,
  limits: {
    categories: 1,
    categoryLimit: 100,
    attributes: 5,
    attributeLimit: 100,
  },
  preparedAt: at(0),
  expiresAt: new Date(now + 10 * 60_000).toISOString(),
  digest: 'a'.repeat(64),
};

const sync = {
  customerId,
  generation: 1,
  status: 'ready',
  observedAt,
  userCount: 0,
  failure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
};

interface MockState {
  /** The plan requests, in order. */
  requests: unknown[];
  /** The confirm bodies, in order. */
  confirmations: unknown[];
}

const state: MockState = { requests: [], confirmations: [] };

async function signIn(page: Page, theme: 'light' | 'dark' = 'light') {
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
            id: person.id,
            displayName: person.displayName,
            permissionVersion: 1,
            permissions: [],
            grants,
            preferences: { theme, navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    if (path === '/api/users/sync') return route.fulfill({ json: { sync } });
    if (path === '/api/users/attribute-categories')
      return route.fulfill({ json: categories });
    if (path === '/api/users/attribute-categories/plans') {
      state.requests.push(request.postDataJSON());
      return route.fulfill({ json: rangePlan });
    }
    if (path === `/api/users/attribute-categories/plans/${planId}/confirm`) {
      state.confirmations.push(request.postDataJSON());
      return route.fulfill({
        status: 202,
        json: {
          jobId,
          displayId: 'CAT-019',
          status: 'accepted',
          action: 'edit-category',
          changeCount: 1,
        },
      });
    }
    if (path === '/api/jobs/CAT-019')
      return route.fulfill({
        json: {
          jobId,
          displayId: 'CAT-019',
          revision: 4,
          action: 'edit-category',
          status: 'completed',
          entityType: 'user',
          scope: { kind: 'rows', deviceCount: 1 },
          requestedBy: person,
          createdAt: at(1),
          startedAt: at(1),
          finishedAt: at(0),
          progress: {
            total: 1,
            succeeded: 1,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 0,
          },
          phase: null,
          exportSummary: null,
          importSummary: null,
          failure: null,
          cancelRequest: null,
        },
      });
    if (path === '/api/users/org-units')
      return route.fulfill({ json: { orgUnits: [] } });
    if (path === '/api/users/query')
      return route.fulfill({
        json: {
          page: {
            rows: [],
            matching: 0,
            total: 0,
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

/** Opens the Custom attributes tab at the approved 1440 x 900 viewport. */
async function openAttributes(page: Page, theme: 'light' | 'dark' = 'light') {
  state.requests = [];
  state.confirmations = [];
  await signIn(page, theme);
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

const dialog = (page: Page) => page.getByRole('dialog');
const title = (page: Page) => dialog(page).locator('#category-editor-title');

async function openEditor(page: Page) {
  await page
    .getByRole('button', {
      name: 'Edit category Student information',
      exact: true,
    })
    .click();
  await expect(dialog(page)).toBeVisible();
}

async function fill(page: Page, label: string, value: string) {
  const field = dialog(page).getByLabel(label, { exact: true });
  await field.fill(value);
  await field.blur();
}

/** Waits out the ink bar and clears the pointer state before a capture. */
async function settle(page: Page) {
  await page.mouse.move(8, 892);
  await page.waitForTimeout(400);
}

async function shot(page: Page, name: string) {
  await settle(page);
  await page.screenshot({ path: `${scratch}/${name}.png`, fullPage: false });
}

test('CA state 13: the range line under each number row, and state 15 review', async ({
  page,
}) => {
  await openAttributes(page);
  await openEditor(page);
  await expect(title(page)).toHaveText('Edit category');

  // A range line sits under each Whole number row and under no other row.
  await expect(
    dialog(page).getByLabel('Grade level minimum', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog(page).getByLabel('Grade level maximum', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog(page).getByLabel('Graduation year minimum', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog(page).getByLabel('Graduation year maximum', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog(page).getByLabel('Homeroom minimum', { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog(page).getByLabel('Student ID maximum', { exact: true }),
  ).toHaveCount(0);

  await fill(page, 'Grade level minimum', '0');
  await fill(page, 'Grade level maximum', '12');
  // Both changed bounds take the pending surface of composition choice 4.
  await expect(dialog(page).locator('mat-form-field.is-changed')).toHaveCount(
    2,
  );
  await expect(
    dialog(page).getByRole('button', { name: 'Review changes' }),
  ).toBeEnabled();
  await shot(page, 'k19-13-number-range');

  await dialog(page)
    .getByRole('button', { name: 'Review changes', exact: true })
    .click();
  const table = dialog(page).getByRole('table', {
    name: 'Changes',
    exact: true,
  });
  await expect(table).toBeVisible();
  await expect(dialog(page)).toContainText('1 change to Student information');

  // The plan request holds both bounds and no bound for the other number row.
  const request = state.requests[0] as {
    draft: {
      fields: {
        fieldId: string | null;
        numericIndexingSpec: unknown;
      }[];
    };
  };
  expect(
    request.draft.fields.find((field) => field.fieldId === 'Student.GradeLevel')
      ?.numericIndexingSpec,
  ).toEqual({ minValue: 0, maxValue: 12 });
  expect(
    request.draft.fields.find(
      (field) => field.fieldId === 'Student.GraduationYear',
    )?.numericIndexingSpec,
  ).toBeNull();

  await expect(table).toContainText('Set range');
  await expect(table).toContainText('Grade level 0 to 12');
  await expect(table).toContainText('No user values change');
  // Composition choice 9: a range change has no typed phrase gate.
  await expect(dialog(page).locator('input.removal-phrase')).toHaveCount(0);
  await expect(
    dialog(page).getByRole('button', { name: 'Save 1 change' }),
  ).toBeEnabled();
  await shot(page, 'k19-15-review-range');
});

test('CA state 14: the range field errors and the error count', async ({
  page,
}) => {
  await openAttributes(page);
  await openEditor(page);
  await fill(page, 'Grade level minimum', '12');
  await fill(page, 'Grade level maximum', '0');
  await fill(page, 'Graduation year minimum', '2026.5');

  await dialog(page)
    .getByRole('button', { name: 'Review changes', exact: true })
    .click();
  // State 14: one error on each field, in the pattern of state 03.
  await expect(
    dialog(page).getByText('Enter 12 or more.', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog(page).getByText('Enter a whole number.', { exact: true }),
  ).toBeVisible();
  await expect(dialog(page)).toContainText('2 fields have errors');
  await expect(
    dialog(page).getByLabel('Grade level maximum', { exact: true }),
  ).toHaveAttribute('aria-invalid', 'true');
  await expect(
    dialog(page).getByLabel('Grade level minimum', { exact: true }),
  ).not.toHaveAttribute('aria-invalid', 'true');
  await expect(
    dialog(page).getByLabel('Graduation year minimum', { exact: true }),
  ).toHaveAttribute('aria-invalid', 'true');
  await expect(
    dialog(page).getByRole('button', { name: 'Review changes' }),
  ).toBeDisabled();
  // The invalid draft never reaches the plan route.
  expect(state.requests).toHaveLength(0);
  await shot(page, 'k19-14-range-errors');
});

test('an invalid bound alone reaches its range error (R1)', async ({
  page,
}) => {
  await openAttributes(page);
  await openEditor(page);
  // Only the Minimum changes: no other edit enables Review (R1).
  await fill(page, 'Grade level minimum', '2026.5');
  const review = dialog(page).getByRole('button', { name: 'Review changes' });
  await expect(review).toBeEnabled();
  await review.click();
  await expect(
    dialog(page).getByText('Enter a whole number.', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog(page).getByLabel('Grade level minimum', { exact: true }),
  ).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog(page)).toContainText('1 field has errors');
  await expect(review).toBeDisabled();
  // The invalid draft never reaches the plan route.
  expect(state.requests).toHaveLength(0);
});

test('a bound leaves the editor when the info type stops being a number', async ({
  page,
}) => {
  await openAttributes(page);
  await page
    .getByRole('button', { name: 'Create category', exact: true })
    .click();
  await expect(title(page)).toHaveText('Create category');
  const type = dialog(page).getByRole('combobox', {
    name: 'Info type for attribute 1',
  });
  await type.click();
  await page.getByRole('option', { name: 'Whole number', exact: true }).click();
  await expect(
    dialog(page).getByLabel('Attribute 1 minimum', { exact: true }),
  ).toBeVisible();
  await type.click();
  await page.getByRole('option', { name: 'Text', exact: true }).click();
  await expect(
    dialog(page).getByLabel('Attribute 1 minimum', { exact: true }),
  ).toHaveCount(0);
});

test('the range line keeps its surfaces in the dark theme (UI-10)', async ({
  page,
}) => {
  await openAttributes(page, 'dark');
  await openEditor(page);
  await fill(page, 'Grade level minimum', '0');
  await fill(page, 'Grade level maximum', '12');
  await expect(
    dialog(page).getByLabel('Grade level minimum', { exact: true }),
  ).toBeVisible();
  await expect(dialog(page).locator('mat-form-field.is-changed')).toHaveCount(
    2,
  );
  await expect(
    dialog(page).getByRole('button', { name: 'Review changes' }),
  ).toBeEnabled();
  await shot(page, 'k19-13-number-range-dark');
});
