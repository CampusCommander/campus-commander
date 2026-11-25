import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { userPageSchema } from '@campus/application-contracts';
import { installLiveStreams, liveStreams } from './live-streams';

const customerId = 'C0123456';
// The hand-off screenshots land here. The default keeps the file inside the test output.
const scratch = process.env['UM_SHOTS'] ?? 'test-results/um-k10-shots';

// The hand-off keeps one 1440 x 900 screenshot of each state.
test.beforeAll(() => mkdirSync(scratch, { recursive: true }));
const now = Date.now();
const at = (hoursAgo: number) =>
  new Date(now - hoursAgo * 3_600_000).toISOString();
const observedAt = at(2);

const grants = [
  { action: 'users:read', scope: { kind: 'district', customerId } },
  { action: 'users:write', scope: { kind: 'district', customerId } },
  { action: 'users:bulk-actions', scope: { kind: 'district', customerId } },
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'connection:diagnose', scope: { kind: 'district', customerId } },
];

interface FixtureUser {
  name: string;
  local: string;
  orgUnitPath: string;
  suspended?: boolean;
  lastLoginTime: string | null;
  twoStep: boolean;
  grade: number | null;
  homeroom: string;
  programs: string[];
  staff?: boolean;
}

const people: FixtureUser[] = [
  {
    name: 'Aaliyah Brooks',
    local: 'aaliyah.brooks',
    orgUnitPath: '/Students/High School',
    lastLoginTime: at(1),
    twoStep: true,
    grade: 11,
    homeroom: '118',
    programs: ['Band'],
  },
  {
    name: 'Aaron Whitfield',
    local: 'aaron.whitfield',
    orgUnitPath: '/Staff/High School',
    lastLoginTime: at(2),
    twoStep: true,
    grade: null,
    homeroom: '',
    programs: [],
    staff: true,
  },
  {
    name: 'Abdul Karim',
    local: 'abdul.karim',
    orgUnitPath: '/Students/Middle School',
    lastLoginTime: at(26),
    twoStep: false,
    grade: 7,
    homeroom: 'M12',
    programs: ['ESL'],
  },
  {
    name: 'Abigail Chen',
    local: 'abigail.chen',
    orgUnitPath: '/Students/High School',
    lastLoginTime: at(3),
    twoStep: true,
    grade: 9,
    homeroom: '105',
    programs: ['Gifted'],
  },
  {
    name: 'Adam Novak',
    local: 'adam.novak',
    orgUnitPath: '/Students/Middle School',
    suspended: true,
    lastLoginTime: at(120),
    twoStep: false,
    grade: 8,
    homeroom: 'M04',
    programs: [],
  },
  {
    name: 'Adriana Flores',
    local: 'adriana.flores',
    orgUnitPath: '/Students/High School',
    lastLoginTime: at(5),
    twoStep: false,
    grade: 12,
    homeroom: '230',
    programs: ['ESL', 'Robotics'],
  },
];

const rows = people.map((person, index) => {
  const student: Record<string, unknown> = {
    programs: person.programs.map((value) => ({ value })),
  };
  if (person.grade !== null) student['grade_level'] = String(person.grade);
  if (person.homeroom) student['homeroom'] = person.homeroom;
  const customSchemas: Record<string, Record<string, unknown>> = {
    Student: student,
  };
  if (!person.staff) customSchemas['Device'] = { take_home: index % 2 === 0 };
  return {
    userId: `11000000000000000000${index + 1}`,
    primaryEmail: `${person.local}@example.org`,
    orgUnitPath: person.orgUnitPath,
    givenName: person.name.split(' ')[0],
    familyName: person.name.split(' ')[1],
    fullName: person.name,
    suspended: !!person.suspended,
    suspensionReason: person.suspended ? 'ADMIN' : null,
    archived: false,
    lastLoginTime: person.lastLoginTime,
    creationTime: at(24 * 400),
    twoStepEnrolled: person.twoStep,
    department: person.staff ? 'Administration' : null,
    title: person.staff ? 'Principal' : null,
    aliases: [],
    customSchemas,
    lastEntitySync: observedAt,
    stale: false,
    recordVersion: 1,
  };
});

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
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 4,
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
          holders: 3,
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
          fieldId: 'Staff.building',
          fieldName: 'building',
          displayName: 'Building',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 2,
        },
      ],
      holders: 2,
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
  ],
  limits: {
    categories: 3,
    categoryLimit: 100,
    attributes: 5,
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

/** The users that a removal event took from this page's directory (R7). */
const removed = new Set<string>();

/** The selection that the mocked API keeps for one test (R10). */
const selectionState = {
  ids: new Set<string>(),
  terms: [] as unknown[],
};

/** What the API answers for the selection of this tab. */
function selectionSpec() {
  return {
    terms: selectionState.terms,
    added: 0,
    excluded: 0,
    selectedCount: selectionState.ids.size,
    expiredAt: null,
  };
}

/** The query answer honours the grade filter, the no-match name, removals, and the selection. */
function answerFor(body: any) {
  const predicates: any[] = body?.predicates ?? [];
  const name = predicates.find((item) => item.field === 'fullName');
  const grade = predicates.find(
    (item) => item.field === 'attribute' && item.fieldName === 'grade_level',
  );
  const kept = rows.filter((row) => !removed.has(row.userId));
  let matched = kept;
  // Show All Selected limits the query to the selection of this browser tab.
  if (body?.selection)
    matched = matched.filter((row) => selectionState.ids.has(row.userId));
  if (name?.value === 'zz') matched = [];
  if (grade)
    matched = matched.filter((row) => {
      const value = Number(row.customSchemas['Student']?.['grade_level']);
      return value >= grade.from && value <= grade.to;
    });
  return {
    page: userPageSchema.parse({
      rows: matched,
      matching: matched.length,
      total: kept.length,
      observedAt,
      refreshJobId: null,
    }),
  };
}

/** The one value preview that the mocked API froze, and the request that asked for it. */
const bulkPreviewId = '2f1c6a0e-6d3b-4a1f-9f0e-3c4ce0b6a910';
const bulkPreviewRequest: { body: unknown } = { body: null };
/** The targets requests of this test, to prove the server cursor use (K27 acceptance 4). */
const bulkTargetRequests: {
  disposition: string | null;
  cursor: string | null;
}[] = [];

const reviewNames = [
  'Aaliyah Brooks',
  'Aaron Whitfield',
  'Abdul Karim',
  'Abigail Chen',
  'Adam Novak',
  'Adriana Flores',
  'Amara Okafor',
  'Ben Carter',
  'Chloe Nguyen',
  'Daniel Reyes',
  'Elena Petrova',
  'Farah Haddad',
  'Grace Kim',
  'Hugo Martins',
  'Iris Chen',
  'Jonah Blake',
  'Keira Walsh',
  'Liam Osei',
];

function bulkPreview(many: boolean) {
  return {
    previewId: bulkPreviewId,
    source: 'selection',
    changes: [
      {
        schemaName: 'Student',
        fieldName: 'programs',
        mode: 'add',
        values: ['ESL'],
      },
    ],
    attributeChanges: many ? 18 : 4,
    selected: many ? 25 : 6,
    eligible: many ? 18 : 4,
    unchanged: many ? 7 : 2,
    conflicts: 0,
    oldestObservedAt: observedAt,
    stale: false,
    preparedAt: observedAt,
    expiresAt: new Date(now + 600_000).toISOString(),
    manifestDigest: 'a'.repeat(64),
  };
}

/** One page of the frozen preview rows (ten rows a page, like composition 11). */
function bulkTargets(
  disposition: 'eligible' | 'unchanged',
  cursor: string | null,
  many: boolean,
) {
  const total = disposition === 'eligible' ? (many ? 18 : 4) : many ? 7 : 2;
  const start = cursor === 'p2' ? 10 : 0;
  const end = Math.min(start + 10, total);
  const targets = Array.from({ length: end - start }, (_, offset) => {
    const index = start + offset;
    const name = reviewNames[index % reviewNames.length];
    return {
      userId: `1100000000000000${String(index + 1).padStart(4, '0')}`,
      userName: name,
      primaryEmail: `${name.toLowerCase().replaceAll(' ', '.')}@example.org`,
      attribute: 'attr:Student.programs',
      currentValue: ['Band'],
      newValue: disposition === 'eligible' ? ['Band', 'ESL'] : ['Band'],
      disposition,
      observedAt,
    };
  });
  return { targets, nextCursor: end < total ? 'p2' : null };
}

/** One frozen result row of the value job (state 10). */
function bulkResultRow(index: number) {
  const name = reviewNames[index % reviewNames.length];
  const failed = index === 3;
  return {
    operation: index + 1,
    userId: `1100000000000000${String(index + 1).padStart(4, '0')}`,
    userName: name,
    primaryEmail: `${name.toLowerCase().replaceAll(' ', '.')}@example.org`,
    attribute: 'attr:Student.programs',
    displayName: 'Programs',
    currentValue: ['Band'],
    newValue: ['Band', 'ESL'],
    outcome: failed ? 'failed' : 'succeeded',
    failureText: failed ? 'Google could not find this user.' : null,
  };
}

/** The value job that the mocked confirm answers, and its detail (design K24). */
const bulkJob = {
  jobId: '8f2b4b19-4c6a-47fd-8d0a-0f3ce4b0f2a1',
  displayId: 'UAT-014',
  revision: 1,
  action: 'set-attributes',
  status: 'completed-with-errors',
  entityType: 'user',
  scope: { kind: 'devices', deviceCount: 4 },
  requestedBy: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: 'Review administrator',
  },
  createdAt: new Date(now - 60_000).toISOString(),
  startedAt: new Date(now - 50_000).toISOString(),
  finishedAt: new Date(now - 40_000).toISOString(),
  progress: {
    total: 18,
    succeeded: 17,
    failed: 1,
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

const bulkReceipt = {
  jobId: '8f2b4b19-4c6a-47fd-8d0a-0f3ce4b0f2a1',
  displayId: bulkJob.displayId,
  status: 'accepted',
  userCount: 18,
  changeCount: 18,
};

interface SignInOptions {
  /** The status read fails with 503 until the test clears this flag (R11). */
  syncFails?: boolean;
  /** The category read fails with a missing schema scope (R11). */
  categoriesFail?: boolean;
  /** Refresh Selected answers that the selection ended (R10). */
  selectionEnds?: 'expired' | 'nothing-selected' | null;
  /** Wait for the first user row before returning. */
  expectRows?: boolean;
  /** Holds one query answer until the test releases it (R6). */
  holdQuery?: HeldQuery;
  /** The freshness read reports stale users and a running refresh (R6). */
  staleRefresh?: boolean;
  /** The session carries no users:bulk-actions grant (K27 acceptance 3). */
  omitBulk?: boolean;
  /** The preview request answers 413 (K27 acceptance 6). */
  previewFails?: boolean;
  /** The preview holds 18 proposed rows, so the review has a second page. */
  manyTargets?: boolean;
  /** Holds the preview answer until the test releases it (R1-G). */
  holdPreview?: HeldAnswer;
  /** Holds the confirmation answer until the test releases it (R1-G). */
  holdConfirm?: HeldAnswer;
}

/** The part of a query body that a held answer test reads. */
interface QueryAnswerBody {
  sort?: { field?: string };
}

/** One query answer that the test holds and releases. */
interface HeldQuery {
  matches: (body: QueryAnswerBody) => boolean;
  /** Resolves when the held request starts. */
  started: Promise<void>;
  /** Resolves when the test releases the answer. */
  gate: Promise<void>;
  begin: () => void;
  release: () => void;
}

/** One answer that the test holds and releases. */
interface HeldAnswer {
  /** Resolves when the held request starts. */
  started: Promise<void>;
  /** Resolves when the test releases the answer. */
  gate: Promise<void>;
  begin: () => void;
  release: () => void;
}

function heldAnswer(): HeldAnswer {
  let begin: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (begin = resolve));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { started, gate, begin, release };
}

function heldQuery(matches: (body: QueryAnswerBody) => boolean): HeldQuery {
  let begin: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (begin = resolve));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { matches, started, gate, begin, release };
}

