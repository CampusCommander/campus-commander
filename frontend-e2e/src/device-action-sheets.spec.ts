import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const customerId = 'C0123456';
const observedAt = '2026-10-21T12:00:00.000Z';
const commandPreviewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const disablePreviewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const reenablePreviewId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const wipePreviewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac';
const powerwashPreviewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad';
const deprovisionPreviewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae';
const commandJobId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const statusJobId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const wipeJobId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const powerwashJobId = '22222222-2222-4222-8222-222222222222';
const deprovisionJobId = '11111111-1111-4111-8111-111111111111';
const evidenceDir = path.join(process.cwd(), 'dist/e2e-evidence');
/** The screenshot folder of the F1 walk. The hand-off names it. */
const walkEvidenceDir =
  process.env['WPD_EVIDENCE_DIR'] ?? path.join(evidenceDir, 'wipe-powerwash');
const selected = 8;

const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:commands', scope: { kind: 'district', customerId } },
  { action: 'devices:status', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
];

/** Every grant that the mock session can carry. The default set omits wipe. */
const allGrants = [
  ...grants,
  { action: 'devices:wipe', scope: { kind: 'district', customerId } },
  { action: 'devices:deprovision', scope: { kind: 'district', customerId } },
];

const rows = Array.from({ length: 6 }, (_, index) => ({
  deviceId: `synthetic-device-${index + 1}`,
  serialNumber: `C0A1-000${index + 1}`,
  model: 'Lenovo 100e Gen 4',
  assetTag: `HS-040${index + 1}`,
  orgUnitPath: '/School A',
  lastContact: '2026-10-21T11:58:00Z',
  annotatedLocation: 'Science wing',
  annotatedUser: null,
  notes: null,
  status: 'ACTIVE',
  battery: {
    status: 'reported',
    health: 'normal',
    capacityPercent: 91,
    reportedAt: '2026-10-21T11:00:00Z',
  },
  lastEntitySync: observedAt,
  stale: false,
}));

const preview = (options: {
  previewId: string;
  displayId: string;
  action:
    | 'reboot'
    | 'wipe-users'
    | 'powerwash'
    | 'disable'
    | 'reenable'
    | 'deprovision';
  eligible: number;
  selected?: number;
  deprovisionReason?: string | null;
}) => ({
  previewId: options.previewId,
  displayId: options.displayId,
  action: options.action,
  commandType:
    options.action === 'reboot'
      ? 'REBOOT'
      : options.action === 'wipe-users'
        ? 'WIPE_USERS'
        : options.action === 'powerwash'
          ? 'REMOTE_POWERWASH'
          : null,
  statusAction:
    options.action === 'reboot' ||
    options.action === 'wipe-users' ||
    options.action === 'powerwash'
      ? null
      : options.action,
  deprovisionReason: options.deprovisionReason ?? null,
  selected: options.selected ?? selected,
  eligible: options.eligible,
  excluded: (options.selected ?? selected) - options.eligible,
  oldestObservedAt: '2026-10-21T10:00:00.000Z',
  stale: false,
  preparedAt: '2026-10-21T12:00:00.000Z',
  expiresAt: '2026-10-21T12:15:00.000Z',
  manifestDigest: 'a'.repeat(64),
});

const target = (
  index: number,
  observedStatus: string,
  disposition: 'eligible' | 'excluded',
  exclusionReason: string | null,
) => ({
  deviceId: `synthetic-device-${index}`,
  serialNumber: `C0A1-000${index}`,
  orgUnitPath: '/School A',
  observedStatus,
  observedAt: '2026-10-21T11:50:00.000Z',
  disposition,
  exclusionReason,
});

const mixedTargets = [
  target(1, 'ACTIVE', 'eligible', null),
  target(2, 'ACTIVE', 'eligible', null),
  target(3, 'ACTIVE', 'eligible', null),
  target(4, 'ACTIVE', 'eligible', null),
  target(5, 'ACTIVE', 'eligible', null),
  target(6, 'ACTIVE', 'eligible', null),
  target(7, 'DISABLED', 'excluded', 'device-disabled'),
  target(8, 'DEPROVISIONED', 'excluded', 'device-deprovisioned'),
];

const activeOnlyTargets = Array.from({ length: selected }, (_, index) =>
  target(index + 1, 'ACTIVE', 'excluded', 'device-active'),
);

interface Scenario {
  /** The selected device count of the stored selection. */
  readonly selected: number;
  /** The eligible count of Reboot, Wipe user data, and Powerwash. */
  readonly commandEligible: number;
  /** The eligible count of Re-enable. */
  readonly reenableEligible: number;
  /** The eligible count of Deprovision. */
  readonly deprovisionEligible: number;
  readonly rows: ReadonlyArray<(typeof rows)[number]>;
  readonly commandTargets: ReadonlyArray<ReturnType<typeof target>>;
  readonly deprovisionTargets: ReadonlyArray<ReturnType<typeof target>>;
}

