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
/** One test sends a long attribute value to prove that it stays inside its card. */
let longProgram: string | null = null;
/** The value of the one save of the card form test, kept until the next test. */
let savedGrade: number | null = null;
/** The edit list that the mocked preview route received. */
let lastPreviewBody: unknown = null;

test.afterEach(() => {
  longProgram = null;
  savedGrade = null;
  lastPreviewBody = null;
  tooLargeOnce = false;
  extraPeople = [];
});

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
  { action: 'users:write', scope: { kind: 'district', customerId } },
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

const rows = people.map(toRow);

/** One directory record of a fixture person. */
function toRow(person: FixtureUser) {
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
}

/**
 * One test opens a directory larger than one grid page, to check the return to the
 * page, the scroll offset, and a block that loads after the first block (A section 4).
 */
let extraPeople: FixtureUser[] = [];
const directoryPeople = () => [...people, ...extraPeople];
const directoryRows = () => [...rows, ...extraPeople.map(toRow)];

/** More users than one grid page holds, named so they sort after the base people. */
function manyPeople(count: number): FixtureUser[] {
  return Array.from({ length: count }, (_, at) => {
    const number = String(at + 1).padStart(4, '0');
    return {
      name: `Zed Person ${number}`,
      local: `zed.person${number}`,
      userId: `120000000000000000${number}`,
      orgUnitPath: '/Students/High School',
      lastLoginHoursAgo: 20,
      twoStep: true,
      grade: 9,
      homeroom: '100',
      programs: [],
    };
  });
}

/** The details answer of one user, with the record shape of the API. */
function detailOf(person: FixtureUser) {
  const row = directoryRows().find(
    (candidate) => candidate.userId === person.userId,
  );
  return {
    user: {
      ...withSavedGrade(withLongProgram(row), person.userId),
      removedAt: person.removedAt ?? null,
    },
  };
}

/** The record of the one card form save, after its job settles (state 12). */
function withSavedGrade<T extends Record<string, unknown> | undefined>(
  row: T,
  userId: string,
) {
  if (savedGrade === null || !row || row['userId'] !== userId) return row;
  const student = {
    ...(row['customSchemas'] as Record<string, Record<string, unknown>>)[
      'Student'
    ],
    grade_level: String(savedGrade),
  };
  return {
    ...row,
    customSchemas: {
      ...(row['customSchemas'] as Record<string, unknown>),
      Student: student,
    },
  } as T;
}

/** The record of the first user with the long attribute value of one test. */
function withLongProgram<T extends Record<string, unknown> | undefined>(
  row: T,
) {
  if (!longProgram || !row || row['userId'] !== people[0].userId) return row;
  const student = {
    ...(row['customSchemas'] as Record<string, Record<string, unknown>>)[
      'Student'
    ],
  };
  const programs = [
    ...((student['programs'] as { value: string }[] | undefined) ?? []),
    { value: longProgram },
  ];
  return {
    ...row,
    customSchemas: {
      ...(row['customSchemas'] as Record<string, unknown>),
      Student: { ...student, programs },
    },
  } as T;
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
  let matched = directoryRows()
    .filter(
      (row) =>
        !directoryPeople().find((person) => person.userId === row.userId)
          ?.removedAt,
    )
    .map((row) => withLongProgram(row));
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
      total: directoryRows().length - 1,
      observedAt,
      refreshJobId: null,
    }),
  };
}

/** The preview that the mocked edit-list route freezes for the card form test. */
const previewDigest = 'a'.repeat(64);
const cardPreview = (
  edits: readonly { baselineValue?: unknown; values?: unknown[] }[],
) => ({
  previewId: '2f1c6a0e-6d3b-4a1f-9f0e-3c4ce0b6a910',
  source: 'edit-list',
  changes: null,
  attributeChanges: edits.length,
  selected: edits.length,
  eligible: edits.length,
  unchanged: 0,
  conflicts: 0,
  oldestObservedAt: observedAt,
  stale: false,
  preparedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 600_000).toISOString(),
  manifestDigest: previewDigest,
});

