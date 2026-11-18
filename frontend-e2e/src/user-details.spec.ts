import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { userPageSchema } from '@campus/application-contracts';
import { installLiveStreams } from './live-streams';

// A rendered date and time reads in one zone on this machine and in another in CI.
test.use({ timezoneId: 'America/New_York' });

const customerId = 'C0123456';
// The hand-off screenshots land here. The default keeps the file inside the test output.
const scratch = process.env['UM_SHOTS'] ?? 'test-results/um-k11-shots';

test.beforeAll(() => mkdirSync(scratch, { recursive: true }));

const now = Date.now();
const at = (hoursAgo: number) =>
  new Date(now - hoursAgo * 3_600_000).toISOString();
const observedAt = at(2);
/** The moment that Google stopped returning the removed user (A section 11). */
const removedAt = at(3);

/** One time as the page renders it, in the zone that the spec pins. */
function shownTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });
}

const grants = [
  { action: 'users:read', scope: { kind: 'district', customerId } },
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'connection:diagnose', scope: { kind: 'district', customerId } },
];

interface FixtureUser {
  name: string;
  local: string;
  userId: string;
  orgUnitPath: string;
  lastLoginHoursAgo: number;
  twoStep: boolean;
  grade: number | null;
  homeroom: string;
  programs: string[];
  removedAt?: string;
}

const people: FixtureUser[] = [
  {
    name: 'Amara Okafor',
    local: 'amara.okafor',
    userId: '110000000000000000001',
    orgUnitPath: '/Students/High School',
    lastLoginHoursAgo: 28,
    twoStep: true,
    grade: 10,
    homeroom: '214',
    programs: ['Gifted', 'Band'],
  },
  {
    name: 'Ania Reyes',
    local: 'ania.reyes',
    userId: '110000000000000000002',
    orgUnitPath: '/Students/High School',
    lastLoginHoursAgo: 4,
    twoStep: true,
    grade: 11,
    homeroom: '216',
    programs: ['ESL'],
  },
  {
    name: 'Abdul Karim',
    local: 'abdul.karim',
    userId: '110000000000000000003',
    orgUnitPath: '/Students/Middle School',
    lastLoginHoursAgo: 30,
    twoStep: false,
    grade: 7,
    homeroom: 'M12',
    programs: [],
  },
  {
    name: 'Aaron Whitfield',
    local: 'aaron.whitfield',
    userId: '110000000000000000004',
    orgUnitPath: '/Staff/High School',
    lastLoginHoursAgo: 6,
    twoStep: true,
    grade: null,
    homeroom: '',
    programs: [],
  },
  {
    name: 'Dana Whitfield',
    local: 'dana.whitfield',
    userId: '110000000000000000005',
    orgUnitPath: '/Staff/High School',
    lastLoginHoursAgo: 52,
    twoStep: false,
    grade: null,
    homeroom: '',
    programs: [],
    removedAt,
  },
];

const rows = people.map((person) => {
  const student: Record<string, unknown> = {
    programs: person.programs.map((value) => ({ value })),
  };
  if (person.grade !== null) student['grade_level'] = String(person.grade);
  if (person.homeroom) student['homeroom'] = person.homeroom;
  return {
    userId: person.userId,
    primaryEmail: `${person.local}@example.org`,
    orgUnitPath: person.orgUnitPath,
    givenName: person.name.split(' ')[0],
    familyName: person.name.split(' ')[1],
    fullName: person.name,
    suspended: false,
    suspensionReason: null,
    archived: false,
    lastLoginTime: at(person.lastLoginHoursAgo),
    creationTime: '2023-08-14T16:00:00.000Z',
    twoStepEnrolled: person.twoStep,
    department: person.grade === null ? 'Administration' : null,
    title: person.grade === null ? 'Principal' : null,
    aliases: [],
    customSchemas: {
      Student: {
        student_id: person.userId.slice(-6),
        graduation_year: '2029',
        ...student,
      },
      ...(person.grade === null
        ? { Device: {} }
        : { Device: { take_home: true } }),
    },
    lastEntitySync: observedAt,
    stale: false,
    recordVersion: 1,
  };
});

/** The details answer of one user, with the record shape of the API. */
function detailOf(person: FixtureUser) {
  const row = rows.find((candidate) => candidate.userId === person.userId);
  return { user: { ...row, removedAt: person.removedAt ?? null } };
}

