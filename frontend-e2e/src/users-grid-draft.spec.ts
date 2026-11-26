import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installLiveStreams, liveStreams } from './live-streams';

/**
 * Design card K26: the in-grid attribute editors of the Users grid. The API is mocked; no
 * live Google call runs. The tests cover UM state 06 (two draft cells and the pending
 * changes bar), one change saved in one step, two changes through the Set attributes
 * dialog at Review, a conflict cell that blocks Save changes, a 413 that keeps the draft,
 * and the value that a settled job writes into the cells on screen.
 */

const customerId = 'C0123456';
const observedAt = '2026-11-24T12:00:00.000Z';
const principal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storageKey = `cc.user-attribute-draft.${principal}`;
const previewId = '2f1c6a0e-6d3b-4a1f-9f0e-3c4ce0b6a910';
const secondPreviewId = '7c9e1a3b-5d2f-4e8a-9b1c-6d3e5f7a8b9c';
const confirmId = '3a2b1c0d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const jobDisplayId = 'UAT-921';
const jobId = '8f2b4b19-4c6a-47fd-8d0a-0f3ce4b0f2a1';
const manifestDigest = 'a'.repeat(64);

const evidenceDir =
  process.env['EVIDENCE_DIR'] ?? path.join(process.cwd(), 'dist/e2e-evidence');

const grants = [
  { action: 'users:read', scope: { kind: 'district', customerId } },
  { action: 'users:write', scope: { kind: 'district', customerId } },
  { action: 'users:bulk-actions', scope: { kind: 'district', customerId } },
];

/** The first fourteen users of the approved screen (state 01). */
const people: {
  name: string;
  orgUnitPath: string;
  grade: number | null;
  homeroom: string;
  takeHome: boolean;
}[] = [
  {
    name: 'Aaliyah Brooks',
    orgUnitPath: '/Students/High School',
    grade: 11,
    homeroom: '118',
    takeHome: true,
  },
  {
    name: 'Aaron Whitfield',
    orgUnitPath: '/Students/High School',
    grade: 10,
    homeroom: '104',
    takeHome: false,
  },
  {
    name: 'Abdul Karim',
    orgUnitPath: '/Students/Middle School',
    grade: 7,
    homeroom: 'M12',
    takeHome: false,
  },
  {
    name: 'Abigail Chen',
    orgUnitPath: '/Students/High School',
    grade: 9,
    homeroom: '105',
    takeHome: true,
  },
  {
    name: 'Adam Novak',
    orgUnitPath: '/Students/High School',
    grade: 8,
    homeroom: 'M04',
    takeHome: false,
  },
  {
    name: 'Adriana Flores',
    orgUnitPath: '/Students/High School',
    grade: 12,
    homeroom: '230',
    takeHome: true,
  },
  {
    name: 'Ahmed Hassan',
    orgUnitPath: '/Students/Middle School',
    grade: 6,
    homeroom: 'M21',
    takeHome: false,
  },
  {
    name: 'Aiden Murphy',
    orgUnitPath: '/Students/High School',
    grade: 9,
    homeroom: '216',
    takeHome: true,
  },
  {
    name: 'Aisha Rahman',
    orgUnitPath: '/Students/High School',
    grade: 10,
    homeroom: '',
    takeHome: false,
  },
  {
    name: 'Alan Brennan',
    orgUnitPath: '/Students/High School',
    grade: 11,
    homeroom: '118',
    takeHome: true,
  },
  {
    name: 'Alejandro Ruiz',
    orgUnitPath: '/Students/High School',
    grade: 8,
    homeroom: '216',
    takeHome: false,
  },
  {
    name: 'Alice Thornton',
    orgUnitPath: '/Students/High School',
    grade: 9,
    homeroom: 'M04',
    takeHome: true,
  },
  {
    name: 'Amara Okafor',
    orgUnitPath: '/Students/High School',
    grade: 10,
    homeroom: '214',
    takeHome: false,
  },
  {
    name: 'Ana Sofia Reyes',
    orgUnitPath: '/Students/High School',
    grade: 10,
    homeroom: '216',
    takeHome: true,
  },
];

/** The values that the mocked Google directory holds, by user ID. */
const values = new Map<
  string,
  { grade: number | null; homeroom: string; takeHome: boolean }
