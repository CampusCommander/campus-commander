import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installLiveStreams } from './live-streams';

/**
 * Card K18: the category editor dialog (CA states 02 to 08, 10, and 12).
 *
 * The mocked API answers the plan and confirm routes of K15 and the category job of the
 * dialog read. The browser suite proves the dialog, its errors, its locks, the review,
 * the save, the result, the delete question, the limit, and the visibility note.
 */

const customerId = 'C0123456';
// The hand-off run points UM_SHOTS at the profile scratch folder. The default keeps
// screenshots under the ignored dist folder, never under a tracked worktree path.
const scratch =
  process.env['UM_SHOTS'] ?? '../../dist/.playwright/frontend-e2e/um-k18-shots';
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
  displayName: 'District operator',
};

interface FieldFixture {
  fieldId: string;
  fieldName: string;
  displayName: string;
  fieldType: 'STRING' | 'INT64' | 'BOOL';
  multiValued: boolean;
  indexed: boolean;
  readAccessType: 'ALL_DOMAIN_USERS' | 'ADMINS_AND_SELF';
  numericIndexingSpec: null;
  holders: number;
}

const studentFields: FieldFixture[] = [
  {
    fieldId: 'Student.GradeLevel',
    fieldName: 'GradeLevel',
    displayName: 'Grade level',
    fieldType: 'INT64',
    multiValued: false,
    indexed: true,
    readAccessType: 'ALL_DOMAIN_USERS',
    numericIndexingSpec: null,
    holders: 4,
  },
  {
    fieldId: 'Student.Homeroom',
    fieldName: 'Homeroom',
    displayName: 'Homeroom',
    fieldType: 'STRING',
    multiValued: true,
    indexed: false,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
    holders: 4,
  },
];

const deviceFields: FieldFixture[] = [
  {
    fieldId: 'Device.TakeHome',
    fieldName: 'TakeHome',
    displayName: 'Take-home approved',
    fieldType: 'BOOL',
    multiValued: false,
    indexed: true,
    readAccessType: 'ALL_DOMAIN_USERS',
    numericIndexingSpec: null,
    holders: 3,
  },
];

const staffFields: FieldFixture[] = [
  {
    fieldId: 'Staff.Building',
    fieldName: 'Building',
    displayName: 'Building',
    fieldType: 'STRING',
    multiValued: false,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
    holders: 2,
  },
];

const categoryOf = (
  schemaName: string,
  displayName: string,
  fields: FieldFixture[],
) => ({
  schemaId: schemaName,
  schemaName,
  displayName,
  etag: `"${schemaName.toLowerCase()}-etag"`,
  fields,
  holders: Math.max(...fields.map((field) => field.holders)),
  readAt: observedAt,
});

const categories = {
  categories: [
    categoryOf('Student', 'Student information', studentFields),
    categoryOf('Device', 'Device program', deviceFields),
    categoryOf('Staff', 'Staff information', staffFields),
  ],
  limits: {
    categories: 3,
    categoryLimit: 100,
    attributes: 4,
    attributeLimit: 100,
  },
  observedAt,
};

/** The plan of the review: Add Counselor and Remove Homeroom (CA state 05). */
const editPlan = {
  planId,
  kind: 'edit-category',
  method: 'update',
  schemaId: 'Student',
  schemaName: 'Student',
  displayName: 'Student information',
  baseEtag: '"student-etag"',
  changes: [
    {
      change: 'added',
      fieldId: null,
      fieldName: 'Counselor',
      displayName: 'Counselor',
      properties: [],
      holders: null,
    },
    {
      change: 'removed',
      fieldId: 'Student.Homeroom',
      fieldName: 'Homeroom',
      displayName: 'Homeroom',
      properties: [],
      holders: 4,
    },
  ],
  phrase: 'Homeroom',
  limits: {
    categories: 3,
    categoryLimit: 100,
    attributes: 4,
    attributeLimit: 100,
  },
  preparedAt: at(0),
  expiresAt: new Date(now + 10 * 60_000).toISOString(),
  digest: 'a'.repeat(64),
};