/** The regression scenario: 8 selected devices over the 6 listed rows. */
const regressionScenario: Scenario = {
  selected,
  commandEligible: 6,
  reenableEligible: 0,
  deprovisionEligible: 7,
  rows,
  commandTargets: mixedTargets,
  deprovisionTargets: mixedTargets,
};

/** The approved mockup: 6 selected devices, 4 active, 1 disabled, 1 deprovisioned. */
const mockupScenario: Scenario = {
  selected: 6,
  commandEligible: 4,
  reenableEligible: 1,
  deprovisionEligible: 5,
  rows: rows.map((row, index) => ({
    ...row,
    status: index === 4 ? 'DISABLED' : index === 5 ? 'DEPROVISIONED' : 'ACTIVE',
  })),
  commandTargets: [
    target(1, 'ACTIVE', 'eligible', null),
    target(2, 'ACTIVE', 'eligible', null),
    target(3, 'ACTIVE', 'eligible', null),
    target(4, 'ACTIVE', 'eligible', null),
    target(5, 'DISABLED', 'excluded', 'device-disabled'),
    target(6, 'DEPROVISIONED', 'excluded', 'device-deprovisioned'),
  ],
  deprovisionTargets: [
    target(1, 'ACTIVE', 'eligible', null),
    target(2, 'ACTIVE', 'eligible', null),
    target(3, 'ACTIVE', 'eligible', null),
    target(4, 'ACTIVE', 'eligible', null),
    target(5, 'DISABLED', 'eligible', null),
    target(6, 'DEPROVISIONED', 'excluded', 'device-deprovisioned'),
  ],
};

const receipt = (jobId: string, displayId: string, deviceCount: number) => ({
  jobId,
  displayId,
  status: 'accepted',
  deviceCount,
  updateCount: deviceCount,
});

const job = (options: {
  jobId: string;
  displayId: string;
  action:
    | 'reboot-devices'
    | 'wipe-user-data'
    | 'powerwash-devices'
    | 'disable-devices'
    | 'deprovision-devices';
  commandType: 'REBOOT' | 'WIPE_USERS' | 'REMOTE_POWERWASH' | null;
  statusAction: 'disable' | 'deprovision' | null;
  deviceCount: number;
  deprovisionReason?: string | null;
}) => ({
  jobId: options.jobId,
  displayId: options.displayId,
  revision: 1,
  action: options.action,
  status: 'running',
  scope: { kind: 'devices', deviceCount: options.deviceCount },
  requestedBy: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: 'District operator',
  },
  createdAt: '2026-10-21T12:00:00.000Z',
  startedAt: '2026-10-21T12:01:00.000Z',
  finishedAt: null,
  progress: {
    total: options.deviceCount,
    succeeded: 1,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    pending: options.deviceCount - 1,
  },
  failure: null,
  confirmedBy: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: 'District operator',
  },
  previewDisplayId: options.displayId.replace('CMD', 'PV').replace('STS', 'PV'),
  changes: null,
  commandType: options.commandType,
  statusAction: options.statusAction,
  deprovisionReason: options.deprovisionReason ?? null,
  targetOrgUnitPaths: ['/School A'],
  correlationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  latestActivity: {
    at: '2026-10-21T12:01:00.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
});

interface ApiOptions {
  /** The grants of the signed-in person. */
  actions?: readonly string[];
  /** Drop the answer to the first confirmation, as a lost connection does. */
  loseFirstConfirmation?: boolean;
  /** The answer to the first replay after a lost confirmation. */
  replayFailure?: { status: number; reason?: string };
  /** The data scenario. Defaults to the regression scenario. */
  scenario?: Scenario;
}