>();

function userIdOf(index: number): string {
  return `1100000000000000${String(index + 1).padStart(4, '0')}`;
}

function seedValues(): void {
  values.clear();
  people.forEach((person, index) =>
    values.set(userIdOf(index), {
      grade: person.grade,
      homeroom: person.homeroom,
      takeHome: person.takeHome,
    }),
  );
}

function rowOf(index: number, version = 1) {
  const person = people[index]!;
  const value = values.get(userIdOf(index)) ?? {
    grade: person.grade,
    homeroom: person.homeroom,
    takeHome: person.takeHome,
  };
  return {
    userId: userIdOf(index),
    primaryEmail: `${person.name.toLowerCase().replaceAll(' ', '.')}@example.org`,
    orgUnitPath: person.orgUnitPath,
    givenName: person.name.split(' ')[0],
    familyName: person.name.split(' ').slice(1).join(' '),
    fullName: person.name,
    suspended: false,
    suspensionReason: null,
    archived: false,
    lastLoginTime: observedAt,
    creationTime: '2020-08-01T12:00:00.000Z',
    twoStepEnrolled: true,
    department: null,
    title: null,
    aliases: [],
    customSchemas: {
      Student: {
        ...(value.grade === null ? {} : { grade_level: value.grade }),
        ...(value.homeroom ? { homeroom: value.homeroom } : {}),
        programs: [{ value: 'Band' }],
      },
      Device: { take_home: value.takeHome },
    },
    lastEntitySync: observedAt,
    stale: false,
    recordVersion: version,
  };
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
          fieldId: 'Student.grade_level',
          fieldName: 'grade_level',
          displayName: 'Grade level',
          fieldType: 'INT64',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: { minValue: 0, maxValue: 13 },
          holders: 14,
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
          holders: 14,
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
          holders: 14,
        },
      ],
      holders: 14,
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
          holders: 14,
        },
      ],
      holders: 14,
      readAt: observedAt,
    },
  ],
  limits: {
    categories: 2,
    categoryLimit: 100,
    attributes: 4,
    attributeLimit: 100,
  },
  observedAt,
};

const sync = {
  customerId,
  generation: 1,
  status: 'ready',
  observedAt,
  userCount: people.length,
  failure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
};

/** What the mocked API answers for one save. */
interface MockState {
  /** The preview request refuses with 413 (design K26, refusal rule). */
  previewFails: boolean;
  /** The preview marks the first row a conflict (B section 8.4). */
  conflict: boolean;
  /** The listed user IDs answer as one entity batch after the confirm. */
  pendingFeed: string[];
  /** The preview bodies that the page sent. */
  previews: unknown[];
  /** The confirms that the page sent. */
  confirms: unknown[];
  /** The preview path of each confirm, so a replay must name the same preview. */
  confirmPaths: string[];
  /** The next confirm loses its answer, as a lost connection does (K26 reload check). */
  loseNextConfirm: boolean;
  /** The row reads by user ID. */
  byIds: string[][];
  /** The preview that the last request prepared, for the dialog's own read. */
  lastPreview: ReturnType<typeof previewOf> | null;
  /** The label that the category read returns for the same Grade level ID (R2-F). */
  gradeLabel: string;
  /** The job answers completed-with-errors: the first edit succeeds and the rest fail. */
  partial: boolean;
}

const state: MockState = {
  previewFails: false,
  conflict: false,
  pendingFeed: [],
  previews: [],
  confirms: [],
  confirmPaths: [],
  loseNextConfirm: false,
  byIds: [],
  lastPreview: null,
  gradeLabel: 'Grade level',
  partial: false,
};

function resetState(): void {
  state.previewFails = false;
  state.conflict = false;
  state.pendingFeed = [];
  state.previews = [];
  state.confirms = [];
  state.confirmPaths = [];
  state.loseNextConfirm = false;
  state.byIds = [];
  state.lastPreview = null;
  state.gradeLabel = 'Grade level';
  state.partial = false;
}

/** One edit of the preview request. */
interface EditBody {
  userId: string;
  attribute: string;
  mode: string;
  values: unknown[];
  baselineValue?: string | number | boolean | null;
}

function editsOf(body: { edits?: EditBody[] }): EditBody[] {
  return body.edits ?? [];
}