async function signIn(page: Page, options: SignInOptions = {}) {
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
            grants: options.omitBulk
              ? grants.filter((grant) => grant.action !== 'users:bulk-actions')
              : grants,
            preferences: { theme: 'light', navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    if (path === '/api/users/sync') {
      if (options.syncFails)
        return route.fulfill({ status: 503, json: { code: 'unavailable' } });
      return route.fulfill({ json: { sync } });
    }
    if (path === '/api/users/attribute-categories') {
      if (options.categoriesFail)
        return route.fulfill({
          status: 503,
          json: {
            reason: 'user-schema-read-failed',
            failure: 'scope-mismatch',
          },
        });
      return route.fulfill({ json: categories });
    }
    if (path === '/api/users/org-units')
      return route.fulfill({
        json: {
          orgUnits: [
            { path: '/Students/High School', users: 3 },
            { path: '/Students/Middle School', users: 2 },
            { path: '/Staff/High School', users: 1 },
          ],
        },
      });
    if (path === '/api/users/query') {
      const body = request.postDataJSON() as QueryAnswerBody;
      if (options.holdQuery?.matches(body)) {
        options.holdQuery.begin();
        await options.holdQuery.gate;
      }
      return route.fulfill({
        json: answerFor(body),
      });
    }
    if (path === '/api/users/freshness')
      return route.fulfill({
        json: {
          freshness: options.staleRefresh
            ? { stale: 3, refreshing: true }
            : { stale: 0, refreshing: false },
        },
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
            rows
              .filter((row) => !removed.has(row.userId))
              .map((row) => row.userId),
          );
        } else if (op.op === 'deselectAll') {
          selectionState.terms = [];
          selectionState.ids = new Set();
        } else if (op.op === 'select') {
          for (const id of op.ids ?? []) selectionState.ids.add(id);
        } else if (op.op === 'deselect') {
          for (const id of op.ids ?? []) selectionState.ids.delete(id);
        }
      }
      return route.fulfill({ json: { selection: selectionSpec() } });
    }
    if (path === '/api/users/selection/refresh') {
      if (options.selectionEnds) {
        // The API ended the selection, so the selected view has no row (R10).
        selectionState.terms = [];
        selectionState.ids = new Set();
        return route.fulfill({
          status: options.selectionEnds === 'expired' ? 409 : 422,
          json: {
            reason:
              options.selectionEnds === 'expired'
                ? 'selection-expired'
                : 'nothing-selected',
          },
        });
      }
      return route.fulfill({
        json: {
          refresh: { selected: selectionState.ids.size, jobId: null },
        },
      });
    }
    if (
      path === '/api/users/attribute-previews' &&
      request.method() === 'POST'
    ) {
      bulkPreviewRequest.body = request.postDataJSON();
      if (options.previewFails)
        return route.fulfill({
          status: 413,
          json: { reason: 'payload-too-large' },
        });
      if (options.holdPreview) {
        options.holdPreview.begin();
        await options.holdPreview.gate;
      }
      return route.fulfill({
        status: 201,
        json: bulkPreview(!!options.manyTargets),
      });
    }
    if (path.startsWith('/api/users/attribute-previews/')) {
      const rest = path.slice('/api/users/attribute-previews/'.length);
      const [id, action] = rest.split('/');
      if (id !== bulkPreviewId) return route.fulfill({ status: 404, json: {} });
      if (action === 'targets') {
        const query = new URL(request.url()).searchParams;
        const disposition =
          query.get('disposition') === 'unchanged' ? 'unchanged' : 'eligible';
        const cursor = query.get('cursor');
        bulkTargetRequests.push({ disposition, cursor });
        return route.fulfill({
          json: bulkTargets(disposition, cursor, !!options.manyTargets),
        });
      }
      if (action === 'confirm') {
        if (options.holdConfirm) {
          options.holdConfirm.begin();
          await options.holdConfirm.gate;
        }
        return route.fulfill({ status: 201, json: bulkReceipt });
      }
      return route.fulfill({ json: bulkPreview(!!options.manyTargets) });
    }
    if (path === `/api/jobs/${bulkJob.displayId}`)
      return route.fulfill({ json: bulkJob });
    if (path === `/api/jobs/${bulkJob.displayId}/attribute-rows`) {
      const view = new URL(request.url()).searchParams.get('view');
      return route.fulfill({
        json: {
          rows:
            view === 'failed'
              ? [bulkResultRow(3)]
              : Array.from({ length: 10 }, (_, index) => bulkResultRow(index)),
          totals: { all: 18, failed: 1 },
          nextCursor: view === 'failed' ? null : 'r2',
        },
      });
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

async function openUsers(page: Page, options: SignInOptions = {}) {
  removed.clear();
  selectionState.ids = new Set();
  selectionState.terms = [];
  bulkPreviewRequest.body = null;
  bulkTargetRequests.length = 0;
  await signIn(page, options);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/users');
  await expect(
    page.getByRole('heading', { name: 'Users', exact: true }),
  ).toBeVisible();
  if (options.expectRows !== false) {
    await expect(
      page.getByRole('gridcell', { name: 'Aaliyah Brooks', exact: true }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  }
}

/** The user cell of a person, by row. */
function userCell(page: Page, name: string) {
  return page.getByRole('gridcell', { name, exact: true });
}

/** A layout box, or a failure when the element has none. */
function measured(
  box: { x: number; y: number; width: number; height: number } | null,
) {
  if (!box) throw new Error('The element has no layout box.');
  return box;
}

/** A cell of the row of a named user, by column id. */
function columnCell(page: Page, name: string, colId: string) {
  return page
    .getByRole('row', { name: new RegExp(name) })
    .locator(`[col-id="${colId}"]`);
}

/**
 * The position of a column header. AG Grid keeps the header DOM order fixed and
 * moves cells with inline offsets, so the DOM order proves nothing.
 */
async function headerIndex(page: Page, colId: string): Promise<number> {
  return Number(
    await page
      .locator(`.ag-header-cell[col-id="${colId}"]`)
      .first()
      .getAttribute('aria-colindex'),
  );
}

/**
 * The layout of a Columns panel row: the label content box and the revealed
 * controls. The label clips its text at the content edge, so the content edge
 * proves whether the text can run beneath the controls.
 */
async function panelRowLayout(row: Locator) {
  return row.evaluate((element) => {
    const label = element.querySelector('label') as HTMLElement;
    const actions = element.querySelector(
      '.lgr-columns-row-actions',
    ) as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(label.firstChild as Text);
    const labelBox = label.getBoundingClientRect();
    const paddingRight = Number.parseFloat(
      getComputedStyle(label).paddingRight,
    );
    const textBox = range.getBoundingClientRect();
    return {
      textLeft: textBox.left,
      textWidth: textBox.width,
      labelRight: labelBox.right,
      paddingRight,
      contentRight: labelBox.right - paddingRight,
      actionsLeft: actions.getBoundingClientRect().left,
    };
  });
}

/** Show the demonstrated attribute columns and scroll them beside the pinned Name. */
async function showAttributeColumns(page: Page) {
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
  const panel = page.locator('.lgr-columns-tool-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('checkbox', { name: 'Show Grade level' }).check();
  await panel.getByRole('checkbox', { name: 'Show Programs' }).check();
  await page
    .locator('.ag-body-horizontal-scroll-viewport')
    .evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
  // The approved states show the two attribute cells beside the pinned Name.
  await expect(
    columnCell(page, 'Aaliyah Brooks', 'attr:Student.grade_level'),
  ).toHaveText('11');
  await expect(
    columnCell(page, 'Aaliyah Brooks', 'attr:Student.programs'),
  ).toHaveText('Band');
  const name = measured(await userCell(page, 'Aaliyah Brooks').boundingBox());
  const grid = measured(await page.locator('.ag-root-wrapper').boundingBox());
  expect(name.x - grid.x).toBeLessThan(300);
  return panel;
}

test('reproduces UM state 01: the users grid', async ({ page }) => {
  await openUsers(page);
  const tab = page.getByRole('tab', { name: 'Users', exact: true });
  await expect(tab).toBeVisible();
  // The approved tab is 48 px high with its label padded (R13).
  const tabBox = measured(await tab.boundingBox());
  expect(tabBox.height).toBeGreaterThanOrEqual(47);
  expect(tabBox.height).toBeLessThanOrEqual(49);
  // The approved tab is a short padded control, not a full-width bar.
  expect(tabBox.width).toBeLessThanOrEqual(200);
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add a filter' }),
  ).toBeVisible();
  await expect(
    page.getByText('6 matching users · 6 in district'),
  ).toBeVisible();
  // The Name column stays pinned at the left (record default 4).
  const name = userCell(page, 'Aaliyah Brooks');
  const box = await name.boundingBox();
  expect(box).not.toBeNull();
  const grid = await page.locator('.ag-root-wrapper').boundingBox();
  expect(box!.x - grid!.x).toBeLessThan(300);
  // Card K11 makes the row name the link to the details page (GRID-03).
  await expect(
    page.getByRole('link', { name: 'Aaliyah Brooks', exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Open details for Aaliyah Brooks' }),
  ).toBeVisible();
  await page.screenshot({
    path: `${scratch}/um-01-users-grid.png`,
    fullPage: false,
  });
});

test('reproduces UM state 02: the Columns panel and focus return (UI-09)', async ({
  page,
}) => {
  await openUsers(page);
  // The approved state shows Grade level and Programs beside the pinned Name.
  const panel = await showAttributeColumns(page);
  // The pointer left the panel after the checkbox clicks. The approved capture
  // holds rows at rest, and a hovered row shows its move controls by design.
  await page.mouse.move(0, 0);
  // The approved panel is 258 px wide beside the 32 px side bar (R13).
  const panelBox = measured(await panel.boundingBox());
  expect(panelBox.width).toBeGreaterThanOrEqual(250);
  expect(panelBox.width).toBeLessThanOrEqual(266);
  await expect(
    panel.getByText('Student information', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText('Grade level', { exact: true })).toBeVisible();
  await expect(panel.getByText('Programs', { exact: true })).toBeVisible();
  // The approved 258 px panel holds the full labels, not an ellipsis (R13).
  const gradeLabel = panel.getByText('Grade level', { exact: true });
  expect(
    await gradeLabel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  // The panel lists the Name column and the category groups, and no grouping item.
  await expect(panel.getByText('Name', { exact: true })).toBeVisible();
  await expect(panel.getByText('Row Group', { exact: false })).toHaveCount(0);
  await page.screenshot({
    path: `${scratch}/um-02-columns-panel.png`,
    fullPage: false,
  });
  // The panel content scrolls to the category groups that the state also shows.
  await panel
    .locator(
      'xpath=ancestor::div[contains(@class,"lgr-side-bar-panel-content")]',
    )
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  await expect(
    panel.getByText('Student information', { exact: true }),
  ).toBeVisible();
  await expect(
    columnCell(page, 'Aaliyah Brooks', 'attr:Student.grade_level'),
  ).toHaveText('11');
  await page.screenshot({
    path: `${scratch}/um-02b-columns-groups.png`,
    fullPage: false,
  });
  // UI-09: the Columns tab closes the panel and keeps focus on the opening control.
  const columnsTab = page.getByRole('tab', { name: 'Columns', exact: true });
  await columnsTab.click();
  await expect(panel).toBeHidden();
  await expect(columnsTab).toBeFocused();
});

test('moves a Users column from the keyboard and keeps the approved rest look (UI-09)', async ({
  page,
}) => {
  await openUsers(page);
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
  const panel = page.locator('.lgr-columns-tool-panel');
  await expect(panel).toBeVisible();
  const leafRows = panel.locator('.lgr-columns-row[data-column-id]');
  const statusRow = panel.locator('.lgr-columns-row[data-column-id="status"]');

  // State 02 at rest: the pointer sits outside the panel and no row holds focus,
  // so no move control shows. The pin controls are out of the tab order entirely.
  const restOpacity = await leafRows
    .locator('.lgr-columns-row-actions')
    .evaluateAll((list) => list.map((el) => getComputedStyle(el).opacity));
  expect(restOpacity.length).toBeGreaterThan(0);
  expect(restOpacity.every((opacity) => opacity === '0')).toBe(true);
  const pinButtons = panel.locator(
    '.lgr-columns-row-actions button[aria-label^="Pin "], .lgr-columns-row-actions button[aria-label^="Unpin "]',
  );
  expect(await pinButtons.count()).toBeGreaterThan(0);
  expect(
    await pinButtons.evaluateAll((list) =>
      list.every((el) => getComputedStyle(el).display === 'none'),
    ),
  ).toBe(true);
  expect(
    await panel.getByRole('button', { name: /^(Pin|Unpin) / }).count(),
  ).toBe(0);
  await page.screenshot({
    path: `${scratch}/um-02c-columns-panel-rest.png`,
    fullPage: false,
  });

  // The move runs on the keyboard: Tab reaches the move control and Enter moves
  // the column. The org unit cell starts directly before Status.
  const before = await headerIndex(page, 'status');
  expect(before).toBe((await headerIndex(page, 'orgUnitPath')) + 1);
  await panel.getByRole('searchbox', { name: 'Search columns' }).focus();
  const moveUp = panel.getByRole('button', {
    name: 'Move Status up',
    exact: true,
  });
  for (let press = 0; press < 40; press += 1) {
    if (await moveUp.evaluate((element) => element === document.activeElement))
      break;
    await page.keyboard.press('Tab');
  }
  await expect(moveUp).toBeFocused();
  // The focused row shows its move controls.
  expect(
    await statusRow
      .locator('.lgr-columns-row-actions')
      .evaluate((element) => getComputedStyle(element).opacity),
  ).toBe('1');
  await page.keyboard.press('Enter');

  // The header order changes, and focus returns to the moved row's control.
  await expect
    .poll(async () => (await headerIndex(page, 'status')) < before)
    .toBe(true);
  expect(await headerIndex(page, 'status')).toBeLessThan(
    await headerIndex(page, 'orgUnitPath'),
  );
  await expect(
    page.getByRole('button', { name: 'Move Status up', exact: true }),
  ).toBeFocused();
  // Wait for the header animation to settle before the hand-off capture. The
  // logical order already changed; this keeps two headers from overlapping in
  // the screenshot.
  await expect
    .poll(async () => {
      const [status, orgUnit] = await Promise.all([
        page.locator('.ag-header-cell[col-id="status"]').first().boundingBox(),
        page
          .locator('.ag-header-cell[col-id="orgUnitPath"]')
          .first()
          .boundingBox(),
      ]);
      return (
        status !== null &&
        orgUnit !== null &&
        status.x + status.width <= orgUnit.x + 1
      );
    })
    .toBe(true);
  await page.screenshot({
    path: `${scratch}/um-02d-columns-panel-focused.png`,
    fullPage: false,
  });

  // A Tab sweep never lands on a pin or unpin control.
  const reached: string[] = [];
  for (let press = 0; press < 40; press += 1) {
    await page.keyboard.press('Tab');
    reached.push(
      await page.evaluate(
        () => document.activeElement?.getAttribute('aria-label') ?? '',
      ),
    );
  }
  expect(reached.filter((label) => /^(Pin|Unpin) /.test(label))).toEqual([]);
});

test('keeps an active Columns row label clear of its move controls (UI-09)', async ({
  page,
}) => {
  await openUsers(page);
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
  const panel = page.locator('.lgr-columns-tool-panel');
  await expect(panel).toBeVisible();
  // The Device program group holds the longest leaf label of the fixture.
  const row = panel.locator(
    '.lgr-columns-row[data-column-id="attr:Device.take_home"]',
  );
  await expect(row).toHaveAttribute('data-column-movable', 'true');
  await expect(row.locator('label')).toHaveText('Take-home approved');
  await row.scrollIntoViewIfNeeded();

  // A row at rest keeps the approved label width: no reserved space and the
  // whole label visible beside the grip.
  await page.mouse.move(0, 0);
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  const rest = await panelRowLayout(row);
  expect(rest.paddingRight).toBe(0);
  expect(rest.textWidth).toBeLessThanOrEqual(
    rest.labelRight - rest.textLeft + 1,
  );

  // Tab reaches the move control of the long label, so the revealed controls
  // must clear the text and the 5 px focus ring around them.
  await panel.getByRole('searchbox', { name: 'Search columns' }).focus();
  const moveUp = page.getByRole('button', {
    name: 'Move Take-home approved up',
    exact: true,
  });
  for (let press = 0; press < 120; press += 1) {
    if (await moveUp.evaluate((element) => element === document.activeElement))
      break;
    await page.keyboard.press('Tab');
  }
  await expect(moveUp).toBeFocused();
  const focused = await panelRowLayout(row);
  expect(focused.actionsLeft - focused.contentRight).toBeGreaterThanOrEqual(5);
  // The reserved space makes the label truncate with an ellipsis instead of
  // running beneath the controls.
  expect(focused.textWidth).toBeGreaterThan(
    focused.contentRight - focused.textLeft,
  );
  await page.screenshot({
    path: `${scratch}/um-02e-columns-panel-long-label.png`,
    fullPage: false,
  });

  // The pointer reveals the same separation, and both states give the space
  // back when the row goes idle.
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await row.locator('label').hover();
  const hovered = await panelRowLayout(row);
  expect(hovered.actionsLeft - hovered.contentRight).toBeGreaterThanOrEqual(5);
  await page.screenshot({
    path: `${scratch}/um-02f-columns-panel-long-label-hover.png`,
    fullPage: false,
  });
  await page.mouse.move(0, 0);
  await expect
    .poll(async () => (await panelRowLayout(row)).paddingRight)
    .toBe(0);
});

test('reproduces UM state 03: the attribute filter editor', async ({
  page,
}) => {
  await openUsers(page);
  // The approved state shows Grade level and Programs beside the pinned Name.
  await showAttributeColumns(page);
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
  await expect(page.locator('.lgr-columns-tool-panel')).toBeHidden();
  await page.getByRole('button', { name: 'Add a filter' }).click();
  const field = page.getByRole('combobox', { name: 'Filter field' });
  await field.fill('Grade');
  await page.getByRole('option', { name: 'Grade level', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Grade level' });
  await expect(editor).toBeVisible();
  // The approved range editor is 320 px wide with two equal tracks (R13).
  const editorBox = measured(await editor.boundingBox());
  expect(editorBox.width).toBeGreaterThanOrEqual(310);
  expect(editorBox.width).toBeLessThanOrEqual(340);
  await editor.getByLabel('From').fill('9');
  await editor.getByLabel('To').fill('12');
  const query = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/users/query' &&
      (request.postDataJSON()?.predicates ?? []).some(
        (item: any) => item.operator === 'numberRange',
      ),
  );
  await editor.getByRole('button', { name: 'Apply' }).click();
  const request = await query;
  expect(request.postDataJSON().predicates).toContainEqual({
    field: 'attribute',
    schemaName: 'Student',
    fieldName: 'grade_level',
    operator: 'numberRange',
    from: 9,
    to: 12,
  });
  await expect(page.getByText('Grade level 9 to 12')).toBeVisible();
  // The filter runs: Aaliyah (11) and Abigail (9) and Adriana (12) remain.
  await expect(userCell(page, 'Aaliyah Brooks')).toBeVisible();
  await expect(userCell(page, 'Abdul Karim')).toHaveCount(0);
  // UI-09: the initiating control holds focus after the editor closes.
  await expect(
    page.getByRole('button', { name: 'Add a filter' }),
  ).toBeFocused();
  // The approved state reopens the editor from the applied chip.
  const chip = page.getByRole('button', {
    name: 'Grade level 9 to 12',
    exact: true,
  });
  await chip.click();
  const reopened = page.getByRole('dialog', { name: 'Grade level' });
  await expect(reopened).toBeVisible();
  await expect(reopened.getByLabel('From')).toHaveValue('9');
  await expect(reopened.getByLabel('To')).toHaveValue('12');
  await expect(
    columnCell(page, 'Aaliyah Brooks', 'attr:Student.grade_level'),
  ).toBeVisible();
  await expect(
    columnCell(page, 'Aaliyah Brooks', 'attr:Student.programs'),
  ).toBeVisible();
  await page.screenshot({
    path: `${scratch}/um-03-attribute-filter.png`,
    fullPage: false,
  });
  await reopened.getByRole('button', { name: 'Cancel' }).click();
  await expect(chip).toBeFocused();
});

test('reproduces UM state 13: no matches', async ({ page }) => {
  await openUsers(page);
  await page.getByRole('button', { name: 'Add a filter' }).click();
  await page.getByRole('combobox', { name: 'Filter field' }).fill('Name');
  await page.getByRole('option', { name: 'Name', exact: true }).first().click();
  const editor = page.getByRole('dialog', { name: 'Name' });
  await editor.getByLabel('Value').fill('zz');
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('No users match these filters')).toBeVisible();
  await expect(
    page.getByText('Check the name or email, or clear the current filters.'),
  ).toBeVisible();
  await expect(
    page.getByRole('status').getByRole('button', { name: 'Clear filters' }),
  ).toBeVisible();
  await page.screenshot({
    path: `${scratch}/um-13-no-matches.png`,
    fullPage: false,
  });
});

test('keeps the Devices grid font on the user cells (notes ruling 3)', async ({
  page,
}) => {
  await openUsers(page);
  const usersFont = await userCell(page, 'Aaliyah Brooks').evaluate(
    (element) => getComputedStyle(element).fontFamily,
  );
  // The built Devices grid takes the theme font. Read it from the running app.
  await page.route('**/api/devices/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/devices/sync')
      return route.fulfill({
        json: {
          sync: {
            customerId,
            generation: 1,
            status: 'ready',
            observedAt,
            deviceCount: 1,
            failure: null,
            telemetryFailure: null,
            startedAt: null,
            checkedAt: null,
            stale: false,
          },
        },
      });
    if (path === '/api/devices/query')
      return route.fulfill({
        json: {
          page: {
            rows: [
              {
                deviceId: 'synthetic-device-1',
                serialNumber: 'C0A1-0001',
                model: 'Lenovo 100e Gen 4',
                assetTag: null,
                orgUnitPath: '/',
                lastContact: observedAt,
                annotatedLocation: null,
                annotatedUser: null,
                notes: null,
                status: 'ACTIVE',
                battery: { status: 'no-report' },
                lastEntitySync: observedAt,
                stale: false,
              },
            ],
            matching: 1,
            total: 1,
            observedAt,
            refreshJobId: null,
          },
        },
      });
    if (path === '/api/devices/org-units')
      return route.fulfill({ json: { orgUnits: [] } });
    if (path === '/api/devices/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (path === '/api/devices/updates/access')
      return route.fulfill({
        json: {
          state: 'granted',
          scope:
            'https://www.googleapis.com/auth/admin.directory.device.chromeos',
          failure: null,
          checkedAt: observedAt,
        },
      });
    if (path === '/api/devices/selection')
      return route.fulfill({
        json: {
          selection: {
            terms: [],
            groups: [],
            added: 0,
            excluded: 0,
            selectedCount: 0,
            expiredAt: null,
          },
        },
      });
    if (path === '/api/devices/selection/resolve')
      return route.fulfill({ json: { selected: {} } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/devices');
  await expect(
    page.getByRole('gridcell', { name: 'Lenovo 100e Gen 4', exact: true }),
  ).toBeVisible();
  const devicesFont = await page
    .getByRole('gridcell', { name: 'Lenovo 100e Gen 4', exact: true })
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(usersFont).toBe(devicesFont);
});

test('removes a user when the feed reports a removal (R7)', async ({
  page,
}) => {
  await openUsers(page);
  const streams = liveStreams(page);
  await streams.waitForOpen('/api/events');
  const target = rows[0];
  removed.add(target.userId);
  await streams.send('/api/events', 'entity-batch', {
    type: 'entity-batch',
    entityType: 'user',
    userIds: [],
    removedIds: [target.userId],
  });
  // The removed identity leaves without navigation or a full-sync event.
  await expect(
    page.getByRole('gridcell', { name: target.fullName, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('5 matching users · 5 in district'),
  ).toBeVisible();
});

test('keeps a text chip operator when it reopens (R5)', async ({ page }) => {
  await openUsers(page);
  await page.getByRole('button', { name: 'Add a filter' }).click();
  await page.getByRole('combobox', { name: 'Filter field' }).fill('Name');
  await page.getByRole('option', { name: 'Name', exact: true }).first().click();
  const editor = page.getByRole('dialog', { name: 'Name' });
  await editor.getByLabel('Operator').selectOption('equals');
  await editor.getByLabel('Value').fill('Aaliyah Brooks');
  await editor.getByRole('button', { name: 'Apply' }).click();
  const chip = page.getByRole('button', { name: /^Name / });
  await expect(chip).toContainText('is:');
  await chip.click();
  await expect(editor.getByLabel('Operator')).toHaveValue('equals');
  await expect(editor.getByLabel('Value')).toHaveValue('Aaliyah Brooks');
  await editor.getByRole('button', { name: 'Cancel' }).click();
});

test('keeps a date chip operator when it reopens (R5)', async ({ page }) => {
  await openUsers(page);
  await page.getByRole('button', { name: 'Add a filter' }).click();
  await page
    .getByRole('combobox', { name: 'Filter field' })
    .fill('Last sign-in');
  await page
    .getByRole('option', { name: 'Last sign-in', exact: true })
    .first()
    .click();
  const editor = page.getByRole('dialog', { name: 'Last sign-in' });
  await editor.getByLabel('Operator').selectOption('after');
  await editor.getByLabel('Date').fill('2026-10-31');
  await editor.getByRole('button', { name: 'Apply' }).click();
  const chip = page.getByRole('button', { name: /^Last sign-in / });
  await expect(chip).toContainText('on or after');
  await chip.click();
  await expect(editor.getByLabel('Operator')).toHaveValue('after');
  await expect(editor.getByLabel('Date')).toHaveValue('2026-10-31');
  await editor.getByRole('button', { name: 'Cancel' }).click();
});

test('recovers a failed status read through Retry (R11)', async ({ page }) => {
  const options: SignInOptions = { syncFails: true, expectRows: false };
  await openUsers(page, options);
  await expect(
    page.getByRole('alert').getByText('User directory status is unavailable.'),
  ).toBeVisible();
  // A failed read is not still shown as a loading page.
  await expect(page.getByText('Loading users…')).toHaveCount(0);
  options.syncFails = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    page.getByRole('gridcell', { name: 'Aaliyah Brooks', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('names the schema scope when the category read fails (R11)', async ({
  page,
}) => {
  await openUsers(page, { categoriesFail: true });
  await expect(
    page.getByText('Custom attribute columns are unavailable.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'https://www.googleapis.com/auth/admin.directory.userschema.readonly',
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Open Google connection' }),
  ).toBeVisible();
});

/** Adds a filter chip through the field combobox and its editor (GRID-04). */
async function addChip(
  page: Page,
  field: string,
  fill?: (editor: Locator) => Promise<void>,
): Promise<void> {
  await page.getByRole('button', { name: 'Add a filter' }).click();
  await page.getByRole('combobox', { name: 'Filter field' }).fill(field);
  await page.getByRole('option', { name: field, exact: true }).first().click();
  const editor = page.getByRole('dialog', { name: field });
  await expect(editor).toBeVisible();
  if (fill) await fill(editor);
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(editor).toBeHidden();
}

/** The predicates of the next query that the test waits for. */
function queryPredicates(page: Page, match: (predicates: any[]) => boolean) {
  return page
    .waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/api/users/query' &&
        match(request.postDataJSON()?.predicates ?? []),
      { timeout: 15_000 },
    )
    .then((request) => request.postDataJSON()?.predicates ?? []);
}

/** Applies a column filter model the way the column filter does. */
async function setFilterModel(page: Page, model: Record<string, unknown>) {
  await page.evaluate((next) => {
    const grid = (
      window as unknown as { ng: { getComponent: (el: Element) => any } }
    ).ng.getComponent(document.querySelector('app-user-grid')!);
    grid.api.setFilterModel(next);
  }, model);
}

/** Waits until the category read added one attribute column to the grid (R6). */
async function waitForAttributeColumn(page: Page, colId: string) {
  await page.waitForFunction((id) => {
    const host = document.querySelector('app-user-grid');
    if (!host) return false;
    const grid = (
      window as unknown as {
        ng?: {
          getComponent: (element: Element) => {
            api?: { getColumn: (name: string) => unknown };
          };
        };
      }
    ).ng?.getComponent(host);
    return !!grid?.api?.getColumn(id);
  }, colId);
}

/** Waits a quiet window and fails when the page requests one URL path (R6). */
async function expectNoRequest(page: Page, path: string): Promise<void> {
  const requested = page
    .waitForRequest((request) => new URL(request.url()).pathname === path, {
      timeout: 400,
    })
    .then(
      () => true,
      () => false,
    );
  expect(await requested).toBe(false);
}

test('sends the filter-only chips with every query (R4)', async ({ page }) => {
  await openUsers(page);
  const alias = { field: 'aliases', operator: 'contains', value: 'a.brooks' };
  const hasValue = {
    field: 'attribute',
    schemaName: 'Student',
    fieldName: 'homeroom',
    operator: 'hasValue',
  };
  // 1. An alias has no column filter, so its chip alone must run the query.
  const aliasQuery = queryPredicates(page, (predicates) =>
    predicates.some((item) => item.field === 'aliases'),
  );
  await addChip(page, 'Alias', async (editor) => {
    await editor.getByLabel('Value').fill('a.brooks');
  });
  expect(await aliasQuery).toEqual([alias]);
  await expect(
    page.getByRole('button', { name: 'Alias contains: a.brooks', exact: true }),
  ).toBeVisible();

  // 2. A has-a-value chip has no column filter either.
  const emptyValueQuery = queryPredicates(page, (predicates) =>
    predicates.some((item) => item.operator === 'hasValue'),
  );
  await addChip(page, 'Homeroom');
  expect(await emptyValueQuery).toEqual([alias, hasValue]);
  await expect(
    page.getByRole('button', { name: 'Homeroom has a value', exact: true }),
  ).toBeVisible();

  // 3. A column filter joins the chips instead of replacing them.
  const statusQuery = queryPredicates(page, (predicates) =>
    predicates.some((item) => item.field === 'status'),
  );
  await setFilterModel(page, {
    status: { filterType: 'set', values: ['active'] },
  });
  expect(await statusQuery).toEqual([
    { field: 'status', operator: 'is', values: ['active'] },
    alias,
    hasValue,
  ]);
  await expect(
    page.getByRole('button', { name: 'Alias contains: a.brooks', exact: true }),
  ).toBeVisible();

  // 3b. Select All captures the column filter and the filter-only chips.
  const selectAll = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/users/selection/ops',
  );
  await page.locator('.lgr-ssrm-selection-footer__select-all').click();
  const ops = (await selectAll).postDataJSON().ops;
  expect(ops[0].predicates).toEqual([
    { field: 'status', operator: 'is', values: ['active'] },
    alias,
    hasValue,
  ]);

  // 4. The next query of a sort keeps the filter-only chips.
  const sortQuery = queryPredicates(page, (predicates) =>
    predicates.some((item) => item.field === 'aliases'),
  );
  await page.locator('.ag-header-cell[col-id="fullName"]').click();
  expect(await sortQuery).toEqual([
    { field: 'status', operator: 'is', values: ['active'] },
    alias,
    hasValue,
  ]);

  // 5. Removing the alias chip drops only that predicate.
  const removeQuery = queryPredicates(
    page,
    (predicates) =>
      predicates.some((item) => item.field === 'status') &&
      !predicates.some((item) => item.field === 'aliases'),
  );
  await page
    .getByRole('button', { name: 'Remove filter Alias contains: a.brooks' })
    .click();
  expect(await removeQuery).toEqual([
    { field: 'status', operator: 'is', values: ['active'] },
    hasValue,
  ]);
  await expect(
    page.getByRole('button', { name: 'Alias contains: a.brooks', exact: true }),
  ).toHaveCount(0);
});

test('shows the empty result of a column filter that matches no row (R6)', async ({
  page,
}) => {
  await openUsers(page);
  await waitForAttributeColumn(page, 'attr:Device.take_home');
  // An empty BOOLEAN set filter matches nobody, and the query cannot express it.
  await setFilterModel(page, {
    'attr:Device.take_home': { filterType: 'set', values: [] },
  });
  // The counts of the grid follow the empty result, although the recovery card
  // replaces the grid region (UM state 13).
  await expect(page.getByText('0 matching users · 6 in district')).toHaveCount(
    1,
  );
  await expect(page.getByText('No users match these filters')).toBeVisible();
  await expect(
    page.getByRole('status').getByRole('button', { name: 'Clear filters' }),
  ).toBeEnabled();
  await page.screenshot({
    path: `${scratch}/um-13b-column-filter-empty.png`,
    fullPage: false,
  });
  const toolbarClear = page
    .getByRole('button', { name: 'Clear filters' })
    .first();
  await expect(toolbarClear).toBeEnabled();
  // The pinned Name column shows no row.
  await expect(userCell(page, 'Aaliyah Brooks')).toHaveCount(0);

  // Clear filters drops the column filter that the query cannot express.
  await toolbarClear.click();
  await expect(
    page.getByText('6 matching users · 6 in district'),
  ).toBeVisible();
  await expect(page.getByText('No users match these filters')).toHaveCount(0);
  await expect(userCell(page, 'Aaliyah Brooks')).toBeVisible();
});

test('keeps the empty count when an older sort query answers later (R6)', async ({
  page,
}) => {
  // The sort request stays open. The empty column filter replaces its result.
  const heldRequest = heldQuery(
    (body) => body?.sort?.field === 'lastLoginTime',
  );
  await openUsers(page, { holdQuery: heldRequest });
  await waitForAttributeColumn(page, 'attr:Device.take_home');
  await page.locator('.ag-header-cell[col-id="lastLoginTime"]').click();
  await heldRequest.started;
  await setFilterModel(page, {
    'attr:Device.take_home': { filterType: 'set', values: [] },
  });
  await expect(page.getByText('0 matching users · 6 in district')).toHaveCount(
    1,
  );
  const answered = page.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).pathname === '/api/users/query' &&
      request.postDataJSON()?.sort?.field === 'lastLoginTime'
    );
  });
  // A published old count would count that dataset again. The empty result does not.
  const quiet = expectNoRequest(page, '/api/users/freshness');
  heldRequest.release();
  await answered;
  await quiet;
  // The old answer holds six rows. The empty result keeps the zero count.
  await expect(page.getByText('0 matching users · 6 in district')).toHaveCount(
    1,
  );
  await expect(page.getByText('No users match these filters')).toBeVisible();
});

test('keeps the empty result when an event recounts the previous query (R6)', async ({
  page,
}) => {
  await openUsers(page, { staleRefresh: true });
  await waitForAttributeColumn(page, 'attr:Device.take_home');
  await setFilterModel(page, {
    'attr:Device.take_home': { filterType: 'set', values: [] },
  });
  await expect(page.getByText('0 matching users · 6 in district')).toHaveCount(
    1,
  );
  const streams = liveStreams(page);
  await streams.waitForOpen('/api/events');
  // A user entity event recounts the counted query. The empty result counts nothing.
  const quiet = expectNoRequest(page, '/api/users/freshness');
  await streams.send('/api/events', 'entity-batch', {
    type: 'entity-batch',
    entityType: 'user',
    userIds: [],
    removedIds: [],
  });
  await quiet;
  await expect(page.getByText('0 matching users · 6 in district')).toHaveCount(
    1,
  );
  await expect(page.getByText(/Refreshing \d+ of/)).toHaveCount(0);
  await expect(page.getByText('No users match these filters')).toBeVisible();
});

for (const ended of ['expired', 'nothing-selected'] as const) {
  test(`leaves Show All Selected when the API ends the selection (${ended}) (R10)`, async ({
    page,
  }) => {
    await openUsers(page, { selectionEnds: ended });
    await page
      .getByRole('row', { name: /Aaliyah Brooks/ })
      .getByRole('checkbox')
      .first()
      .click();
    const showSelected = page.getByRole('button', {
      name: 'Show All Selected (1)',
    });
    await expect(showSelected).toBeVisible();
    await showSelected.click();
    // The selected dataset holds one row, and the district total stays.
    await expect(
      page.getByText('1 matching users · 6 in district'),
    ).toBeVisible();
    await expect(userCell(page, 'Abdul Karim')).toHaveCount(0);

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('menuitem', { name: /Refresh Selected/ }).click();
    await expect(
      page.getByText(
        ended === 'expired'
          ? 'Your selection expired. Select the users again.'
          : 'The selection holds no users.',
      ),
    ).toBeVisible();
    // The grid leaves the empty selected dataset and shows every user again.
    await expect(
      page.getByText('6 matching users · 6 in district'),
    ).toBeVisible();
    await expect(userCell(page, 'Abdul Karim')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Show All Selected (0)' }),
    ).toBeDisabled();
    // Refresh Selected has nothing to refresh.
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(
      page.getByRole('menuitem', { name: /Refresh Selected/ }),
    ).toBeDisabled();
  });
}

/** Select every user of the fixture through the row checkboxes. */
async function selectEveryUser(page: Page) {
  for (const person of people) {
    await page
      .getByRole('row', { name: new RegExp(person.name) })
      .getByRole('checkbox')
      .first()
      .click();
  }
  await expect(
    page.getByRole('button', { name: `Show All Selected (${people.length})` }),
  ).toBeVisible();
}

/** Open the Set attributes setup from the Bulk Actions menu (state 08). */
async function openSetAttributes(page: Page): Promise<Locator> {
  await selectEveryUser(page);
  await page.getByRole('button', { name: 'Bulk Actions' }).click();
  await page.getByRole('menuitem', { name: 'Set attributes' }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Set attributes' }),
  ).toBeVisible();
  return dialog;
}

/** Choose one Attribute option, and wait for its panel to close before a capture. */
async function pickAttribute(page: Page, dialog: Locator, name: string) {
  await dialog.getByRole('combobox', { name: 'Attribute' }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
}

/** Choose Programs and add the ESL value (states 08 and 09). */
async function choosePrograms(page: Page, dialog: Locator) {
  await pickAttribute(page, dialog, 'Programs');
  const input = dialog.getByRole('textbox', { name: 'Add a Programs value' });
  await input.fill('ESL');
  await input.press('Enter');
  await expect(dialog.getByText('Text · Multiple values')).toBeVisible();
}

test('reproduces UM states 07 to 09: the Bulk Actions menu, setup, and review', async ({
  page,
}) => {
  await openUsers(page, { manyTargets: true });
  await selectEveryUser(page);
  await page.getByRole('button', { name: 'Bulk Actions' }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Set attributes' }),
  ).toBeVisible();
  // The menu enter animation settles before the capture.
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${scratch}/um-07-bulk-actions-menu.png`,
    fullPage: false,
  });
  await page.getByRole('menuitem', { name: 'Set attributes' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('6 selected users')).toBeVisible();

  await pickAttribute(page, dialog, 'Programs');
  await expect(dialog.getByText('Text · Multiple values')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Add values' })).toBeChecked();
  await expect(
    dialog.getByRole('radio', { name: 'Replace all values' }),
  ).toBeVisible();
  // The approved state 08 shows the entered value, so the capture holds ESL.
  const input = dialog.getByRole('textbox', { name: 'Add a Programs value' });
  await input.fill('ESL');
  await input.press('Enter');
  await page.evaluate(() => document.fonts.ready);
  const setupDialog = measured(await dialog.boundingBox());
  const fields = dialog.locator('mat-form-field');
  const categoryBox = measured(await fields.nth(0).boundingBox());
  const attributeBox = measured(await fields.nth(1).boundingBox());
  const valueBox = measured(await fields.nth(2).boundingBox());
  const modeCard = measured(
    await dialog.locator('.option-card').first().boundingBox(),
  );
  // The approved state 08 geometry (R1-E).
  expect(setupDialog.width).toBe(480);
  expect(setupDialog.height).toBeGreaterThanOrEqual(556);
  expect(setupDialog.height).toBeLessThanOrEqual(558);
  expect(attributeBox.y - (categoryBox.y + categoryBox.height)).toBe(16);
  expect(modeCard.height).toBe(48);
  expect(valueBox.height).toBe(56);
  await page.screenshot({
    path: `${scratch}/um-08-set-attributes-dialog.png`,
    fullPage: false,
  });

  await dialog.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(dialog.locator('tbody tr')).toHaveCount(10);
  await expect(
    dialog.locator('.count-equation').getByText('No change needed'),
  ).toBeVisible();
  await expect(
    dialog.locator('.count-equation').getByText('Proposed'),
  ).toBeVisible();
  await expect(dialog.getByText('Programs · Add values · ESL')).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Set attributes on 18 users' }),
  ).toBeEnabled();
  await expect(dialog.getByText('1–10 of 18 proposed changes')).toBeVisible();
  const reviewBox = measured(await dialog.boundingBox());
  const reviewTable = dialog.locator('.report-table');
  const userHeader = measured(
    await reviewTable.locator('th').nth(0).boundingBox(),
  );
  const emailHeader = measured(
    await reviewTable.locator('th').nth(1).boundingBox(),
  );
  const firstRow = measured(
    await reviewTable.locator('tbody tr').first().boundingBox(),
  );
  const reviewPagerButtons = dialog.locator(
    '.report-pager .pager-buttons button',
  );
  const reviewPagerFirst = measured(
    await reviewPagerButtons.nth(0).boundingBox(),
  );
  const reviewPagerSecond = measured(
    await reviewPagerButtons.nth(1).boundingBox(),
  );
  // The approved state 09 composition (R1-F): 1,120 px wide, 240/260 leading
  // columns, 35 px rows, an app-surface header, and an 8 px pager gap.
  expect(reviewBox.width).toBe(1120);
  expect(reviewBox.height).toBeGreaterThanOrEqual(733);
  expect(reviewBox.height).toBeLessThanOrEqual(736);
  expect(userHeader.width).toBe(240);
  expect(emailHeader.width).toBe(260);
  expect(firstRow.height).toBe(35);
  expect(
    await reviewTable
      .locator('th')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe('rgb(248, 250, 252)');
  expect(
    reviewPagerSecond.x - (reviewPagerFirst.x + reviewPagerFirst.width),
  ).toBe(8);
  await page.screenshot({
    path: `${scratch}/um-09-set-attributes-review.png`,
    fullPage: false,
  });

  // The request carries the selection key and the changes only (acceptance 4).
  const body = bulkPreviewRequest.body as {
    gridId: string;
    tabId: string;
    changes: unknown;
  };
  expect(Object.keys(body).sort()).toEqual(['changes', 'gridId', 'tabId']);
  expect(body.gridId).toBe('users');
  expect(body.tabId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.changes).toEqual([
    {
      schemaName: 'Student',
      fieldName: 'programs',
      mode: 'add',
      values: ['ESL'],
    },
  ]);
});

test('reproduces UM state 10: the confirmed job and its result rows', async ({
  page,
}) => {
  await openUsers(page, { manyTargets: true });
  const dialog = await openSetAttributes(page);
  await choosePrograms(page, dialog);
  await dialog.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(dialog.locator('tbody tr')).toHaveCount(10);
  await dialog
    .getByRole('button', { name: 'Set attributes on 18 users' })
    .click();

  await expect(
    dialog.getByText('Job UAT-014 · Completed with errors'),
  ).toBeVisible();
  await expect(dialog.getByText('Finished', { exact: false })).toBeVisible();
  await expect(
    dialog.getByText('Executed by Review administrator'),
  ).toBeVisible();
  await expect(
    dialog.getByRole('link', { name: 'UAT-014', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('columnheader', { name: 'Outcome' }),
  ).toBeVisible();
  await expect(dialog.locator('tbody tr')).toHaveCount(10);
  await expect(
    dialog.getByText('Google could not find this user.'),
  ).toBeVisible();
  await expect(dialog.getByText('1–10 of 18 changes')).toBeVisible();
  const resultsTable = dialog.locator('.report-table');
  const userHeader = measured(
    await resultsTable.locator('th').nth(0).boundingBox(),
  );
  const emailHeader = measured(
    await resultsTable.locator('th').nth(1).boundingBox(),
  );
  const normalRow = measured(
    await resultsTable.locator('tbody tr').first().boundingBox(),
  );
  const pagerButtons = dialog.locator('.report-pager .pager-buttons button');
  const firstPager = measured(await pagerButtons.nth(0).boundingBox());
  const secondPager = measured(await pagerButtons.nth(1).boundingBox());
  const failedRow = measured(
    await resultsTable
      .locator('tbody tr', {
        hasText: 'Google could not find this user.',
      })
      .boundingBox(),
  );
  // The approved state 10 composition (R1-F): shared 240/260 leading columns,
  // 36 px rows, a 58 px failed row, a full-width job band, and an 8 px pager gap.
  expect(measured(await dialog.boundingBox()).width).toBe(1120);
  expect(measured(await dialog.boundingBox()).height).toBeGreaterThanOrEqual(
    790,
  );
  expect(measured(await dialog.boundingBox()).height).toBeLessThanOrEqual(810);
  expect(userHeader.width).toBe(240);
  expect(emailHeader.width).toBe(260);
  expect(normalRow.height).toBe(36);
  expect(failedRow.height).toBe(58);
  expect(secondPager.x - (firstPager.x + firstPager.width)).toBe(8);
  expect(
    measured(await dialog.locator('.job-item').first().boundingBox()).width,
  ).toBe(1070);
  expect(
    await dialog
      .getByRole('link', { name: 'Open details for Aaliyah Brooks' })
      .evaluate((element) => getComputedStyle(element).textDecorationLine),
  ).toBe('none');
  expect(
    await resultsTable
      .locator('.current-value')
      .first()
      .evaluate((element) => getComputedStyle(element).color),
  ).toBe('rgb(95, 99, 104)');
  expect(
    await resultsTable
      .locator('.new-value')
      .first()
      .evaluate((element) => getComputedStyle(element).color),
  ).toBe('rgb(32, 33, 36)');
  expect(
    await resultsTable
      .locator('.new-value')
      .first()
      .evaluate((element) => getComputedStyle(element).fontWeight),
  ).toBe('500');
  await page.screenshot({
    path: `${scratch}/um-10-set-attributes-results.png`,
    fullPage: false,
  });

  await dialog.getByRole('tab', { name: /Failed/ }).click();
  await expect(dialog.locator('tbody tr')).toHaveCount(1);
  await expect(dialog.getByText('1–1 of 1 changes')).toBeVisible();
});

test('reproduces UM state 11: a single-value attribute offers Set value and Clear value', async ({
  page,
}) => {
  await openUsers(page);
  const dialog = await openSetAttributes(page);
  await pickAttribute(page, dialog, 'Homeroom');
  await expect(dialog.getByText('Text · Single value')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Set value' })).toBeChecked();
  await expect(
    dialog.getByRole('radio', { name: 'Clear value' }),
  ).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Value' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Add values' })).toHaveCount(
    0,
  );
  // The approved state 11 shows the entered value.
  await dialog.getByRole('textbox', { name: 'Value' }).fill('216');
  // The floating label transition settles before the capture.
  await page.waitForTimeout(300);
  await page.evaluate(() => document.fonts.ready);
  const valueField = measured(
    await dialog.locator('mat-form-field').nth(2).boundingBox(),
  );
  // The approved state 11 geometry (R1-E).
  expect(measured(await dialog.boundingBox()).width).toBe(480);
  expect(measured(await dialog.boundingBox()).height).toBeGreaterThanOrEqual(
    500,
  );
  expect(measured(await dialog.boundingBox()).height).toBeLessThanOrEqual(502);
  expect(valueField.height).toBe(56);
  await page.screenshot({
    path: `${scratch}/um-11-set-attributes-single-value.png`,
    fullPage: false,
  });
});

test('keeps focus on the preparing status while the preview is held (R1-G)', async ({
  page,
}) => {
  const hold = heldAnswer();
  await openUsers(page, { holdPreview: hold });
  const dialog = await openSetAttributes(page);
  await choosePrograms(page, dialog);

  const review = dialog.getByRole('button', { name: 'Review', exact: true });
  await review.focus();
  await page.keyboard.press('Enter');
  await hold.started;

  const status = dialog
    .getByRole('status')
    .filter({ hasText: 'Preparing the preview…' });
  await expect(status).toBeFocused();
  await expect(page.locator('body')).not.toBeFocused();

  hold.release();
  await expect(dialog.locator('tbody tr')).toHaveCount(4);
});

test('keeps the receipt when Escape dismisses a held confirmation (R1-B)', async ({
  page,
}) => {
  const hold = heldAnswer();
  await openUsers(page, { holdConfirm: hold });
  const dialog = await openSetAttributes(page);
  await choosePrograms(page, dialog);
  await dialog.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(dialog.locator('tbody tr')).toHaveCount(4);
  await dialog
    .getByRole('button', { name: 'Set attributes on 4 users' })
    .click();
  await hold.started;

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  hold.release();

  // Reopening resumes the accepted receipt instead of a blank setup.
  await page.getByRole('button', { name: 'Bulk Actions' }).click();
  await page.getByRole('menuitem', { name: 'Set attributes' }).click();
  const reopened = page.getByRole('dialog');
  await expect(
    reopened.getByText('Job UAT-014 · Completed with errors'),
  ).toBeVisible();
  await expect(reopened.locator('tbody tr')).toHaveCount(10);
});

test('keeps focus in the dialog while the confirmation is held (R1-G)', async ({
  page,
}) => {
  const hold = heldAnswer();
  await openUsers(page, { holdConfirm: hold });
  const dialog = await openSetAttributes(page);
  await choosePrograms(page, dialog);
  await dialog.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(dialog.locator('tbody tr')).toHaveCount(4);

  const confirm = dialog.getByRole('button', {
    name: 'Set attributes on 4 users',
  });
  await confirm.focus();
  await page.keyboard.press('Enter');
  await hold.started;

  const status = dialog
    .getByRole('status')
    .filter({ hasText: 'Creating the job…' });
  await expect(status).toBeFocused();

  hold.release();
  await expect(
    dialog.getByText('Job UAT-014 · Completed with errors'),
  ).toBeVisible();
});

test('keeps the setup and names a 413 answer (K27 acceptance 6)', async ({
  page,
}) => {
  await openUsers(page, { previewFails: true });
  const dialog = await openSetAttributes(page);
  await choosePrograms(page, dialog);
  await dialog.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(
    dialog.getByText('The request exceeds the size limit.'),
  ).toBeVisible();
  // The setup and the entered value stay.
  await expect(dialog.getByText('ESL', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Add values' })).toBeVisible();
  await expect(bulkPreviewRequest.body).not.toBeNull();
});

test('shows no Set attributes action without users:bulk-actions (K27 acceptance 3)', async ({
  page,
}) => {
  await openUsers(page, { omitBulk: true });
  await expect(page.getByRole('button', { name: 'Bulk Actions' })).toHaveCount(
    0,
  );
  await page
    .getByRole('row', { name: /Aaliyah Brooks/ })
    .getByRole('checkbox')
    .first()
    .click();
  await expect(
    page.getByRole('button', { name: 'Show All Selected (1)' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bulk Actions' })).toHaveCount(
    0,
  );
  await expect(page.getByText('Set attributes')).toHaveCount(0);
});

test('asks the second review page at the server cursor (K27 acceptance 4)', async ({
  page,
}) => {
  await openUsers(page, { manyTargets: true });
  const dialog = await openSetAttributes(page);
  await choosePrograms(page, dialog);
  await dialog.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(dialog.getByText('1–10 of 18 proposed changes')).toBeVisible();
  await dialog.getByRole('button', { name: 'Next review page' }).click();
  await expect(dialog.getByText('11–18 of 18 proposed changes')).toBeVisible();
  expect(bulkTargetRequests).toEqual([
    { disposition: 'eligible', cursor: null },
    { disposition: 'eligible', cursor: 'p2' },
  ]);
});