/** The Devices page and the command and status routes the sheets read. */
async function mockApi(page: Page, options: ApiOptions = {}) {
  const actions = options.actions ?? grants.map((grant) => grant.action);
  const scenario = options.scenario ?? regressionScenario;
  const previewFor = (requested: {
    previewId: string;
    displayId: string;
    action:
      | 'reboot'
      | 'wipe-users'
      | 'powerwash'
      | 'disable'
      | 'reenable'
      | 'deprovision';
    eligible: number;
    deprovisionReason?: string | null;
  }) =>
    preview({
      ...requested,
      selected: scenario.selected,
      deprovisionReason: requested.deprovisionReason ?? null,
    });
  const rebootPreview = previewFor({
    previewId: commandPreviewId,
    displayId: 'PV-002',
    action: 'reboot',
    eligible: scenario.commandEligible,
  });
  const wipePreview = previewFor({
    previewId: wipePreviewId,
    displayId: 'PV-010',
    action: 'wipe-users',
    eligible: scenario.commandEligible,
  });
  const powerwashPreview = previewFor({
    previewId: powerwashPreviewId,
    displayId: 'PV-011',
    action: 'powerwash',
    eligible: scenario.commandEligible,
  });
  const disablePreview = previewFor({
    previewId: disablePreviewId,
    displayId: 'PV-003',
    action: 'disable',
    eligible: scenario.commandEligible,
  });
  const reenablePreview = previewFor({
    previewId: reenablePreviewId,
    displayId: 'PV-004',
    action: 'reenable',
    eligible: scenario.reenableEligible,
  });
  const deprovisionPreview = (reason: string | null) =>
    previewFor({
      previewId: deprovisionPreviewId,
      displayId: 'PV-012',
      action: 'deprovision',
      eligible: scenario.deprovisionEligible,
      deprovisionReason: reason,
    });
  let deprovisionReason: string | null = null;

  const commandReceipt = receipt(
    commandJobId,
    'CMD-001',
    scenario.commandEligible,
  );
  const wipeReceipt = receipt(wipeJobId, 'CMD-002', scenario.commandEligible);
  const powerwashReceipt = receipt(
    powerwashJobId,
    'CMD-003',
    scenario.commandEligible,
  );
  const statusReceipt = receipt(
    statusJobId,
    'STS-001',
    scenario.commandEligible,
  );
  const deprovisionReceipt = receipt(
    deprovisionJobId,
    'STS-002',
    scenario.deprovisionEligible,
  );
  const commandJob = job({
    jobId: commandJobId,
    displayId: 'CMD-001',
    action: 'reboot-devices',
    commandType: 'REBOOT',
    statusAction: null,
    deviceCount: scenario.commandEligible,
  });
  const wipeJob = job({
    jobId: wipeJobId,
    displayId: 'CMD-002',
    action: 'wipe-user-data',
    commandType: 'WIPE_USERS',
    statusAction: null,
    deviceCount: scenario.commandEligible,
  });
  const powerwashJob = job({
    jobId: powerwashJobId,
    displayId: 'CMD-003',
    action: 'powerwash-devices',
    commandType: 'REMOTE_POWERWASH',
    statusAction: null,
    deviceCount: scenario.commandEligible,
  });
  const statusJob = job({
    jobId: statusJobId,
    displayId: 'STS-001',
    action: 'disable-devices',
    commandType: null,
    statusAction: 'disable',
    deviceCount: scenario.commandEligible,
  });
  const deprovisionJob = job({
    jobId: deprovisionJobId,
    displayId: 'STS-002',
    action: 'deprovision-devices',
    commandType: null,
    statusAction: 'deprovision',
    deviceCount: scenario.deprovisionEligible,
    deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
  });
  const jobs: Record<string, unknown> = {
    'CMD-001': commandJob,
    'CMD-002': wipeJob,
    'CMD-003': powerwashJob,
    'STS-001': statusJob,
    'STS-002': deprovisionJob,
  };
  const commandPreviews: Record<string, unknown> = {
    REBOOT: rebootPreview,
    WIPE_USERS: wipePreview,
    REMOTE_POWERWASH: powerwashPreview,
  };
  const confirmAnswer = (routePath: string) => {
    if (routePath.includes(wipePreviewId)) return wipeReceipt;
    if (routePath.includes(powerwashPreviewId)) return powerwashReceipt;
    if (routePath.includes(deprovisionPreviewId)) return deprovisionReceipt;
    if (routePath.includes('/status-changes/')) return statusReceipt;
    return commandReceipt;
  };
  let confirmations = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const routePath = new URL(request.url()).pathname;
    const method = request.method();

    if (method === 'POST' && routePath === '/api/devices/commands/previews') {
      const body = request.postDataJSON() as { commandType?: string };
      return route.fulfill({
        status: 201,
        json: commandPreviews[body.commandType ?? 'REBOOT'] ?? rebootPreview,
      });
    }
    if (
      method === 'POST' &&
      routePath === '/api/devices/status-changes/previews'
    ) {
      const body = request.postDataJSON() as {
        statusAction?: string;
        deprovisionReason?: string;
      };
      if (body.statusAction === 'reenable')
        return route.fulfill({ status: 201, json: reenablePreview });
      if (body.statusAction === 'deprovision') {
        deprovisionReason = body.deprovisionReason ?? null;
        return route.fulfill({
          status: 201,
          json: deprovisionPreview(deprovisionReason),
        });
      }
      return route.fulfill({ status: 201, json: disablePreview });
    }
    if (method === 'GET' && routePath.endsWith('/targets')) {
      if (routePath.includes(reenablePreviewId))
        return route.fulfill({
          json: { targets: activeOnlyTargets, nextCursor: null },
        });
      if (routePath.includes(deprovisionPreviewId))
        return route.fulfill({
          json: { targets: scenario.deprovisionTargets, nextCursor: null },
        });
      return route.fulfill({
        json: { targets: scenario.commandTargets, nextCursor: null },
      });
    }
    const previewRoutes: Record<string, unknown> = {
      [`/api/devices/commands/previews/${commandPreviewId}`]: rebootPreview,
      [`/api/devices/commands/previews/${wipePreviewId}`]: wipePreview,
      [`/api/devices/commands/previews/${powerwashPreviewId}`]:
        powerwashPreview,
      [`/api/devices/status-changes/previews/${disablePreviewId}`]:
        disablePreview,
      [`/api/devices/status-changes/previews/${reenablePreviewId}`]:
        reenablePreview,
    };
    if (
      method === 'GET' &&
      routePath ===
        `/api/devices/status-changes/previews/${deprovisionPreviewId}`
    )
      return route.fulfill({ json: deprovisionPreview(deprovisionReason) });
    if (method === 'GET' && previewRoutes[routePath])
      return route.fulfill({ json: previewRoutes[routePath] });
    if (method === 'POST' && routePath.endsWith('/confirm')) {
      const answer = confirmations++;
      if (options.loseFirstConfirmation && answer === 0)
        return route.abort('failed');
      if (options.replayFailure && answer === 1)
        return route.fulfill({
          status: options.replayFailure.status,
          json: options.replayFailure.reason
            ? { reason: options.replayFailure.reason }
            : {},
        });
      return route.fulfill({
        status: 201,
        json: confirmAnswer(routePath),
      });
    }
    if (routePath.startsWith('/api/jobs/')) {
      const displayId = routePath.slice('/api/jobs/'.length);
      if (jobs[displayId]) return route.fulfill({ json: jobs[displayId] });
    }
    if (routePath === '/api/application')
      return route.fulfill({
        json: {
          phase: 3,
          authenticationConfigured: true,
          version: 'development',
          build: 'client-review',
        },
      });
    if (routePath === '/api/auth/session')
      return route.fulfill({
        json: {
          identity: {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            displayName: 'District operator',
            permissionVersion: 1,
            permissions: [],
            grants: allGrants.filter((grant) => actions.includes(grant.action)),
            preferences: { theme: 'light', navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (routePath === '/api/devices/selection')
      return route.fulfill({
        json: {
          selection: {
            terms: [],
            groups: [],
            added: scenario.selected,
            excluded: 0,
            selectedCount: scenario.selected,
            expiredAt: null,
          },
        },
      });
    if (routePath === '/api/devices/selection/resolve')
      return route.fulfill({ json: { selected: {} } });
    if (routePath === '/api/devices/sync')
      return route.fulfill({
        json: {
          sync: {
            customerId,
            generation: 1,
            status: 'ready',
            observedAt,
            deviceCount: scenario.rows.length,
            failure: null,
            telemetryFailure: null,
            startedAt: null,
            checkedAt: null,
            stale: false,
          },
        },
      });
    if (routePath === '/api/devices/query')
      return route.fulfill({
        json: {
          page: {
            rows: scenario.rows,
            matching: scenario.rows.length,
            total: scenario.rows.length,
            observedAt,
            refreshJobId: null,
          },
        },
      });
    if (routePath === '/api/devices/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (routePath === '/api/devices/org-units')
      return route.fulfill({ json: { orgUnits: [] } });
    if (routePath === '/api/devices/events')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      });
    if (routePath === '/api/devices/updates/access')
      return route.fulfill({
        json: {
          state: 'granted',
          scope:
            'https://www.googleapis.com/auth/admin.directory.device.chromeos',
          failure: null,
          checkedAt: '2026-10-21T12:00:00.000Z',
        },
      });
    if (routePath === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (routePath === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (routePath === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    if (routePath === '/api/auth/preferences')
      return route.fulfill({ json: request.postDataJSON() });
    return route.fulfill({ status: 404, json: {} });
  });
}

async function openDevices(page: Page) {
  await page.goto('/devices');
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Bulk Actions', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const sheetFor = (page: Page, family: 'command' | 'status') =>
  page.locator(`app-device-action-sheet[family="${family}"] .bulk-sheet`);

async function openAction(
  page: Page,
  family: 'command' | 'status',
  label: 'Send command' | 'Change status',
) {
  await page.getByRole('button', { name: 'Bulk Actions', exact: true }).click();
  await page.getByRole('menuitem', { name: label }).click();
  const sheet = sheetFor(page, family);
  await expect(sheet).toHaveClass(/is-open/);
  await expect(sheet).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  return sheet;
}

async function screenshot(page: Page, name: string) {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, name) });
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .exclude('.cdk-overlay-container')
    .analyze();
  expect(results.violations).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test(`walks Reboot, Disable, and Re-enable in the ${theme} theme`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 990 });
    await mockApi(page);
    await openDevices(page);
    await page.evaluate((value) => {
      document.documentElement.dataset['theme'] = value;
    }, theme);

    await page
      .getByRole('button', { name: 'Bulk Actions', exact: true })
      .click();
    await expect(
      page.getByRole('menuitem', { name: 'Update device' }),
    ).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: 'Send command' }),
    ).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: 'Change status' }),
    ).toBeVisible();
    await page.waitForTimeout(300);
    await screenshot(page, `01-bulk-actions-menu-${theme}.png`);

    await page.getByRole('menuitem', { name: 'Send command' }).click();
    const command = sheetFor(page, 'command');
    await expect(
      command.getByRole('heading', {
        level: 1,
        name: 'Choose a device command',
      }),
    ).toBeVisible();
    await expect(command.locator('header .subtitle')).toHaveText(
      '8 selected devices · Not submitted',
    );
    await expect(command.getByRole('radio', { name: /Reboot/ })).toBeChecked();
    await expectNoAxeViolations(page);
    await page.waitForTimeout(300);
    await screenshot(page, `02-send-command-choose-${theme}.png`);

    await command.getByRole('button', { name: 'Review Reboot' }).click();
    await expect(
      command.getByRole('heading', {
        level: 1,
        name: 'Review 6 Reboot commands',
      }),
    ).toBeVisible();
    await expect(
      command.getByText('8 devices · 6 commands · 2 excluded'),
    ).toBeVisible();
    await expect(command.getByText('C0A1-0001')).toBeVisible();
    await expectNoAxeViolations(page);
    await page.waitForTimeout(300);
    await screenshot(page, `03-reboot-review-${theme}.png`);

    await command
      .getByRole('button', { name: 'Continue to confirmation' })
      .click();
    await expect(
      command.getByRole('heading', { level: 1, name: 'Reboot 6 devices' }),
    ).toBeVisible();
    const send = command.getByRole('button', {
      name: 'Send Reboot to 6 devices',
    });
    await expect(send).toBeDisabled();
    await expect(command.getByRole('checkbox')).not.toBeChecked();
    await expectNoAxeViolations(page);
    await page.waitForTimeout(300);
    await screenshot(page, `04-reboot-confirm-${theme}.png`);
    await command.getByRole('checkbox').check();
    await expect(send).toBeEnabled();
    await page.waitForTimeout(200);
    await screenshot(page, `04b-reboot-confirm-acknowledged-${theme}.png`);

    await send.click();
    await expect(
      command.getByRole('heading', { level: 1, name: 'Command job created' }),
    ).toBeVisible();
    await expect(command.getByText('Job CMD-001 · Running')).toBeVisible();
    await expect(
      command.getByText(
        '6 devices · 6 Reboot commands. Google changes have not completed.',
      ),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    await page.waitForTimeout(300);
    await screenshot(page, `08-command-receipt-${theme}.png`);
    await command.getByRole('button', { name: 'Done' }).click();
    await expect(command).not.toHaveClass(/is-open/);

    const status = await openAction(page, 'status', 'Change status');
    await expect(
      status.getByRole('heading', { level: 1, name: 'Change device status' }),
    ).toBeVisible();
    await expect(
      status.getByRole('button', { name: 'Review', exact: true }),
    ).toBeDisabled();
    await status.getByRole('radio', { name: /Disable/ }).check();
    await expectNoAxeViolations(page);
    await page.waitForTimeout(300);
    await screenshot(page, `05-change-status-choose-${theme}.png`);

    await status.getByRole('button', { name: 'Review Disable' }).click();
    await expect(
      status.getByRole('heading', {
        level: 1,
        name: 'Review 6 Disable status changes',
      }),
    ).toBeVisible();
    await status
      .getByRole('button', { name: 'Continue to confirmation' })
      .click();
    await expect(
      status.getByRole('heading', { level: 1, name: 'Disable 6 devices' }),
    ).toBeVisible();
    await expect(status.getByRole('checkbox')).toHaveCount(0);
    const disable = status.getByRole('button', { name: 'Disable 6 devices' });
    await expect(disable).toBeEnabled();
    await expect(disable).toHaveClass(/destructive/);
    await expectNoAxeViolations(page);
    await page.waitForTimeout(300);
    await screenshot(page, `06-disable-confirm-${theme}.png`);

    await disable.click();
    await expect(
      status.getByRole('heading', { level: 1, name: 'Status job created' }),
    ).toBeVisible();
    await expect(status.getByText('Job STS-001 · Running')).toBeVisible();
    await expectNoAxeViolations(page);
    await page.waitForTimeout(300);
    await screenshot(page, `09-status-receipt-${theme}.png`);
    await status.getByRole('button', { name: 'Done' }).click();
    await expect(status).not.toHaveClass(/is-open/);

    await openAction(page, 'status', 'Change status');
    await status.getByRole('radio', { name: /Re-enable/ }).check();
    await status.getByRole('button', { name: 'Review Re-enable' }).click();
    await expect(
      status.getByRole('heading', { level: 1, name: 'Nothing to re-enable' }),
    ).toBeVisible();
    await expect(status.locator('header .subtitle')).toHaveText(
      '8 selected devices · No job created',
    );
    await expect(
      status.getByText('No devices can be re-enabled'),
    ).toBeVisible();
    await expect(
      status.getByText('All 8 devices are already active.'),
    ).toBeVisible();
    await expect(status.locator('p.list-label')).toHaveText('Selected devices');
    await expect(
      status.getByRole('button', { name: 'Continue to confirmation' }),
    ).toHaveCount(0);
    await expectNoAxeViolations(page);
    await page.waitForTimeout(300);
    await screenshot(page, `07-reenable-no-eligible-${theme}.png`);

    await status.getByRole('button', { name: 'Change action' }).click();
    await expect(
      status.getByRole('heading', { level: 1, name: 'Change device status' }),
    ).toBeVisible();
    await status.getByRole('button', { name: 'Close' }).click();
    await expect(status).not.toHaveClass(/is-open/);
    await expect(
      page.getByRole('button', { name: 'Bulk Actions', exact: true }),
    ).toBeFocused();
  });
}