function nameOf(userId: string): string {
  const index = people.findIndex((_, at) => userIdOf(at) === userId);
  return index === -1 ? 'Unknown user' : people[index]!.name;
}

function previewOf(edits: EditBody[], id = previewId) {
  return {
    previewId: id,
    source: 'edit-list',
    changes: null,
    attributeChanges: edits.length,
    selected: edits.length,
    eligible: state.conflict ? edits.length - 1 : edits.length,
    unchanged: 0,
    conflicts: state.conflict ? 1 : 0,
    oldestObservedAt: observedAt,
    stale: false,
    preparedAt: observedAt,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    manifestDigest,
  };
}

function baselineEmpty(edit: EditBody): boolean {
  return edit.baselineValue === null || edit.baselineValue === '';
}

/**
 * The job writes the confirmed values to the mocked directory (document B section 9).
 * A terminal read then shows the written value, not the edit-start baseline.
 */
function applyConfirmedEdits(): void {
  const edits = editsOf(
    (state.previews.at(-1) ?? {}) as { edits?: EditBody[] },
  );
  for (const edit of edits) {
    const index = people.findIndex((_, at) => userIdOf(at) === edit.userId);
    if (index === -1) continue;
    const person = people[index]!;
    const value = values.get(edit.userId) ?? {
      grade: person.grade,
      homeroom: person.homeroom,
      takeHome: person.takeHome,
    };
    if (edit.attribute === 'attr:Student.grade_level')
      value.grade =
        edit.mode === 'clear' ? null : Number(edit.values[0] ?? value.grade);
    else if (edit.attribute === 'attr:Student.homeroom')
      value.homeroom =
        edit.mode === 'clear' ? '' : String(edit.values[0] ?? value.homeroom);
    else if (edit.attribute === 'attr:Device.take_home')
      value.takeHome = edit.mode === 'clear' ? false : edit.values[0] === true;
    values.set(edit.userId, value);
    // A partial job writes only its first operation (R2-C).
    if (state.partial) break;
  }
}

function targetOf(edit: EditBody, index: number) {
  const conflict = state.conflict && index === 0;
  return {
    userId: edit.userId,
    userName: nameOf(edit.userId),
    primaryEmail: `user.${index + 1}@example.org`,
    attribute: edit.attribute,
    currentValue:
      edit.mode === 'clear' || baselineEmpty(edit)
        ? null
        : [edit.baselineValue],
    newValue: edit.values,
    disposition: conflict ? 'conflict' : 'eligible',
    observedAt,
  };
}