/** One frozen row of the card form preview, from the edit that asked for it. */
const cardTarget = (edit: {
  attribute: string;
  baselineValue?: unknown;
  values?: unknown[];
}) => ({
  userId: people[0].userId,
  primaryEmail: `${people[0].local}@example.org`,
  attribute: edit.attribute,
  currentValue: edit.baselineValue ?? null,
  newValue: edit.values?.[0] ?? null,
  disposition: 'eligible',
  observedAt,
});

/** The value job that the mocked confirm answers, and its detail (design K24). */
const valueJob = {
  jobId: '8f2b4b19-4c6a-47fd-8d0a-0f3ce4b0f2a1',
  displayId: 'UAT-015',
  revision: 1,
  action: 'update-device-annotations',
  status: 'completed',
  entityType: 'device',
  scope: { kind: 'devices', deviceCount: 1 },
  requestedBy: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: 'Review administrator',
  },
  createdAt: new Date(now - 60_000).toISOString(),
  startedAt: new Date(now - 50_000).toISOString(),
  finishedAt: new Date(now - 40_000).toISOString(),
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
  cancelRequest: null,
  failure: null,
  phase: null,
  exportSummary: null,
  importSummary: null,
  confirmedBy: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: 'Review administrator',
  },
  previewDisplayId: null,
  changes: null,
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: null,
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: new Date(now - 40_000).toISOString(),
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
  exportFile: null,
  importSource: null,
  plan: null,
  importDisplayId: null,
  waitsForDisplayId: null,
  waitingDisplayIds: null,
  planJobs: null,
  executionCounts: null,
};

/** The mocked preview answers 413 once, to prove that the form keeps its edits. */
let tooLargeOnce = false;

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
          selectionState.ids = new Set(
            directoryRows().map((row) => row.userId),
          );
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
    // The card form: one edit-list preview, its frozen rows, its confirm, and the job (K23, K24).
    if (
      path === '/api/users/attribute-previews' &&
      request.method() === 'POST'
    ) {
      const body = request.postDataJSON();
      lastPreviewBody = body;
      if (tooLargeOnce) {
        tooLargeOnce = false;
        return route.fulfill({
          status: 413,
          json: { reason: 'payload-too-large' },
        });
      }
      return route.fulfill({ json: cardPreview(body.edits ?? []) });
    }
    if (/^\/api\/users\/attribute-previews\/[^/]+\/targets$/.test(path)) {
      const edits =
        (
          lastPreviewBody as {
            edits?: Parameters<typeof cardTarget>[0][];
          } | null
        )?.edits ?? [];
      return route.fulfill({
        json: { targets: edits.map(cardTarget), nextCursor: null },
      });
    }
    if (/^\/api\/users\/attribute-previews\/[^/]+\/confirm$/.test(path)) {
      const body = request.postDataJSON() ?? {};
      if (body.manifestDigest !== previewDigest)
        return route.fulfill({
          status: 409,
          json: { reason: 'preview-conflict' },
        });
      savedGrade = 11;
      return route.fulfill({
        json: {
          jobId: valueJob.jobId,
          displayId: valueJob.displayId,
          status: 'accepted',
          userCount: 1,
          changeCount: 1,
        },
      });
    }
    if (path === `/api/jobs/${valueJob.displayId}`)
      return route.fulfill({ json: valueJob });
    // One user, read by the details page. Any other path stays a 404.
    const single = /^\/api\/users\/([^/]+)$/.exec(path);
    if (single) {
      const person = directoryPeople().find(
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

/** The theme menu of the shell (UI-10 checks both themes). */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.getByRole('button', { name: 'Choose theme' }).click();
  await page
    .getByRole('menuitem', {
      name: theme === 'dark' ? 'Use dark theme' : 'Use light theme',
    })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // The menu animates closed. Wait so a following screenshot shows the page only.
  await expect(page.locator('.mat-mdc-menu-panel')).toBeHidden();
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

/** The vertical offset of the grid body, or -1 before the body renders. */
async function gridScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.ag-grid-viewport');
    return Math.round(viewport?.scrollTop ?? -1);
  });
}

/** Scroll the grid body to one offset, as a person with a mouse wheel would. */
async function scrollGrid(page: Page, top: number): Promise<void> {
  await page.evaluate((value) => {
    const viewport = document.querySelector<HTMLElement>('.ag-grid-viewport');
    if (viewport) viewport.scrollTop = value;
  }, top);
  await page.waitForTimeout(100);
}