test('recovers a lost confirmation after a reload without another preview', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 990 });
  let previewPosts = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/devices/commands/previews'
    )
      previewPosts++;
  });
  await mockApi(page, { loseFirstConfirmation: true });
  await openDevices(page);

  const command = await openAction(page, 'command', 'Send command');
  await command.getByRole('button', { name: 'Review Reboot' }).click();
  await command
    .getByRole('button', { name: 'Continue to confirmation' })
    .click();
  await command.getByRole('checkbox').check();
  await command
    .getByRole('button', { name: 'Send Reboot to 6 devices' })
    .click();
  await expect(
    command.getByRole('heading', {
      level: 1,
      name: 'The confirmation did not finish',
    }),
  ).toBeVisible();
  expect(previewPosts).toBe(1);

  // The same tab reloads. The retained confirmation answers before any new preview.
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  const reopened = await openAction(page, 'command', 'Send command');
  await expect(
    reopened.getByRole('heading', { level: 1, name: 'Command job created' }),
  ).toBeVisible();
  await expect(reopened.getByText('Job CMD-001 · Running')).toBeVisible();
  expect(previewPosts).toBe(1);
});

for (const theme of ['light', 'dark'] as const) {
  test(`keeps a lost confirmation through a named replay answer in the ${theme} theme`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 990 });
    let previewPosts = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/devices/commands/previews'
      )
        previewPosts++;
    });
    await mockApi(page, {
      loseFirstConfirmation: true,
      replayFailure: { status: 409, reason: 'connection-required' },
    });
    await openDevices(page);
    await page.evaluate((value) => {
      document.documentElement.dataset['theme'] = value;
    }, theme);

    const command = await openAction(page, 'command', 'Send command');
    await command.getByRole('button', { name: 'Review Reboot' }).click();
    await command
      .getByRole('button', { name: 'Continue to confirmation' })
      .click();
    await command.getByRole('checkbox').check();
    await command
      .getByRole('button', { name: 'Send Reboot to 6 devices' })
      .click();
    await expect(
      command.getByRole('heading', {
        level: 1,
        name: 'The confirmation did not finish',
      }),
    ).toBeVisible();
    expect(previewPosts).toBe(1);

    // The same tab reloads and the replay answers before the receipt lookup.
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Devices', exact: true }),
    ).toBeVisible();
    await page.evaluate((value) => {
      document.documentElement.dataset['theme'] = value;
    }, theme);
    const reopened = await openAction(page, 'command', 'Send command');
    await expect(
      reopened.getByRole('heading', {
        level: 1,
        name: 'The command job may exist',
      }),
    ).toBeVisible();
    await expect(
      reopened.getByText('The receipt is unavailable'),
    ).toBeVisible();
    await expect(reopened.getByText('Check Jobs for this job')).toBeVisible();
    await expect(
      reopened.getByRole('button', { name: 'View jobs' }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    await page.waitForTimeout(300);
    await screenshot(page, `10-replay-receipt-unavailable-${theme}.png`);
    // The unresolved answer prepared no replacement preview.
    expect(previewPosts).toBe(1);

    await reopened.getByRole('button', { name: 'Close' }).click();
    await expect(reopened).not.toHaveClass(/is-open/);
    const recovered = await openAction(page, 'command', 'Send command');
    await expect(
      recovered.getByRole('heading', { level: 1, name: 'Command job created' }),
    ).toBeVisible();
    await expect(recovered.getByText('Job CMD-001 · Running')).toBeVisible();
    expect(previewPosts).toBe(1);
  });
}