function jobDetail(count: number) {
  const succeeded = state.partial ? Math.min(1, count) : count;
  const failed = count - succeeded;
  return {
    jobId,
    displayId: jobDisplayId,
    revision: 1,
    action: 'set-attributes',
    status: state.partial ? 'completed-with-errors' : 'completed',
    entityType: 'user',
    scope: { kind: 'rows', deviceCount: count },
    requestedBy: { id: principal, displayName: 'District operator' },
    createdAt: observedAt,
    startedAt: observedAt,
    finishedAt: observedAt,
    progress: {
      total: count,
      succeeded,
      failed,
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
    confirmedBy: { id: principal, displayName: 'District operator' },
    previewDisplayId: null,
    changes: null,
    commandType: null,
    statusAction: null,
    deprovisionReason: null,
    targetOrgUnitPaths: [],
    correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    latestActivity: {
      at: observedAt,
      failed: { count: failed, operations: [] },
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
}

async function mockApi(page: Page): Promise<void> {
  await installLiveStreams(page);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname === '/api/application')
      return route.fulfill({
        json: {
          phase: 3,
          authenticationConfigured: true,
          version: 'development',
          build: 'client-review',
        },
      });
    if (pathname === '/api/auth/session')
      return route.fulfill({
        json: {
          identity: {
            id: principal,
            displayName: 'District operator',
            permissionVersion: 1,
            permissions: [],
            grants,
            preferences: { theme: 'light', navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    if (pathname === '/api/users/sync')
      return route.fulfill({ json: { sync } });
    if (pathname === '/api/users/attribute-categories')
      return route.fulfill({
        json: {
          ...categories,
          categories: categories.categories.map((category) =>
            category.schemaName === 'Student'
              ? {
                  ...category,
                  fields: category.fields.map((field) =>
                    field.fieldName === 'grade_level'
                      ? { ...field, displayName: state.gradeLabel }
                      : field,
                  ),
                }
              : category,
          ),
        },
      });
    if (pathname === '/api/users/org-units')
      return route.fulfill({
        json: {
          orgUnits: [
            { path: '/Students/High School', users: 10 },
            { path: '/Students/Middle School', users: 2 },
            { path: '/Staff/High School', users: 2 },
          ],
        },
      });
    if (pathname === '/api/users/query')
      return route.fulfill({
        json: {
          page: {
            rows: people.map((_, index) => rowOf(index)),
            matching: people.length,
            total: people.length,
            observedAt,
            refreshJobId: null,
          },
        },
      });
    if (pathname === '/api/users/by-ids') {
      const body = request.postDataJSON() as { userIds?: string[] };
      const ids = body.userIds ?? [];
      state.byIds.push(ids);
      return route.fulfill({
        json: {
          rows: ids
            .map((id) => people.findIndex((_, at) => userIdOf(at) === id))
            .filter((index) => index !== -1)
            .map((index) => rowOf(index, 2)),
        },
      });
    }
    if (pathname === '/api/users/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (pathname === '/api/users/selection/resolve')
      return route.fulfill({ json: {} });
    if (pathname === '/api/users/selection')
      return route.fulfill({
        json: {
          selection: {
            terms: [],
            added: 0,
            excluded: 0,
            selectedCount: 0,
            expiredAt: null,
          },
        },
      });
    if (
      pathname === '/api/users/attribute-previews' &&
      request.method() === 'POST'
    ) {
      const body = request.postDataJSON() as { edits?: EditBody[] };
      // The first save owns one preview. A second preview gets its own ID, so a replay
      // that wrongly prepares another preview cannot pass as the first one.
      const id = state.previews.length === 0 ? previewId : secondPreviewId;
      state.previews.push(body);
      if (state.previewFails)
        return route.fulfill({
          status: 413,
          json: { reason: 'payload-too-large' },
        });
      state.lastPreview = previewOf(editsOf(body), id);
      return route.fulfill({ status: 201, json: state.lastPreview });
    }
    if (pathname.startsWith('/api/users/attribute-previews/')) {
      const rest = pathname.slice('/api/users/attribute-previews/'.length);
      const [id, action] = rest.split('/');
      if (id !== previewId) return route.fulfill({ status: 404, json: {} });
      if (action === 'targets') {
        const edits = editsOf(
          (state.previews.at(-1) ?? {}) as { edits?: EditBody[] },
        );
        const disposition = url.searchParams.get('disposition');
        const targets = edits
          .map((edit, index) => targetOf(edit, index))
          .filter(
            (target) => !disposition || target.disposition === disposition,
          );
        return route.fulfill({ json: { targets, nextCursor: null } });
      }
      if (action === 'confirm') {
        state.confirms.push(request.postDataJSON());
        state.confirmPaths.push(pathname);
        // The first answer is lost, as a dropped connection loses it (K26 reload check).
        if (state.loseNextConfirm) {
          state.loseNextConfirm = false;
          return route.abort('failed');
        }
        applyConfirmedEdits();
        return route.fulfill({
          status: 201,
          json: {
            jobId: confirmId,
            displayId: jobDisplayId,
            status: 'accepted',
            userCount: editsOf(
              (state.previews.at(-1) ?? {}) as { edits?: EditBody[] },
            ).length,
            changeCount: editsOf(
              (state.previews.at(-1) ?? {}) as { edits?: EditBody[] },
            ).length,
          },
        });
      }
      return route.fulfill({ json: state.lastPreview });
    }
    if (pathname === `/api/jobs/${jobDisplayId}`)
      return route.fulfill({ json: jobDetail(state.confirms.length ? 2 : 2) });
    if (pathname === `/api/jobs/${jobDisplayId}/attribute-rows`) {
      const edits = editsOf(
        (state.previews.at(-1) ?? {}) as { edits?: EditBody[] },
      );
      return route.fulfill({
        json: {
          rows: edits.map((edit, index) => ({
            operation: index + 1,
            userId: edit.userId,
            userName: nameOf(edit.userId),
            primaryEmail: `user.${index + 1}@example.org`,
            attribute: edit.attribute,
            displayName: 'Grade level',
            currentValue: baselineEmpty(edit) ? null : [edit.baselineValue],
            newValue: edit.values,
            outcome: 'succeeded',
            failureText: null,
          })),
          totals: { all: edits.length, failed: 0 },
          nextCursor: null,
        },
      });
    }
    if (pathname === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (pathname === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (pathname === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    if (pathname === '/api/jobs/activity')
      return route.fulfill({ json: { summary: null } });
    if (pathname === '/api/auth/preferences')
      return route.fulfill({ json: request.postDataJSON() });
    return route.fulfill({ status: 404, json: {} });
  });
}

async function openUsers(page: Page): Promise<void> {
  resetState();
  seedValues();
  await page.addInitScript(
    ([key, value]) => {
      window.sessionStorage.setItem(key!, value!);
      window.sessionStorage.removeItem(key!);
    },
    [storageKey, '{}'],
  );
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/users');
  await expect(
    page.getByRole('heading', { name: 'Users', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'Aaliyah Brooks', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** Show the Grade level and Homeroom attribute columns beside the pinned Name. */
async function showAttributes(page: Page): Promise<void> {
  const columns = page.getByRole('tab', { name: 'Columns', exact: true });
  await columns.click();
  const panel = page.locator('.lgr-columns-tool-panel');
  await expect(panel).toBeVisible();
  // The category read adds the attribute columns after the grid starts.
  const grade = panel.getByRole('checkbox', { name: 'Show Grade level' });
  await expect(grade).toBeVisible({ timeout: 15_000 });
  await grade.check();
  await panel.getByRole('checkbox', { name: 'Show Homeroom' }).check();
  // The approved UM06 column run: Name, Status, Last sign-in, 2-step verification, Grade
  // level, Homeroom. The panel hides the other columns, as the approved composition does.
  for (const label of [
    'Primary email',
    'Organization unit',
    'Created',
    'Department',
    'Title',
  ]) {
    const box = panel.getByRole('checkbox', { name: `Show ${label}` });
    if ((await box.count()) && (await box.isChecked())) await box.uncheck();
  }
  // The approved pending state shows the right rail, not the open Columns panel (R1-K).
  await columns.click();
  await expect(panel).toBeHidden();
  await expect(
    cell(page, 'Aaliyah Brooks', 'attr:Student.grade_level'),
  ).toHaveText('11');
}

/** The initial row and column position of the approved composition (R1-K). */
async function resetGridPosition(page: Page): Promise<void> {
  const horizontal = page.locator('.ag-body-horizontal-scroll-viewport');
  if (await horizontal.count()) {
    await horizontal.evaluate((element) => {
      element.scrollLeft = 0;
    });
  }
  const firstRow = page.getByRole('gridcell', {
    name: 'Aaliyah Brooks',
    exact: true,
  });
  await firstRow.scrollIntoViewIfNeeded();
  await expect(firstRow).toBeVisible();
}

function cell(page: Page, name: string, colId: string) {
  return page
    .locator('.ag-row', {
      has: page.getByRole('gridcell', { name, exact: true }),
    })
    .locator(`.ag-cell[col-id="${colId}"]`);
}

async function editText(
  page: Page,
  name: string,
  colId: string,
  value: string,
  key: 'Enter' | 'Tab' = 'Enter',
): Promise<void> {
  const target = cell(page, name, colId);
  await target.dblclick();
  const input = target.locator('input');
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press(key);
  await expect(target.locator('input')).toHaveCount(0);
}

async function axe(page: Page): Promise<void> {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, name),
    fullPage: false,
  });
}

test('reproduces UM state 06: two draft cells and the pending changes bar', async ({
  page,
}) => {
  await openUsers(page);
  await showAttributes(page);
  // The first two rows of the approved composition, so the pending cells and the first
  // row share the viewport at 1440 x 900 (R1-K).
  await editText(page, 'Aaliyah Brooks', 'attr:Student.homeroom', '216');
  await editText(page, 'Aaron Whitfield', 'attr:Student.grade_level', '11');

  // The bar of ruling 14: the count line and the three actions.
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 users',
  );
  await expect(
    page.getByRole('button', { name: 'Show pending changes' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Revert all changes' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save changes' }),
  ).toBeEnabled();

  const grade = cell(page, 'Aaron Whitfield', 'attr:Student.grade_level');
  const homeroom = cell(page, 'Aaliyah Brooks', 'attr:Student.homeroom');
  await expect(grade).toContainText('11');
  await expect(homeroom).toContainText('216');
  await expect(grade).toHaveClass(/user-attribute-draft-pending/);
  await expect(homeroom).toHaveClass(/user-attribute-draft-pending/);
  // DRAFT-02: the cell shows the pending mark and its rollback icon, not color alone.
  await expect(
    homeroom.getByRole('button', { name: /Revert homeroom of Aaliyah Brooks/ }),
  ).toBeVisible();

  // The approved composition: the first row and the first column, Columns closed.
  await resetGridPosition(page);
  await expect(grade).toBeVisible();
  await expect(homeroom).toBeVisible();
  await screenshot(page, 'um-k26-06-in-grid-pending.png');
  await axe(page);
});

test('keeps the shown columns across a same-ID category refresh (R2-F)', async ({
  page,
}) => {
  await openUsers(page);
  await showAttributes(page);
  // A category job renames the same attribute ID. The person's composition stays.
  state.gradeLabel = 'Grade';
  const streams = liveStreams(page);
  await streams.waitForOpen('/api/events');
  await streams.send('/api/events', 'schema-change', {
    type: 'schema-change',
    entityType: 'user',
  });

  // The rebuilt definition holds the new label, and both shown attribute columns remain.
  await expect(
    page.locator('.ag-header-cell[col-id="attr:Student.grade_level"]'),
  ).toContainText('Grade', { timeout: 15_000 });
  await expect(
    cell(page, 'Aaliyah Brooks', 'attr:Student.grade_level'),
  ).toBeVisible();
  await expect(
    cell(page, 'Aaliyah Brooks', 'attr:Student.homeroom'),
  ).toBeVisible();
  // A column that the person hid stays hidden.
  await expect(
    page.locator('.ag-header-cell[col-id="primaryEmail"]'),
  ).toHaveCount(0);

  // The Columns panel agrees with the grid after the rebuild.
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
  const panel = page.locator('.lgr-columns-tool-panel');
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole('checkbox', { name: 'Show Grade', exact: true }),
  ).toBeChecked();
  await expect(
    panel.getByRole('checkbox', { name: 'Show Homeroom', exact: true }),
  ).toBeChecked();
  await expect(
    panel.getByRole('checkbox', { name: 'Show Primary email', exact: true }),
  ).not.toBeChecked();
});

test('saves one pending change in one step and shows the written value', async ({
  page,
}) => {
  await openUsers(page);
  await showAttributes(page);
  await editText(page, 'Amara Okafor', 'attr:Student.grade_level', '11');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 user',
  );

  await page.getByRole('button', { name: 'Save changes' }).click();
  // One change confirms without the Set attributes dialog.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => state.confirms.length, { timeout: 10_000 }).toBe(1);
  await expect(page.locator('#draft-count')).toHaveCount(0);

  // The cell keeps the saved value while the row is old.
  const grade = cell(page, 'Amara Okafor', 'attr:Student.grade_level');
  await expect(grade).toContainText('11');
  await expect(grade).not.toHaveClass(/user-attribute-draft-pending/);

  // The users feed publishes the written value, and the cell reads it without a refresh.
  const streams = liveStreams(page);
  await streams.waitForOpen('/api/events');
  values.set(userIdOf(12), { grade: 11, homeroom: '214', takeHome: false });
  await streams.send('/api/events', 'entity-batch', {
    type: 'entity-batch',
    entityType: 'user',
    userIds: [userIdOf(12)],
    removedIds: [],
  });
  await expect
    .poll(() => state.byIds.length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  await expect(grade).toContainText('11');
  // The draft mark is gone: the cell draws the row that the feed brought.
  await expect(
    grade.getByRole('button', { name: /Revert grade level of Amara Okafor/ }),
  ).toHaveCount(0);
  // A later change of the row reaches the same cell, so it holds no frozen value.
  values.set(userIdOf(12), { grade: 12, homeroom: '214', takeHome: false });
  await streams.send('/api/events', 'entity-batch', {
    type: 'entity-batch',
    entityType: 'user',
    userIds: [userIdOf(12)],
    removedIds: [],
  });
  await expect(grade).toHaveText('12');
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
});

test('opens the Set attributes dialog at Review for two changes', async ({
  page,
}) => {
  await openUsers(page);
  await showAttributes(page);
  await editText(page, 'Aisha Rahman', 'attr:Student.homeroom', '216');
  await editText(page, 'Alejandro Ruiz', 'attr:Student.grade_level', '11');
  await page.getByRole('button', { name: 'Save changes' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The dialog opens at Review with one frozen preview of the two edits.
  await expect(dialog.getByRole('heading', { name: 'Review' })).toBeVisible();
  await expect(dialog).toContainText('Aisha Rahman');
  await expect(dialog).toContainText('Alejandro Ruiz');
  // The approved composition behind the dialog: first row, approved columns, closed panel.
  await resetGridPosition(page);
  await screenshot(page, 'um-k26-09-review-from-grid.png');
  expect(state.previews).toHaveLength(1);
  expect(editsOf(state.previews[0] as { edits?: EditBody[] })).toHaveLength(2);
  await dialog
    .getByRole('button', { name: 'Set attributes on 2 users' })
    .click();
  await expect.poll(() => state.confirms.length, { timeout: 10_000 }).toBe(1);
  // The dialog shows the results of the job.
  await expect(dialog).toContainText(jobDisplayId);
  await screenshot(page, 'um-k26-10-results-from-grid.png');

  // The users feed carries both written values to the cells behind the dialog.
  const streams = liveStreams(page);
  await streams.waitForOpen('/api/events');
  values.set(userIdOf(8), { grade: 10, homeroom: '216', takeHome: false });
  values.set(userIdOf(10), { grade: 11, homeroom: '216', takeHome: false });
  await streams.send('/api/events', 'entity-batch', {
    type: 'entity-batch',
    entityType: 'user',
    userIds: [userIdOf(8), userIdOf(10)],
    removedIds: [],
  });
  await expect
    .poll(() => state.byIds.flat().length, { timeout: 10_000 })
    .toBeGreaterThan(1);

  await dialog
    .getByRole('button', { name: 'Close', exact: true })
    .first()
    .click();
  await expect(page.locator('#draft-count')).toHaveCount(0);
  await expect(
    cell(page, 'Alejandro Ruiz', 'attr:Student.grade_level'),
  ).toContainText('11');
  await expect(
    cell(page, 'Aisha Rahman', 'attr:Student.homeroom'),
  ).toContainText('216');
  await screenshot(page, 'um-k26-11-settled-cells.png');
});

test('shows the authoritative value of a partial job without a feed (R2-C)', async ({
  page,
}) => {
  await openUsers(page);
  await showAttributes(page);
  state.partial = true;
  await editText(page, 'Aisha Rahman', 'attr:Student.homeroom', '216');
  await editText(page, 'Alejandro Ruiz', 'attr:Student.grade_level', '11');
  await page.getByRole('button', { name: 'Save changes' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Review' })).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Set attributes on 2 users' })
    .click();
  await expect(dialog).toContainText(jobDisplayId);
  await dialog
    .getByRole('button', { name: 'Close', exact: true })
    .first()
    .click();

  // The job wrote the first value and failed the second. No feed event arrives: the
  // terminal read by user ID supplies both authoritative rows.
  await expect(cell(page, 'Aisha Rahman', 'attr:Student.homeroom')).toHaveText(
    '216',
  );
  await expect(
    cell(page, 'Alejandro Ruiz', 'attr:Student.grade_level'),
  ).toHaveText('8');
  await expect(page.locator('#draft-count')).toHaveCount(0);
});

test('keeps the draft when the request exceeds the size limit', async ({
  page,
}) => {
  await openUsers(page);
  await showAttributes(page);
  state.previewFails = true;
  await editText(page, 'Aisha Rahman', 'attr:Student.homeroom', '216');
  await editText(page, 'Alejandro Ruiz', 'attr:Student.grade_level', '11');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.draft-line')).toHaveText(
    'The request exceeds the size limit.',
  );
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 users',
  );
  await expect(
    cell(page, 'Alejandro Ruiz', 'attr:Student.grade_level'),
  ).toHaveClass(/user-attribute-draft-pending/);
});

test('blocks Save changes while a conflict cell waits', async ({ page }) => {
  await openUsers(page);
  await showAttributes(page);
  state.conflict = true;
  await editText(page, 'Aisha Rahman', 'attr:Student.homeroom', '216');
  await editText(page, 'Alejandro Ruiz', 'attr:Student.grade_level', '11');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Review' })).toBeVisible();

  // The frozen row marks the first edit as a conflict, and the bar names it (B 8.4).
  const homeroom = cell(page, 'Aisha Rahman', 'attr:Student.homeroom');
  await expect(homeroom).toHaveClass(/user-attribute-draft-conflict/);
  await dialog
    .getByRole('button', { name: 'Close', exact: true })
    .first()
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.draft-line')).toContainText(
    'changed in Google after your edit',
  );
  await expect(
    page.getByRole('button', { name: 'Save changes' }),
  ).toBeDisabled();

  // A new value answers the conflict, so Save changes returns (B section 8.4).
  await editText(page, 'Aisha Rahman', 'attr:Student.homeroom', '215');
  await expect(
    page.getByRole('button', { name: 'Save changes' }),
  ).toBeEnabled();
});

test('never reads a No answer as an empty cell (B section 12)', async ({
  page,
}) => {
  await openUsers(page);
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
  const panel = page.locator('.lgr-columns-tool-panel');
  await expect(panel).toBeVisible();
  const takeHomeColumn = panel.getByRole('checkbox', {
    name: 'Show Take-home approved',
  });
  await expect(takeHomeColumn).toBeVisible({ timeout: 15_000 });
  await takeHomeColumn.check();
  await page
    .locator('.ag-body-horizontal-scroll-viewport')
    .evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
  const takeHome = cell(page, 'Aaliyah Brooks', 'attr:Device.take_home');
  await expect(takeHome).toHaveText('Yes');

  // The boolean editor is an anchored dropdown, not a dialog (DRAFT-02).
  await takeHome.dblclick();
  const combo = takeHome.getByRole('combobox');
  await expect(combo).toBeVisible();
  await combo.click();
  await screenshot(page, 'um-k26-bool-dropdown.png');
  await page.getByRole('option', { name: 'No', exact: true }).click();
  await expect(takeHome.getByRole('combobox')).toHaveCount(0);

  await expect(takeHome).toContainText('No');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 user',
  );
});

test('replays the retained confirmation after a page reload (K26)', async ({
  page,
}) => {
  // This check keeps the draft across the reload, so it does not clear the tab first.
  resetState();
  seedValues();
  state.loseNextConfirm = true;
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/users');
  await expect(
    page.getByRole('heading', { name: 'Users', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'Aaliyah Brooks', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await showAttributes(page);
  await editText(page, 'Amara Okafor', 'attr:Student.grade_level', '11');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 user',
  );

  // The mocked answer is lost, as a dropped connection loses one. The tab keeps the
  // preview and its digest.
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.draft-line')).toHaveText(
    'Cannot reach Campus Commander. Your changes are still here.',
  );
  expect(state.previews).toHaveLength(1);
  expect(state.confirms).toHaveLength(1);

  // The same tab reloads. The restored draft and confirmation answer the next Save.
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Users', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 user',
  );
  await screenshot(page, 'um-k26-12-reload-retained.png');

  await page.getByRole('button', { name: 'Save changes' }).click();
  // The recovered receipt settles the submitted draft entries.
  await expect(page.locator('#draft-count')).toHaveCount(0, {
    timeout: 15_000,
  });
  // The replay named the same preview, and the page prepared no second preview.
  expect(state.previews).toHaveLength(1);
  expect(state.confirms).toHaveLength(2);
  expect(state.confirmPaths).toEqual([
    `/api/users/attribute-previews/${previewId}/confirm`,
    `/api/users/attribute-previews/${previewId}/confirm`,
  ]);
  await showAttributes(page);
  await expect(
    cell(page, 'Amara Okafor', 'attr:Student.grade_level'),
  ).toContainText('11');
  await screenshot(page, 'um-k26-13-reload-replayed.png');
});