const categories = {
  categories: [
    {
      schemaId: 'schema-student',
      schemaName: 'Student',
      displayName: 'Student information',
      etag: '"student-etag"',
      fields: [
        {
          fieldId: 'Student.student_id',
          fieldName: 'student_id',
          displayName: 'Student ID',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 4,
        },
        {
          fieldId: 'Student.grade_level',
          fieldName: 'grade_level',
          displayName: 'Grade level',
          fieldType: 'INT64',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: { minValue: 0, maxValue: 12 },
          holders: 3,
        },
        {
          fieldId: 'Student.graduation_year',
          fieldName: 'graduation_year',
          displayName: 'Graduation year',
          fieldType: 'INT64',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 3,
        },
        {
          fieldId: 'Student.homeroom',
          fieldName: 'homeroom',
          displayName: 'Homeroom',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 3,
        },
        {
          fieldId: 'Student.programs',
          fieldName: 'programs',
          displayName: 'Programs',
          fieldType: 'STRING',
          multiValued: true,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 2,
        },
      ],
      holders: 4,
      readAt: observedAt,
    },
    {
      schemaId: 'schema-staff',
      schemaName: 'Staff',
      displayName: 'Staff information',
      etag: '"staff-etag"',
      fields: [
        {
          fieldId: 'Staff.employee_id',
          fieldName: 'employee_id',
          displayName: 'Employee ID',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 0,
        },
        {
          fieldId: 'Staff.building',
          fieldName: 'building',
          displayName: 'Building',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 0,
        },
        {
          fieldId: 'Staff.hire_date',
          fieldName: 'hire_date',
          displayName: 'Hire date',
          fieldType: 'DATE',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 0,
        },
        {
          fieldId: 'Staff.certifications',
          fieldName: 'certifications',
          displayName: 'Certifications',
          fieldType: 'STRING',
          multiValued: true,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 0,
        },
      ],
      holders: 0,
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
          holders: 4,
        },
      ],
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

/** The selection that the mocked API keeps for one test. */
const selectionState = {
  ids: new Set<string>(),
  terms: [] as unknown[],
};

function selectionSpec() {
  return {
    terms: selectionState.terms,
    added: 0,
    excluded: 0,
    selectedCount: selectionState.ids.size,
    expiredAt: null,
  };
}

/** The query answer follows a grade range and the selection, as the grid asks. */
function answerFor(body: any) {
  const predicates: any[] = body?.predicates ?? [];
  const grade = predicates.find(
    (item) => item.field === 'attribute' && item.fieldName === 'grade_level',
  );
  // A removed user stays out of rows and counts (A section 11).
  let matched = rows.filter(
    (row) => !people.find((person) => person.userId === row.userId)?.removedAt,
  );
  if (body?.selection)
    matched = matched.filter((row) => selectionState.ids.has(row.userId));
  if (grade)
    matched = matched.filter((row) => {
      const student = row.customSchemas['Student'] as
        | Record<string, unknown>
        | undefined;
      const value = Number(student?.['grade_level'] ?? -1);
      return value >= grade.from && value <= grade.to;
    });
  // The order of the grid decides the row index, so the answer follows the sort it sends.
  const sort = body?.sort ?? { field: 'fullName', direction: 'asc' };
  const sign = sort.direction === 'desc' ? -1 : 1;
  matched = [...matched].sort(
    (left, right) =>
      sign *
      String((left as Record<string, unknown>)[sort.field] ?? '').localeCompare(
        String((right as Record<string, unknown>)[sort.field] ?? ''),
      ),
  );
  const offset = Number(body?.offset ?? 0);
  const limit = Number(body?.limit ?? matched.length);
  return {
    page: userPageSchema.parse({
      rows: matched.slice(offset, offset + limit),
      matching: matched.length,
      total: rows.length - 1,
      observedAt,
      refreshJobId: null,
    }),
  };
}

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
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            displayName: 'Review administrator',
            permissionVersion: 1,
            permissions: [],
            grants,
            preferences: { theme: 'light', navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    if (path === '/api/users/sync') return route.fulfill({ json: { sync } });
    if (path === '/api/users/attribute-categories')
      return route.fulfill({ json: categories });
    if (path === '/api/users/org-units')
      return route.fulfill({
        json: {
          orgUnits: [
            { path: '/Students/High School', users: 2 },
            { path: '/Students/Middle School', users: 1 },
            { path: '/Staff/High School', users: 2 },
          ],
        },
      });
    if (path === '/api/users/query')
      return route.fulfill({ json: answerFor(request.postDataJSON()) });
    if (path === '/api/users/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (path === '/api/users/selection')
      return route.fulfill({ json: { selection: selectionSpec() } });
    if (path === '/api/users/selection/resolve') {
      const body = request.postDataJSON() ?? {};
      const selected: Record<string, boolean> = {};
      for (const id of body.rowIds ?? [])
        if (selectionState.ids.has(id)) selected[id] = true;
      return route.fulfill({ json: { selected } });
    }
    if (path === '/api/users/selection/ops') {
      const body = request.postDataJSON() ?? {};
      for (const op of body.ops ?? []) {
        if (op.op === 'selectAll') {
          selectionState.terms = [
            { type: 'all', predicates: op.predicates ?? [] },
          ];
          selectionState.ids = new Set(rows.map((row) => row.userId));
        } else if (op.op === 'select') {
          for (const id of op.ids ?? []) selectionState.ids.add(id);
        } else if (op.op === 'deselect') {
          for (const id of op.ids ?? []) selectionState.ids.delete(id);
        } else if (op.op === 'deselectAll') {
          selectionState.terms = [];
          selectionState.ids = new Set();
        }
      }
      return route.fulfill({ json: { selection: selectionSpec() } });
    }
    // One user, read by the details page. Any other path stays a 404.
    const single = /^\/api\/users\/([^/]+)$/.exec(path);
    if (single) {
      const person = people.find(
        (candidate) => candidate.userId === decodeURIComponent(single[1]),
      );
      return person
        ? route.fulfill({ json: detailOf(person) })
        : route.fulfill({ status: 404, json: { reason: 'user-not-found' } });
    }
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

async function openUsers(page: Page) {
  selectionState.ids = new Set();
  selectionState.terms = [];
  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/users');
  await expect(
    page.getByRole('heading', { name: 'Users', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'Amara Okafor', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** The details control of one row (GRID-03). */
function detailsControl(page: Page, name: string): Locator {
  return page.getByRole('button', { name: `Open details for ${name}` });
}

/** A layout box, or a failure when the element has none. */
function measured(
  box: { x: number; y: number; width: number; height: number } | null,
) {
  if (!box) throw new Error('The element has no layout box.');
  return box;
}

test('reproduces UM state 04: the user details page', async ({ page }) => {
  await openUsers(page);
  await detailsControl(page, 'Amara Okafor').click();
  await expect(
    page.getByRole('heading', { name: 'Amara Okafor', exact: true }),
  ).toBeVisible();
  // The link leaves the page, so the details page starts focus at its heading (UI-09).
  await expect(
    page.getByRole('heading', { name: 'Amara Okafor', exact: true }),
  ).toBeFocused();
  await expect(page.locator('.subtitle')).toHaveText(
    'User details · /Students/High School',
  );

  const account = page.locator('section.account');
  for (const [label, value] of [
    ['Primary email', 'amara.okafor@example.org'],
    ['Status', 'Active'],
    ['Last sign-in', shownTime(at(28))],
    ['2-step verification', 'Enrolled'],
  ] as const)
    await expect(
      account.locator('.facts-list > div', {
        hasText: label,
      }),
    ).toContainText(value);
  await expect(
    account.locator('.facts-list > div', { hasText: 'Created' }),
  ).toContainText('Aug 14, 2023');

  const organization = page.locator('section.org');
  await expect(
    organization.locator('.facts-list > div', { hasText: 'Organization unit' }),
  ).toContainText('/Students/High School');
  await expect(
    organization.locator('.facts-list > div', { hasText: 'Department' }),
  ).toContainText('Not set');
  await expect(
    organization.locator('.facts-list > div', { hasText: 'Title' }),
  ).toContainText('Not set');

  // The approved composition: Account and Organization on the left, attributes on the right.
  const accountBox = measured(await account.boundingBox());
  const attributesBox = measured(
    await page.locator('section.attrs').boundingBox(),
  );
  expect(attributesBox.x).toBeGreaterThan(accountBox.x + accountBox.width);
  expect(Math.abs(attributesBox.width - accountBox.width)).toBeLessThanOrEqual(
    1,
  );

  // Each category shows its heading. The empty category shows the one approved line.
  await expect(page.locator('.attr-section h3')).toHaveText([
    'Student information',
    'Staff information',
    'Device program',
  ]);
  const staff = page.locator('.attr-section', {
    has: page.getByRole('heading', { name: 'Staff information' }),
  });
  await expect(staff.locator('.empty')).toHaveText('No values set');
  await expect(staff.locator('.annotation')).toHaveCount(0);

  const student = page.locator('.attr-section', {
    has: page.getByRole('heading', { name: 'Student information' }),
  });
  await expect(
    student.locator('.annotation', { hasText: 'Student ID' }),
  ).toContainText('000001');
  await expect(
    student.locator('.annotation', { hasText: 'Grade level' }),
  ).toContainText('10');
  await expect(
    student.locator('.annotation', { hasText: 'Homeroom' }),
  ).toContainText('214');
  const programs = student.locator('.annotation', { hasText: 'Programs' });
  await expect(programs.locator('.value-chips li')).toHaveText([
    'Gifted',
    'Band',
  ]);
  await expect(
    page
      .locator('.attr-section', {
        has: page.getByRole('heading', { name: 'Device program' }),
      })
      .locator('.annotation'),
  ).toContainText(/Take-home approved\s*Yes/);

  // The approved actions: Back to users, then Next user.
  await expect(
    page.getByRole('link', { name: 'Back to users', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Next user', exact: true }),
  ).toBeEnabled();

  await page.screenshot({
    path: `${scratch}/um-04-user-details.png`,
    fullPage: false,
  });
});

test('shows the removal time of a removed user (A section 11)', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // A removed user stays out of the grid, and its details page still opens.
  await page.goto('/users/110000000000000000005');
  await expect(
    page.getByRole('heading', { name: 'Dana Whitfield', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.removed')).toHaveText(
    `Google no longer returns this user (since ${shownTime(removedAt)}).`,
  );
  // The page names the age of the read that found the removal.
  await expect(page.locator('.read-age')).toContainText('Read from Google');
  await expect(
    page.getByRole('button', { name: 'Next user', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${scratch}/um-11-removed-user.png`,
    fullPage: false,
  });
});

test('returns focus to the opening row and keeps the filter and selection (UI-09)', async ({
  page,
}) => {
  await openUsers(page);
  // The filter holds three users of the alphabetical order: Abdul, Amara, Ania.
  await page.getByRole('button', { name: 'Add a filter' }).click();
  await page.getByRole('combobox', { name: 'Filter field' }).fill('Grade');
  await page.getByRole('option', { name: 'Grade level', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Grade level' });
  await editor.getByLabel('From').fill('7');
  await editor.getByLabel('To').fill('11');
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(
    page.getByRole('button', { name: 'Grade level 7 to 11', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'Aaron Whitfield', exact: true }),
  ).toHaveCount(0);

  // Select the last row of the filtered order.
  await page
    .getByRole('row', { name: /Ania Reyes/ })
    .getByRole('checkbox')
    .first()
    .click();
  await expect(
    page.getByRole('button', { name: 'Show All Selected (1)' }),
  ).toBeVisible();

  await detailsControl(page, 'Abdul Karim').click();
  await expect(
    page.getByRole('heading', { name: 'Abdul Karim', exact: true }),
  ).toBeVisible();
  // Next user walks the filtered order, not the whole directory.
  await page.getByRole('button', { name: 'Next user', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Amara Okafor', exact: true }),
  ).toBeVisible();

  // Back to users restores the filter, the selection, and the row.
  await page.getByRole('link', { name: 'Back to users', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Grade level 7 to 11', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Show All Selected (1)' }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'Ania Reyes', exact: true }),
  ).toBeVisible();
  // Focus returns to the row that opened the page just closed (UI-09).
  await expect(detailsControl(page, 'Amara Okafor')).toBeFocused();
  await page.screenshot({
    path: `${scratch}/um-04b-back-to-users.png`,
    fullPage: false,
  });
});

test('opens the details page from the user name', async ({ page }) => {
  await openUsers(page);
  await page.getByRole('link', { name: 'Amara Okafor', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Amara Okafor', exact: true }),
  ).toBeVisible();
  // The link records the row, so Next user walks the grid order.
  await expect(
    page.getByRole('button', { name: 'Next user', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Next user', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Ania Reyes', exact: true }),
  ).toBeVisible();
});

test('keeps the name link in every grid row (GRID-03)', async ({ page }) => {
  await openUsers(page);
  await expect(
    page.getByRole('link', { name: 'Amara Okafor', exact: true }),
  ).toHaveAttribute('href', '/users/110000000000000000001');
  await expect(
    page.getByRole('button', { name: 'Open details for Amara Okafor' }),
  ).toBeVisible();
});