/**
 * Clicks a details control and returns the grid offset that the click used. A mouse
 * click at the visible box does not scroll the row first, so the offset is the one a
 * person saw (A section 4).
 */
async function clickDetails(page: Page, control: Locator): Promise<number> {
  await control.scrollIntoViewIfNeeded();
  const saved = await gridScrollTop(page);
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(
    (box?.x ?? 0) + (box?.width ?? 0) / 2,
    (box?.y ?? 0) + (box?.height ?? 0) / 2,
  );
  return saved;
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
  // Focus returns to the row that opened the details page, not the traversed row (UI-09).
  await expect(detailsControl(page, 'Abdul Karim')).toBeFocused();
  await page.screenshot({
    path: `${scratch}/um-04b-back-to-users.png`,
    fullPage: false,
  });
});

test('returns to the opening page after Next crosses a page boundary (A section 4, R3)', async ({
  page,
}) => {
  extraPeople = manyPeople(130);
  // The base people fill the first rows. Row 99 is the last row of grid page one.
  const anchor = 99;
  const base = people.filter((person) => !person.removedAt).length;
  const anchorName = `Zed Person ${String(anchor - base + 1).padStart(4, '0')}`;
  const nextName = `Zed Person ${String(anchor - base + 2).padStart(4, '0')}`;
  await openUsers(page);
  // Scroll to the last row of the first page, then open it.
  await scrollGrid(page, 100_000);
  const control = page.locator(`[row-index="${anchor}"] .details-action`);
  await expect(control).toHaveAccessibleName(`Open details for ${anchorName}`);
  // The offset that the click used is the one that Back to users must restore.
  const saved = await clickDetails(page, control);
  await expect(
    page.getByRole('heading', { name: anchorName, exact: true }),
  ).toBeVisible();
  expect(saved).toBeGreaterThan(0);
  // Next user moves past the page boundary of the grid that opened the details.
  await page.getByRole('button', { name: 'Next user', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: nextName, exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Back to users', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Users', exact: true }),
  ).toBeVisible();
  // Back to users returns to the opening row on its own page, not the traversed row.
  await expect(
    page.getByRole('button', { name: `Open details for ${anchorName}` }),
  ).toBeFocused();
  expect(Math.abs((await gridScrollTop(page)) - saved)).toBeLessThanOrEqual(1);
});

test('returns to the opening scroll position without Next (A section 4, R3)', async ({
  page,
}) => {
  extraPeople = manyPeople(60);
  await openUsers(page);
  await scrollGrid(page, 840);
  // Open a row that the scroll position shows, clear of the page header.
  const anchor = await page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll<HTMLElement>('.ag-row[row-index]'),
    ];
    const shown = rows.find((row) => {
      const box = row.getBoundingClientRect();
      return box.top >= 150 && box.bottom <= window.innerHeight - 20;
    });
    return shown ? Number(shown.getAttribute('row-index')) : null;
  });
  expect(anchor).not.toBeNull();
  const control = page.locator(`[row-index="${anchor}"] .details-action`);
  const label = (await control.getAttribute('aria-label')) ?? '';
  // The offset that the click used is the one that Back to users must restore instead
  // of centering the row again.
  const saved = await clickDetails(page, control);
  await expect(
    page.getByRole('heading', {
      name: label.replace('Open details for ', ''),
      exact: true,
    }),
  ).toBeVisible();
  expect(saved).toBeGreaterThan(0);
  await page.getByRole('link', { name: 'Back to users', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Users', exact: true }),
  ).toBeVisible();
  // The row returns at the offset that held it, and focus goes there (UI-09).
  await expect(
    page.locator(`[row-index="${anchor}"] .details-action`),
  ).toBeFocused();
  expect(Math.abs((await gridScrollTop(page)) - saved)).toBeLessThanOrEqual(1);
});