test('disables each entry that the person cannot use and names the permission', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 990 });
  await mockApi(page, {
    actions: ['devices:read', 'devices:bulk-actions'],
  });
  await openDevices(page);
  await expect(
    page.getByText(
      'You need the devices:read, devices:commands, and devices:bulk-actions permissions to send device commands. Ask your administrator for access.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'You need the devices:read, devices:status, and devices:bulk-actions permissions to change device status. Ask your administrator for access.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Bulk Actions', exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Send command' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('menuitem', { name: 'Change status' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('menuitem', { name: 'Update device' }),
  ).toBeDisabled();
  await page.waitForTimeout(300);
  await screenshot(page, '01-bulk-actions-permission-notes.png');
  await expectNoAxeViolations(page);
});

/** The grants of a person who can send, wipe, change status, and deprovision. */
const fullGrants = [
  'devices:read',
  'devices:write',
  'devices:commands',
  'devices:wipe',
  'devices:status',
  'devices:deprovision',
  'devices:bulk-actions',
];

const REASON_LABELS = [
  'Retiring from fleet',
  'Different model replacement',
  'Same model replacement',
  'ChromeOS Flex upgrade transfer',
];

test('walks Wipe user data, Powerwash, and Deprovision at 1440 x 900', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const previewPosts: { path: string; body: Record<string, unknown> }[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (!path.endsWith('/previews')) return;
    previewPosts.push({
      path,
      body: (request.postDataJSON() ?? {}) as Record<string, unknown>,
    });
  });
  await mockApi(page, { scenario: mockupScenario, actions: fullGrants });
  await openDevices(page);
  mkdirSync(walkEvidenceDir, { recursive: true });
  const walkShot = async (name: string) => {
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(walkEvidenceDir, name) });
  };

  const command = await openAction(page, 'command', 'Send command');
  await expect(command.getByRole('radio')).toHaveCount(3);
  await expect(
    command.getByRole('radio', { name: /Wipe user data/ }),
  ).not.toBeChecked();
  await expect(command.getByRole('radio', { name: /Powerwash/ })).toBeEnabled();
  await command.getByRole('radio', { name: /Wipe user data/ }).check();
  await expect(command.locator('header .subtitle')).toHaveText(
    '6 selected devices · Not submitted',
  );
  await walkShot('01-send-command-choose.png');
  expect(previewPosts).toContainEqual(
    expect.objectContaining({
      path: '/api/devices/commands/previews',
      body: expect.objectContaining({ commandType: 'WIPE_USERS' }),
    }),
  );
  expect(previewPosts).toContainEqual(
    expect.objectContaining({
      path: '/api/devices/commands/previews',
      body: expect.objectContaining({ commandType: 'REMOTE_POWERWASH' }),
    }),
  );

  await command.getByRole('button', { name: 'Review Wipe user data' }).click();
  await expect(
    command.getByRole('heading', {
      level: 1,
      name: 'Review 4 Wipe user data commands',
    }),
  ).toBeVisible();
  await expect(
    command.getByText('6 devices · 4 commands · 2 excluded'),
  ).toBeVisible();
  await expect(
    command.getByText(
      'An offline device runs Wipe user data when it next connects, unless the command expires first. The job shows the expiry that Google returns.',
    ),
  ).toBeVisible();
  await walkShot('02-wipe-review.png');

  await command
    .getByRole('button', { name: 'Continue to confirmation' })
    .click();
  await expect(
    command.getByRole('heading', {
      level: 1,
      name: 'Wipe user data on 4 devices',
    }),
  ).toBeVisible();
  await expect(
    command.getByRole('button', { name: 'Send Wipe to 4 devices' }),
  ).toBeDisabled();
  await expect(command.locator('.field-block input')).toHaveValue('');
  await walkShot('03-wipe-confirm.png');

  // POWERWASH needs its own acknowledgment and phrase (completion step 3).
  await command.getByRole('button', { name: 'Back to preview' }).click();
  await command.getByRole('button', { name: 'Back to command' }).click();
  await command.getByRole('radio', { name: /Powerwash/ }).check();
  await command.getByRole('button', { name: 'Review Powerwash' }).click();
  await expect(
    command.getByRole('heading', {
      level: 1,
      name: 'Review 4 Powerwash commands',
    }),
  ).toBeVisible();
  await command
    .getByRole('button', { name: 'Continue to confirmation' })
    .click();
  await command.getByRole('checkbox').check();
  await command.locator('.field-block input').fill('WIPE');
  await expect(
    command.getByText('The phrase does not match. Type POWERWASH.'),
  ).toBeVisible();
  await expect(
    command.getByRole('button', { name: 'Send Powerwash to 4 devices' }),
  ).toBeDisabled();
  await walkShot('04-powerwash-confirm-wrong-phrase.png');
  await command.getByRole('button', { name: 'Close' }).click();
  await expect(command).not.toHaveClass(/is-open/);

  const status = await openAction(page, 'status', 'Change status');
  await expect(status.getByRole('radio')).toHaveCount(3);
  await status.getByRole('radio', { name: /Deprovision/ }).check();
  const reviewDeprovision = status.getByRole('button', {
    name: 'Review Deprovision',
  });
  await expect(reviewDeprovision).toBeDisabled();

  // The reason list shows the four Google labels, none selected (D11).
  await status.locator('mat-select').click();
  const reasonOptions = page.locator(
    '.mat-mdc-select-panel:visible mat-option',
  );
  await expect(reasonOptions).toHaveText(REASON_LABELS);
  await walkShot('05-change-status-reason.png');
  await reasonOptions.filter({ hasText: 'Retiring from fleet' }).click();
  await expect(reviewDeprovision).toBeEnabled();
  expect(previewPosts).toContainEqual(
    expect.objectContaining({
      path: '/api/devices/status-changes/previews',
      body: expect.objectContaining({
        statusAction: 'deprovision',
        deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
      }),
    }),
  );

  await reviewDeprovision.click();
  await expect(
    status.getByRole('heading', {
      level: 1,
      name: 'Review 5 Deprovision status changes',
    }),
  ).toBeVisible();
  await expect(
    status.getByText('Deprovision reason: Retiring from fleet'),
  ).toBeVisible();
  await expect(
    status.getByText(
      'Deprovision does not erase local data. Send Powerwash first to erase a device that leaves the district.',
    ),
  ).toBeVisible();
  await walkShot('06-deprovision-review.png');

  await status
    .getByRole('button', { name: 'Continue to confirmation' })
    .click();
  await expect(
    status.getByRole('heading', { level: 1, name: 'Deprovision 5 devices' }),
  ).toBeVisible();
  // Deprovision carries no acknowledgment box (D8).
  await expect(status.getByRole('checkbox')).toHaveCount(0);
  const deprovision = status.getByRole('button', {
    name: 'Deprovision 5 devices',
  });
  await expect(deprovision).toBeDisabled();
  await status.locator('.field-block input').fill('DEPROVISION');
  await expect(deprovision).toBeEnabled();
  await walkShot('07-deprovision-confirm.png');

  // A changed reason needs a new preview (D12).
  const before = previewPosts.filter(
    (post) => post.body['statusAction'] === 'deprovision',
  ).length;
  await status.getByRole('button', { name: 'Back to preview' }).click();
  await status.getByRole('button', { name: 'Back to status' }).click();
  await status.locator('mat-select').click();
  await reasonOptions.filter({ hasText: 'Same model replacement' }).click();
  await expect(
    status.getByRole('button', { name: 'Review Deprovision' }),
  ).toBeEnabled();
  const after = previewPosts.filter(
    (post) => post.body['statusAction'] === 'deprovision',
  ).length;
  expect(after).toBe(before + 1);
  expect(previewPosts.at(-1)?.body['deprovisionReason']).toBe(
    'DEPROVISION_REASON_SAME_MODEL_REPLACEMENT',
  );
  await status.getByRole('button', { name: 'Review Deprovision' }).click();
  await expect(
    status.getByText('Deprovision reason: Same model replacement'),
  ).toBeVisible();
  await expectNoAxeViolations(page);
});