interface MockState {
  /** The status of the category job that the dialog reads. */
  jobStatus: 'running' | 'completed' | 'failed';
  /** The failure of a failed job. */
  jobFailure: string | null;
  /** A refused job read (R9). */
  jobReadFailure: boolean;
  /** Overrides the category set (state 10 reads a full account). */
  categories: typeof categories;
  /** The plan answer. A 422 answer refuses the save (plan-changed or name-in-use). */
  plan: typeof editPlan | 'category-changed' | 'name-in-use';
  /** The plan requests, in order. */
  requests: unknown[];
  /** The stored theme preference (UI-10). */
  theme: 'light' | 'dark';
}

const state: MockState = {
  jobStatus: 'running',
  jobFailure: null,
  jobReadFailure: false,
  categories,
  plan: editPlan,
  requests: [],
  theme: 'light',
};

/** A held categories GET, so a close read can answer after the person moves on (R7). */
interface CategoryHold {
  /** Resolves when the held GET reaches the mock. */
  readonly requested: Promise<void>;
  /** Answers the held GET and lets later reads through. */
  release(): void;
}

let categoryHold: {
  readonly promise: Promise<void>;
  readonly requested: Promise<void>;
  readonly markRequested: () => void;
  readonly release: () => void;
} | null = null;

function holdCategoryRead(): CategoryHold {
  let answer!: () => void;
  const promise = new Promise<void>((resolve) => {
    answer = resolve;
  });
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const hold = {
    promise,
    requested,
    markRequested,
    release: () => {
      categoryHold = null;
      answer();
    },
  };
  categoryHold = hold;
  return hold;
}

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