test('restores focus when the returned block loads after a delay (R4)', async ({
  page,
}) => {
  extraPeople = manyPeople(130);
  await openUsers(page);
  await page.getByRole('button', { name: 'Next Page' }).click();
  const control = page.locator('[row-index="100"] .details-action');
  const label = (await control.getAttribute('aria-label')) ?? '';
  const name = label.replace('Open details for ', '');
  await expect(control).toBeVisible();
  // The block that holds the row answers 1.5 s after the grid returns.
  await page.route('**/api/users/query', async (route) => {
    const body = route.request().postDataJSON();
    if (Number(body?.offset ?? 0) === 100)
      await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ json: answerFor(body) });
  });
  await control.click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to users', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Users', exact: true }),
  ).toBeVisible();
  await expect(control).toBeFocused({ timeout: 8000 });
});

test('stays on the grid when a Next user answer lands after Back to users (R2)', async ({
  page,
}) => {
  await openUsers(page);
  // The neighbor query answers after the person already returned to the grid.
  await page.route('**/api/users/query', async (route) => {
    const body = route.request().postDataJSON();
    if (Number(body?.limit ?? 0) === 1)
      await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ json: answerFor(body) });
  });
  await detailsControl(page, 'Amara Okafor').click();
  await expect(
    page.getByRole('heading', { name: 'Amara Okafor', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next user', exact: true }).click();
  await page.getByRole('link', { name: 'Back to users', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Users', exact: true }),
  ).toBeVisible();
  // The held answer must not reopen a details page over the grid.
  await page.waitForTimeout(2000);
  await expect(page).toHaveURL(/\/users$/);
  await expect(
    page.getByRole('heading', { name: 'Users', exact: true }),
  ).toBeVisible();
});

test('shows a failed details read with a Retry, not a missing user (R5)', async ({
  page,
}) => {
  await openUsers(page);
  let reads = 0;
  await page.route('**/api/users/110000000000000000001', async (route) => {
    reads++;
    if (reads === 1) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({ json: detailOf(people[0]) });
  });
  await page.goto('/users/110000000000000000001');
  await expect(
    page.getByRole('heading', {
      name: 'User details are unavailable',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'User not found', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Amara Okafor', exact: true }),
  ).toBeVisible();
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

test('keeps a long attribute value inside its card and stacks at a narrow width', async ({
  page,
}) => {
  longProgram =
    'Extended Learning Opportunity Program for the Visual and Performing Arts';
  await openUsers(page);
  await detailsControl(page, 'Amara Okafor').click();
  await expect(
    page.getByRole('heading', { name: 'Amara Okafor', exact: true }),
  ).toBeVisible();
  const card = measured(await page.locator('section.attrs').boundingBox());
  const chip = measured(
    await page
      .locator('.value-chips li', { hasText: 'Extended Learning' })
      .boundingBox(),
  );
  // A long value wraps inside its chip instead of leaving the card.
  expect(chip.x + chip.width).toBeLessThanOrEqual(card.x + card.width + 1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  // The two columns stack when the viewport narrows (UI-09 reflow).
  await page.setViewportSize({ width: 900, height: 900 });
  const account = measured(await page.locator('section.account').boundingBox());
  const attributes = measured(
    await page.locator('section.attrs').boundingBox(),
  );
  expect(attributes.y).toBeGreaterThan(account.y + account.height);
  expect(Math.abs(attributes.x - account.x)).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${scratch}/um-04c-narrow-long-value.png`,
    fullPage: false,
  });
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

test('reproduces UM state 05 and state 12: the card form and the saved line', async ({
  page,
}) => {
  // The first preview answers 413, to prove that the form keeps its edits (card K25).
  tooLargeOnce = true;
  await openUsers(page);
  await detailsControl(page, 'Amara Okafor').click();
  await expect(
    page.getByRole('heading', { name: 'Amara Okafor', exact: true }),
  ).toBeVisible();

  // One outlined Edit button at the right of the card heading (composition 4).
  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  await expect(edit).toBeVisible();
  const card = page.locator('section.attrs');
  const headingBox = measured(
    await card
      .getByRole('heading', { name: 'Custom attributes' })
      .boundingBox(),
  );
  const editBox = measured(await edit.boundingBox());
  expect(editBox.x).toBeGreaterThan(headingBox.x + headingBox.width);
  await edit.click();

  // State 05: the whole card edits at once, and each info type has its editor.
  await expect(card.locator('.attribute-form')).toBeVisible();
  await expect(
    card.locator('[data-attribute="attr:Student.student_id"] input'),
  ).toBeFocused();
  const grade = card.locator(
    '[data-attribute="attr:Student.grade_level"] input',
  );
  const homeroom = card.locator(
    '[data-attribute="attr:Student.homeroom"] input',
  );
  await expect(grade).toHaveValue('10');
  await expect(homeroom).toHaveValue('214');
  await expect(
    card.locator('[data-attribute="attr:Staff.hire_date"] input'),
  ).toHaveAttribute('type', 'date');
  await expect(
    card.locator(
      '[data-attribute="attr:Device.take_home"] mat-button-toggle-group',
    ),
  ).toBeVisible();
  await expect(card.locator('mat-chip-row')).toHaveCount(2);
  const save = page.getByRole('button', { name: 'Save changes', exact: true });
  await expect(save).toBeDisabled();

  // The value rules run in the form: a number error and the in-grid count message.
  await grade.fill('ten');
  await expect(card.getByText('Enter a whole number.')).toBeVisible();
  await expect(save).toBeDisabled();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${scratch}/um-05-user-details-edit.png`,
    fullPage: false,
  });
  await page.screenshot({
    path: `${scratch}/um-05-user-details-edit-full.png`,
    fullPage: true,
  });
  await setTheme(page, 'dark');
  await page.screenshot({
    path: `${scratch}/um-05-user-details-edit-dark.png`,
    fullPage: true,
  });
  await setTheme(page, 'light');
  await homeroom.fill('216');
  await expect(save).toBeDisabled();
  await homeroom.fill('x'.repeat(512));
  await expect(card.getByText('512 of 500 characters')).toBeVisible();
  await expect(save).toBeDisabled();
  await homeroom.fill('216');
  await grade.fill('11');

  // A 413 keeps the form and its edits, and shows the exact sentence of the card.
  await save.click();
  await expect(
    card.getByText('The request exceeds the size limit.'),
  ).toBeVisible();
  await expect(grade).toHaveValue('11');
  await expect(homeroom).toHaveValue('216');

  // Two changes show the review of the frozen rows (B section 4.2).
  await save.click();
  await expect(card.locator('.review-table')).toBeVisible();
  const rows = card.locator('.review-table tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Grade level');
  await expect(rows.nth(0)).toContainText('Proposed');
  await expect(rows.nth(1)).toContainText('Homeroom');
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
  await expect(confirm).toBeEnabled();
  await page.getByRole('button', { name: 'Back', exact: true }).click();

  // One change prepares the preview and confirms it in one step (owner direction).
  await expect(grade).toHaveValue('11');
  await expect(homeroom).toHaveValue('216');
  await homeroom.fill('214');
  await save.click();
  await expect(card.getByText('Grade level saved to Google')).toBeVisible();
  expect(lastPreviewBody).toEqual({
    edits: [
      {
        userId: people[0].userId,
        attribute: 'attr:Student.grade_level',
        mode: 'set',
        values: [11],
        baselineValue: 10,
      },
    ],
  });

  // State 12: the saved line with the job as a secondary link, and the new value.
  const job = card.getByRole('link', { name: 'UAT-015', exact: true });
  await expect(job).toHaveAttribute('href', '/jobs/UAT-015');
  await expect(
    card.locator('.annotation', { hasText: 'Grade level' }),
  ).toContainText('11');
  await expect(edit).toBeFocused();
  const savedBox = measured(await card.locator('.saved-line').boundingBox());
  const firstSection = measured(
    await card.locator('.attr-section').first().boundingBox(),
  );
  expect(savedBox.y + savedBox.height).toBeLessThanOrEqual(firstSection.y + 1);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${scratch}/um-12-details-saved.png`,
    fullPage: false,
  });
  await page.screenshot({
    path: `${scratch}/um-12-details-saved-full.png`,
    fullPage: true,
  });
  await setTheme(page, 'dark');
  await page.screenshot({
    path: `${scratch}/um-12-details-saved-dark.png`,
    fullPage: true,
  });
});