test('keeps Wipe and Powerwash visible without the wipe permission (state 11)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, {
    scenario: mockupScenario,
    actions: [
      'devices:read',
      'devices:write',
      'devices:commands',
      'devices:status',
      'devices:bulk-actions',
    ],
  });
  await openDevices(page);
  const command = await openAction(page, 'command', 'Send command');
  await expect(
    command.getByRole('heading', {
      level: 1,
      name: 'Choose a device command',
    }),
  ).toBeVisible();
  await expect(command.getByRole('radio')).toHaveCount(3);
  await expect(command.getByRole('radio', { name: /Reboot/ })).toBeChecked();
  await expect(
    command.getByRole('radio', { name: /Wipe user data/ }),
  ).toBeDisabled();
  await expect(
    command.getByRole('radio', { name: /Powerwash/ }),
  ).toBeDisabled();
  await expect(
    command.getByText(
      'You need the devices:read, devices:wipe, and devices:bulk-actions permissions to wipe user data or powerwash devices. Ask your administrator for access.',
    ),
  ).toBeVisible();
  mkdirSync(walkEvidenceDir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(walkEvidenceDir, '11-choose-without-wipe-permission.png'),
  });
  await expectNoAxeViolations(page);

  // The status sheet keeps Deprovision visible and disabled too (state 11).
  await command.getByRole('button', { name: 'Close' }).click();
  const status = await openAction(page, 'status', 'Change status');
  await expect(status.getByRole('radio')).toHaveCount(3);
  await expect(
    status.getByRole('radio', { name: /Deprovision/ }),
  ).toBeDisabled();
  await expect(
    status.getByText(
      'You need the devices:read, devices:deprovision, and devices:bulk-actions permissions to deprovision devices. Ask your administrator for access.',
    ),
  ).toBeVisible();
});