async function signIn(page: Page) {
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
            preferences: { theme: state.theme, navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    if (path === '/api/users/sync') return route.fulfill({ json: { sync } });
    if (path === '/api/users/attribute-categories') {
      const hold = categoryHold;
      if (hold) {
        hold.markRequested();
        await hold.promise;
      }
      return route.fulfill({ json: state.categories });
    }
    if (path === '/api/users/attribute-categories/plans') {
      state.requests.push(request.postDataJSON());
      if (state.plan === 'name-in-use')
        return route.fulfill({
          status: 422,
          json: {
            reason: 'name-in-use',
            failure: 'name-in-use',
            message: 'A category with this name exists.',
          },
        });
      if (state.plan === 'category-changed')
        return route.fulfill({
          status: 422,
          json: {
            reason: 'category-changed',
            failure: 'category-changed',
            message: 'The category changed since the dialog opened.',
          },
        });
      return route.fulfill({ json: state.plan });
    }
    if (path === `/api/users/attribute-categories/plans/${planId}/confirm`) {
      state.requests.push(request.postDataJSON());
      return route.fulfill({
        status: 202,
        json: {
          jobId,
          displayId: 'CAT-003',
          status: 'accepted',
          action: 'edit-category',
          changeCount: 2,
        },
      });
    }
    if (path === '/api/jobs/CAT-003') {
      if (state.jobReadFailure) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({
        json: {
          jobId,
          displayId: 'CAT-003',
          revision: state.jobStatus === 'running' ? 2 : 4,
          action: 'edit-category',
          status: state.jobStatus,
          entityType: 'user',
          scope: { kind: 'rows', deviceCount: 1 },
          requestedBy: person,
          createdAt: at(1),
          startedAt: at(1),
          finishedAt: state.jobStatus === 'running' ? null : at(0),
          progress: {
            total: 1,
            succeeded: state.jobStatus === 'completed' ? 1 : 0,
            failed: state.jobStatus === 'failed' ? 1 : 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: state.jobStatus === 'running' ? 1 : 0,
          },
          phase: null,
          exportSummary: null,
          importSummary: null,
          failure: state.jobFailure,
          cancelRequest: null,
        },
      });
    }
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
async function openAttributes(page: Page, options: Partial<MockState> = {}) {
  Object.assign(state, {
    jobStatus: 'running',
    jobFailure: null,
    jobReadFailure: false,
    categories,
    plan: editPlan,
    requests: [],
    theme: 'light',
  });
  Object.assign(state, options);
  await signIn(page);
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
/** The dialog title. The hidden step heading repeats the words, so this locator is exact. */
const title = (page: Page) => dialog(page).locator('#category-editor-title');

async function openEditor(page: Page, category: string) {
  await page
    .getByRole('button', { name: `Edit category ${category}`, exact: true })
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

test('the tab offers Create category and the edit control to a manager (CA state 01)', async ({
  page,
}) => {
  await openAttributes(page);
  await expect(
    page.getByRole('button', { name: 'Create category', exact: true }),
  ).toBeVisible();
  // The row control opens the editor for a manager (choice 12 of design section 3).
  await expect(
    page.getByRole('button', {
      name: 'Edit category Student information',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open category Student information' }),
  ).toHaveCount(0);
  await shot(page, 'k18-01-tab-manager');
});

test('CA state 02: the create editor of a new category', async ({ page }) => {
  await openAttributes(page);
  const create = page.getByRole('button', {
    name: 'Create category',
    exact: true,
  });
  await expect(create).toBeVisible();
  await create.click();
  await expect(title(page)).toHaveText('Create category');
  // One empty attribute row, and Review changes waits for a change (state 02).
  await expect(
    dialog(page).getByLabel('Display name for attribute 1'),
  ).toBeVisible();
  await expect(
    dialog(page).getByRole('button', { name: 'Add attribute' }),
  ).toBeEnabled();
  await expect(
    dialog(page).getByRole('button', { name: 'Review changes' }),
  ).toBeEnabled();

  await fill(page, 'Display name', 'Transportation');
  // The category name follows the display name until a person edits it.
  await expect(dialog(page).getByLabel('Category name')).toHaveValue(
    'Transportation',
  );
  await fill(page, 'Display name for attribute 1', 'Bus route');
  await expect(
    dialog(page).getByLabel('Attribute name for attribute 1'),
  ).toHaveValue('BusRoute');
  await expect(
    dialog(page).getByRole('button', { name: 'Add attribute' }),
  ).toBeEnabled();
  await dialog(page).getByRole('button', { name: 'Add attribute' }).click();
  await fill(page, 'Display name for attribute 2', 'Stop name');
  await dialog(page).getByRole('button', { name: 'Add attribute' }).click();
  await fill(page, 'Display name for attribute 3', 'Rider');
  await dialog(page).getByLabel('Info type for attribute 3').click();
  await page.getByRole('option', { name: 'Yes or no', exact: true }).click();
  await expect(
    dialog(page).getByRole('button', { name: 'Review changes' }),
  ).toBeEnabled();
  await shot(page, 'k18-02-create-category');
});

test('CA state 03: the field errors and the C2 repeated display name', async ({
  page,
}) => {
  await openAttributes(page);
  await page
    .getByRole('button', { name: 'Create category', exact: true })
    .click();
  await fill(page, 'Display name', 'Transportation');
  await fill(page, 'Display name for attribute 1', 'Bus route');
  await dialog(page).getByRole('button', { name: 'Add attribute' }).click();
  await fill(page, 'Display name for attribute 2', 'Stop name');
  // The attribute name breaks the rule of the field.
  await fill(page, 'Attribute name for attribute 2', 'Stop #');
  await dialog(page).getByRole('button', { name: 'Add attribute' }).click();
  await fill(page, 'Display name for attribute 3', 'Rider');
  await fill(page, 'Attribute name for attribute 3', 'Rider');
  await dialog(page).getByRole('button', { name: 'Add attribute' }).click();
  await fill(page, 'Display name for attribute 4', 'Rider');
  await fill(page, 'Attribute name for attribute 4', 'Rider');

  await dialog(page).getByRole('button', { name: 'Review changes' }).click();
  // C2: the repeated display name names the rule (design section 3).
  await expect(
    dialog(page).getByText('Each attribute needs a unique display name.'),
  ).toBeVisible();
  await expect(
    dialog(page).getByText('Use letters, digits, _ and - only.'),
  ).toBeVisible();
  await expect(
    dialog(page).getByRole('button', { name: 'Review changes' }),
  ).toBeDisabled();
  await shot(page, 'k18-03-create-errors');
});

test('a changed derived name clears the server name refusal (R1)', async ({
  page,
}) => {
  await openAttributes(page, { plan: 'name-in-use' });
  await page
    .getByRole('button', { name: 'Create category', exact: true })
    .click();
  await fill(page, 'Display name', 'Transportation');
  await fill(page, 'Display name for attribute 1', 'Bus route');
  await dialog(page).getByRole('button', { name: 'Review changes' }).click();
  await expect(dialog(page)).toContainText('A category with this name exists.');
  const review = dialog(page).getByRole('button', { name: 'Review changes' });
  await expect(review).toBeDisabled();
  // Category name stays untouched; the display name derives a new candidate.
  await fill(page, 'Display name', 'New transportation');
  await expect(dialog(page).getByLabel('Category name')).toHaveValue(
    'NewTransportation',
  );
  await expect(dialog(page)).not.toContainText(
    'A category with this name exists.',
  );
  await expect(review).toBeEnabled();
});

test('CA state 04: the locks, the removal mark, and a new attribute', async ({
  page,
}) => {
  await openAttributes(page);
  await openEditor(page, 'Student information');
  // A kept name and info type are locked (B section 5).
  await expect(
    dialog(page).getByLabel('Attribute name for attribute 1'),
  ).toHaveCount(0);
  await expect(dialog(page).locator('#category-editor-sub')).toHaveText(
    'Student information',
  );
  await expect(
    dialog(page).getByLabel('Info type for attribute 1'),
  ).toHaveCount(0);
  // A multiple-values attribute cannot return to one value.
  const multi = dialog(page).getByRole('checkbox', {
    name: 'Multiple values for Homeroom',
  });
  await expect(multi).toBeDisabled();
  await expect(dialog(page)).toContainText('Cannot return to one value');

  await dialog(page)
    .getByRole('button', { name: 'Remove attribute Homeroom' })
    .click();
  await expect(dialog(page)).toContainText('Removes values from 4 users');
  await expect(dialog(page).locator('tr.is-removed .is-struck')).toHaveCount(3);
  await dialog(page).getByRole('button', { name: 'Add attribute' }).click();
  const last = dialog(page).getByLabel('Display name for attribute 2');
  await last.fill('Counselor');
  await last.blur();
  await expect(
    dialog(page).getByLabel('Info type for attribute 2'),
  ).toBeVisible();
  await expect(
    dialog(page).getByRole('button', { name: 'Keep attribute Homeroom' }),
  ).toBeVisible();
  await shot(page, 'k18-04-edit-category');
});

test('CA states 05 to 07: the review, the save, and the result', async ({
  page,
}) => {
  await openAttributes(page);
  await openEditor(page, 'Student information');
  await dialog(page)
    .getByRole('button', { name: 'Remove attribute Homeroom' })
    .click();
  await dialog(page).getByRole('button', { name: 'Add attribute' }).click();
  const counselor = dialog(page).getByLabel('Display name for attribute 2');
  await counselor.fill('Counselor');
  await counselor.blur();

  await dialog(page).getByRole('button', { name: 'Review changes' }).click();
  const table = dialog(page).getByRole('table', {
    name: 'Changes',
    exact: true,
  });
  await expect(table).toBeVisible();
  await expect(table).toContainText('Add attribute');
  await expect(table).toContainText('Counselor');
  await expect(table).toContainText('Remove attribute');
  await expect(table).toContainText('Homeroom');
  await expect(dialog(page)).toContainText(
    'The changes apply to every user in the domain.',
  );
  await expect(dialog(page)).toContainText(
    'Removing Homeroom deletes its values on 4 users. Nothing restores them.',
  );
  await expect(
    dialog(page).getByLabel('Type Homeroom to confirm'),
  ).toBeVisible();
  // The plan body names the edit with the cached etag.
  const planRequest = state.requests[0] as {
    kind: string;
    schemaId: string;
    baseEtag: string;
  };
  expect(planRequest.kind).toBe('edit-category');
  expect(planRequest.schemaId).toBe('Student');
  expect(planRequest.baseEtag).toBe('"student-etag"');
  await shot(page, 'k18-05-review-changes');

  // The save is refused until the typed phrase matches.
  const save = dialog(page).getByRole('button', { name: 'Save 2 changes' });
  await expect(save).toBeDisabled();
  await dialog(page).getByLabel('Type Homeroom to confirm').fill('Homeroom');
  await expect(save).toBeEnabled();
  await save.click();

  const saving = dialog(page).getByRole('list', { name: 'Progress' });
  await expect(saving).toBeVisible();
  await expect(saving).toContainText('Save changes in Google');
  await expect(saving).toContainText('Update cached users');
  await expect(dialog(page)).toContainText(
    'Closing this dialog keeps the save running.',
  );
  await expect(dialog(page)).toContainText('Job CAT-003');
  await shot(page, 'k18-06-saving');

  state.jobStatus = 'completed';
  await expect(dialog(page)).toContainText('Succeeded', { timeout: 8000 });
  await expect(dialog(page)).toContainText('Failed');
  await expect(
    dialog(page).getByRole('tab', { name: /All changes/ }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(dialog(page).getByRole('tab', { name: /Failed/ })).toBeVisible();
  await expect(dialog(page)).toContainText('Succeeded');
  await expect(dialog(page)).toContainText('Finished');
  await shot(page, 'k18-07-saved');

  // The Failed tab names the empty list (state 07).
  await dialog(page)
    .getByRole('tab', { name: /Failed/ })
    .click();
  await expect(dialog(page)).toContainText('No failed changes.');
  // The flow ends in the dialog; Esc returns the focus to the category control.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Edit category Student information',
      exact: true,
    }),
  ).toBeFocused();
});

test('CA state 08: the delete question with its typed name', async ({
  page,
}) => {
  await openAttributes(page);
  await openEditor(page, 'Device program');
  await dialog(page)
    .getByRole('button', { name: 'Delete category', exact: true })
    .click();
  await expect(title(page)).toHaveText('Delete category');
  await expect(dialog(page)).toContainText('Device program');
  // The words of state 08 stay as the mockup draws them (OQ3, "1) Keep").
  await expect(dialog(page)).toContainText(
    'Deletes Take-home approved values on 3 users.',
  );
  await expect(dialog(page)).toContainText(
    'The change applies to every user in the domain.',
  );
  const confirm = dialog(page).getByRole('button', {
    name: 'Delete category',
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await dialog(page)
    .getByLabel('Type Device program to confirm')
    .fill('Device');
  await expect(
    dialog(page).getByText('The phrase does not match. Type Device program.'),
  ).toBeVisible();
  await expect(confirm).toBeDisabled();
  // The matching phrase enables the destructive action (CA state 08).
  await dialog(page)
    .getByLabel('Type Device program to confirm')
    .fill('Device program');
  await expect(confirm).toBeEnabled();
  await shot(page, 'k18-08-delete-category');
  // Cancel returns to the editor of the same category (state 04).
  await dialog(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(title(page)).toHaveText('Edit category');
  await expect(
    dialog(page).getByLabel('Display name for attribute 1'),
  ).toBeVisible();
});

test('CA state 10: the attribute limit disables Add attribute', async ({
  page,
}) => {
  await openAttributes(page, {
    categories: {
      ...categories,
      limits: {
        categories: 3,
        categoryLimit: 100,
        attributes: 100,
        attributeLimit: 100,
      },
    },
  });
  await openEditor(page, 'Student information');
  await expect(
    dialog(page).getByRole('button', { name: 'Add attribute' }),
  ).toBeDisabled();
  await expect(dialog(page)).toContainText(
    '100 of 100 attributes used. Remove an attribute before you add one.',
  );
  await expect(
    dialog(page).getByRole('button', { name: 'Add attribute' }),
  ).toBeDisabled();
  await shot(page, 'k18-10-limit-reached');
});

test('CA state 12: the visibility change and its 24-hour note', async ({
  page,
}) => {
  await openAttributes(page);
  await openEditor(page, 'Student information');
  const visibility = dialog(page).getByLabel('Visibility for attribute 2');
  await visibility.click();
  await page
    .getByRole('option', { name: 'Everyone in the organization', exact: true })
    .click();
  await expect(
    dialog(page).getByText(
      'Google can take up to 24 hours to apply a visibility change.',
    ),
  ).toBeVisible();
  // The changed field draws the pending surface of the approved frame.
  await expect(
    dialog(page).locator('.mdc-text-field--outlined.is-changed, .is-changed'),
  ).toHaveCount(1);
  await shot(page, 'k18-12-visibility-change');
});

test('the plan refusal stays in the dialog with its reason (B section 13)', async ({
  page,
}) => {
  await openAttributes(page, { plan: 'category-changed' });
  await openEditor(page, 'Student information');
  await dialog(page).getByRole('button', { name: 'Add attribute' }).click();
  const row = dialog(page).getByLabel('Display name for attribute 3');
  await row.fill('Counselor');
  await row.blur();
  await dialog(page).getByRole('button', { name: 'Review changes' }).click();
  await expect(dialog(page)).toContainText(
    'Another change reached this category. Open it again.',
  );
  await expect(title(page)).toHaveText('Edit category');
});

test('CA state 03 on an edit: a repeated display name names the changed row (R2)', async ({
  page,
}) => {
  await openAttributes(page);
  await openEditor(page, 'Student information');
  const first = dialog(page).getByLabel('Display name for attribute 1');
  await first.fill(' HOMEROOM ');
  await first.blur();
  await dialog(page).getByRole('button', { name: 'Review changes' }).click();
  await expect(
    dialog(page).getByText('Each attribute needs a unique display name.'),
  ).toHaveCount(1);
  await expect(first).toHaveAttribute('aria-invalid', 'true');
  await expect(
    dialog(page).getByLabel('Display name for attribute 2'),
  ).not.toHaveAttribute('aria-invalid', 'true');
  await expect(
    dialog(page).getByRole('button', { name: 'Review changes' }),
  ).toBeDisabled();
  // The error sits below the control, not inside it.
  const invalid = dialog(page).locator('mat-form-field.field-invalid').first();
  await expect(invalid).toBeVisible();
  await expect(invalid.locator('.field-error')).toHaveCount(0);
  // A correction clears the rule and Review changes.
  await first.fill('Grade level');
  await first.blur();
  await expect(
    dialog(page).getByText('Each attribute needs a unique display name.'),
  ).toHaveCount(0);
});

test('CA state 04: the last attribute cannot be removed (R4)', async ({
  page,
}) => {
  await openAttributes(page);
  await openEditor(page, 'Staff information');
  await expect(
    dialog(page).getByRole('button', { name: 'Remove attribute Building' }),
  ).toBeDisabled();
  await expect(dialog(page)).toContainText(
    'A category needs one attribute. Delete the category instead.',
  );
});

test('CA state 08: the delete asks the cached category name after a rename (R5)', async ({
  page,
}) => {
  await openAttributes(page);
  await openEditor(page, 'Student information');
  await fill(page, 'Display name', 'Transportation');
  await dialog(page)
    .getByRole('button', { name: 'Delete category', exact: true })
    .click();
  await expect(
    dialog(page).getByLabel('Type Student information to confirm'),
  ).toBeVisible();
  const confirm = dialog(page).getByRole('button', {
    name: 'Delete category',
    exact: true,
  });
  await dialog(page)
    .getByLabel('Type Student information to confirm')
    .fill('Transportation');
  await expect(confirm).toBeDisabled();
  await expect(dialog(page)).toContainText(
    'The phrase does not match. Type Student information.',
  );
  await dialog(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(
    dialog(page).getByLabel('Display name', { exact: true }),
  ).toHaveValue('Transportation');
});

test('a close whose row the list dropped returns the focus to Create category (R7)', async ({
  page,
}) => {
  await openAttributes(page);
  await openEditor(page, 'Student information');
  // The schema change removes the row while the dialog is open.
  state.categories = {
    ...categories,
    categories: categories.categories.filter(
      (item) => item.schemaId !== 'Student',
    ),
    limits: {
      categories: 2,
      categoryLimit: 100,
      attributes: 2,
      attributeLimit: 100,
    },
  };
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Edit category Student information' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Create category', exact: true }),
  ).toBeFocused();
});

test('a create from the empty state returns focus to the toolbar control (R7)', async ({
  page,
}) => {
  const emptyCategories = {
    categories: [],
    limits: {
      categories: 0,
      categoryLimit: 100,
      attributes: 0,
      attributeLimit: 100,
    },
    observedAt,
  };
  await openAttributes(page, { categories: emptyCategories });
  const create = page.getByRole('button', {
    name: 'Create category',
    exact: true,
  });
  await create.click();
  await expect(dialog(page)).toBeVisible();
  // The first category arrives while the dialog stays open; the empty state goes.
  state.categories = categories;
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('#create-category-empty')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Create category', exact: true }),
  ).toBeFocused();
});

test('a delayed close read leaves focus where the person moved it (R7)', async ({
  page,
}) => {
  await openAttributes(page);
  const edit = page.getByRole('button', {
    name: 'Edit category Student information',
    exact: true,
  });
  await edit.click();
  await expect(dialog(page)).toBeVisible();
  const hold = holdCategoryRead();
  await page.keyboard.press('Escape');
  await hold.requested;
  // The close returns the focus first; then the person moves it before the read answers.
  await expect(edit).toBeFocused();
  const help = page.getByRole('button', { name: 'Custom attributes help' });
  await help.focus();
  await expect(help).toBeFocused();
  const answered = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(
      '/api/users/attribute-categories',
    ),
  );
  hold.release();
  await answered;
  await page.waitForTimeout(250);
  await expect(help).toBeFocused();
});

test('a delayed close read cannot take focus from a successor dialog (R7)', async ({
  page,
}) => {
  await openAttributes(page);
  const edit = page.getByRole('button', {
    name: 'Edit category Student information',
    exact: true,
  });
  await edit.click();
  await expect(dialog(page)).toBeVisible();
  const hold = holdCategoryRead();
  await page.keyboard.press('Escape');
  await hold.requested;
  await expect(edit).toBeFocused();
  // Create category opens before the older close read answers.
  await page
    .getByRole('button', { name: 'Create category', exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
  const display = dialog(page).getByLabel('Display name', { exact: true });
  await display.click();
  await expect(display).toBeFocused();
  const answered = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(
      '/api/users/attribute-categories',
    ),
  );
  hold.release();
  await answered;
  await page.waitForTimeout(250);
  await expect(display).toBeFocused();
  await expect(dialog(page)).toBeVisible();
});

test('CA state 06: a refused job read points at the job page (R9)', async ({
  page,
}) => {
  await openAttributes(page, { jobReadFailure: true });
  await openEditor(page, 'Student information');
  await dialog(page).getByRole('button', { name: 'Add attribute' }).click();
  const row = dialog(page).getByLabel('Display name for attribute 3');
  await row.fill('Counselor');
  await row.blur();
  await dialog(page).getByRole('button', { name: 'Review changes' }).click();
  await dialog(page).getByLabel('Type Homeroom to confirm').fill('Homeroom');
  await dialog(page).getByRole('button', { name: 'Save 2 changes' }).click();
  await expect(dialog(page)).toContainText(
    'The save continues. This dialog cannot read the result. Close the dialog and open the job.',
    { timeout: 8000 },
  );
  await expect(dialog(page)).toContainText('Job CAT-003');
});

test('Escape closes the create editor and returns the focus (UI-09)', async ({
  page,
}) => {
  await openAttributes(page);
  const create = page.getByRole('button', {
    name: 'Create category',
    exact: true,
  });
  await create.click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(create).toBeFocused();
  await expect(
    page.getByRole('tab', { name: 'Custom attributes', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
});

test('the editor keeps its surfaces in the dark theme (UI-10)', async ({
  page,
}) => {
  await openAttributes(page, { theme: 'dark' });
  await page
    .getByRole('button', { name: 'Create category', exact: true })
    .click();
  await expect(title(page)).toHaveText('Create category');
  // The dialog reads on the dark surface with the same controls.
  await expect(
    dialog(page).getByLabel('Display name for attribute 1'),
  ).toBeVisible();
  await shot(page, 'k18-13-create-dark');
});
