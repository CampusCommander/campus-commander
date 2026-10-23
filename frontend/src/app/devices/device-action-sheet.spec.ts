import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  DeviceActionPreview,
  DeviceActionTarget,
  DeviceSelectionSpec,
  JobDetail,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from '../google-connection/connection.store';
import { ACTION_CONFIRMATION_PREFIX } from './device-action-confirmation.store';
import { DeviceActionSheet } from './device-action-sheet';
import { DevicesStore } from './devices.store';

const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const commandPreviewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const disablePreviewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const reenablePreviewId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const selection = (
  selectedCount: number,
  expiredAt: string | null = null,
): DeviceSelectionSpec => ({
  terms: [],
  groups: [],
  added: selectedCount,
  excluded: 0,
  selectedCount,
  expiredAt,
});

function preview(
  previewId: string,
  action: DeviceActionPreview['action'],
  selected: number,
  eligible: number,
): DeviceActionPreview {
  return {
    previewId,
    displayId:
      action === 'reboot'
        ? 'PV-002'
        : action === 'disable'
          ? 'PV-003'
          : 'PV-004',
    action,
    commandType:
      action === 'reboot'
        ? 'REBOOT'
        : action === 'wipe-users'
          ? 'WIPE_USERS'
          : action === 'powerwash'
            ? 'REMOTE_POWERWASH'
            : null,
    statusAction:
      action === 'disable' || action === 'reenable' || action === 'deprovision'
        ? action
        : null,
    deprovisionReason: null,
    selected,
    eligible,
    excluded: selected - eligible,
    oldestObservedAt: '2026-10-20T10:00:00.000Z',
    stale: false,
    preparedAt: '2026-10-20T19:02:00.000Z',
    expiresAt: '2026-10-20T19:17:00.000Z',
    manifestDigest: 'a'.repeat(64),
  };
}

const commandPreview = preview(commandPreviewId, 'reboot', 8, 6);
const disablePreview = preview(disablePreviewId, 'disable', 8, 6);
/** The mockup scenario of state 05: 1 of 8 devices is disabled. */
const reenablePreview = preview(reenablePreviewId, 'reenable', 8, 1);
/** The mockup scenario of state 07: 3 active devices, no target. */
const reenableNone = preview(reenablePreviewId, 'reenable', 3, 0);
const wipePreviewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac';
const powerwashPreviewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad';
const deprovisionPreviewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae';
const wipePreview: DeviceActionPreview = {
  ...preview(wipePreviewId, 'wipe-users', 8, 6),
  displayId: 'PV-010',
};
const powerwashPreview: DeviceActionPreview = {
  ...preview(powerwashPreviewId, 'powerwash', 8, 6),
  displayId: 'PV-011',
};
const deprovisionPreview: DeviceActionPreview = {
  ...preview(deprovisionPreviewId, 'deprovision', 8, 5),
  displayId: 'PV-012',
  deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
};

const target = (
  index: number,
  observedStatus: string,
  disposition: 'eligible' | 'excluded',
  exclusionReason: string | null,
): DeviceActionTarget => ({
  deviceId: `synthetic-device-${index}`,
  serialNumber: `C0A1-000${index}`,
  orgUnitPath: '/School A',
  observedStatus,
  observedAt: '2026-10-20T18:50:00.000Z',
  disposition,
  exclusionReason,
});

const commandTargets: DeviceActionTarget[] = [
  target(1, 'ACTIVE', 'eligible', null),
  target(2, 'ACTIVE', 'eligible', null),
  target(3, 'ACTIVE', 'eligible', null),
  target(4, 'ACTIVE', 'eligible', null),
  target(5, 'ACTIVE', 'eligible', null),
  target(6, 'ACTIVE', 'eligible', null),
  target(7, 'DISABLED', 'excluded', 'device-disabled'),
  target(8, 'DEPROVISIONED', 'excluded', 'device-deprovisioned'),
];

const reenableTargets: DeviceActionTarget[] = [
  target(1, 'ACTIVE', 'excluded', 'device-active'),
  target(2, 'ACTIVE', 'excluded', 'device-active'),
  target(3, 'ACTIVE', 'excluded', 'device-active'),
];

const receipt = {
  jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  displayId: 'CMD-001',
  status: 'accepted' as const,
  deviceCount: 6,
  updateCount: 6,
};

const statusReceipt = {
  jobId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  displayId: 'STS-001',
  status: 'accepted' as const,
  deviceCount: 6,
  updateCount: 6,
};

function jobOf(
  displayId: string,
  action: JobDetail['action'],
  statusAction: JobDetail['statusAction'],
): JobDetail {
  return {
    jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    displayId,
    revision: 1,
    action,
    status: 'running',
    scope: { kind: 'devices', deviceCount: 6 },
    requestedBy: { id: principal, displayName: 'District operator' },
    createdAt: '2026-10-20T19:03:00.000Z',
    startedAt: '2026-10-20T19:03:00.000Z',
    finishedAt: null,
    progress: {
      total: 6,
      succeeded: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 0,
      pending: 6,
    },
    failure: null,
    confirmedBy: { id: principal, displayName: 'District operator' },
    previewDisplayId: 'PV-002',
    changes: null,
    commandType: action === 'reboot-devices' ? 'REBOOT' : null,
    statusAction,
    deprovisionReason: null,
    targetOrgUnitPaths: ['/School A'],
    correlationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    latestActivity: {
      at: '2026-10-20T19:03:00.000Z',
      failed: { count: 0, operations: [] },
      unknown: { count: 0, operations: [] },
    },
  };
}

const commandJob = jobOf('CMD-001', 'reboot-devices', null);
const statusJob = jobOf('STS-001', 'disable-devices', 'disable');

/** A second command preview, prepared after a selection change or an expiry. */
const replacementPreviewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
const replacementPreview = {
  ...preview(replacementPreviewId, 'reboot', 8, 4),
  displayId: 'PV-007',
};
/** A second Disable preview, prepared after an expiry. */
const replacementDisableId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
const replacementDisable = {
  ...preview(replacementDisableId, 'disable', 8, 4),
  displayId: 'PV-008',
};

type RequestHandler = (
  path: string,
  body?: unknown,
) => Promise<Response> | Response;

/** The ordinary routes of both families. A test handler wraps this function. */
function standardRequest(
  reenablePreviewValue: DeviceActionPreview,
  reenableTargetValues: DeviceActionTarget[],
): RequestHandler {
  return (path, body) => {
    if (path === '/api/devices/commands/previews') {
      const commandType = (body as { commandType?: string } | undefined)
        ?.commandType;
      return Response.json(
        commandType === 'WIPE_USERS'
          ? wipePreview
          : commandType === 'REMOTE_POWERWASH'
            ? powerwashPreview
            : commandPreview,
        { status: 201 },
      );
    }
    if (path === '/api/devices/status-changes/previews') {
      const action = (body as { statusAction?: string } | undefined)
        ?.statusAction;
      return Response.json(
        action === 'reenable'
          ? reenablePreviewValue
          : action === 'deprovision'
            ? deprovisionPreview
            : disablePreview,
        { status: 201 },
      );
    }
    if (path === `/api/devices/commands/previews/${commandPreviewId}`)
      return Response.json(commandPreview);
    if (path === `/api/devices/commands/previews/${wipePreviewId}`)
      return Response.json(wipePreview);
    if (path === `/api/devices/commands/previews/${powerwashPreviewId}`)
      return Response.json(powerwashPreview);
    if (path === `/api/devices/status-changes/previews/${disablePreviewId}`)
      return Response.json(disablePreview);
    if (path === `/api/devices/status-changes/previews/${reenablePreviewId}`)
      return Response.json(reenablePreviewValue);
    if (path === `/api/devices/status-changes/previews/${deprovisionPreviewId}`)
      return Response.json(deprovisionPreview);
    if (path.includes(`${reenablePreviewId}/targets`))
      return Response.json({
        targets: reenableTargetValues,
        nextCursor: null,
      });
    if (path.includes('/targets'))
      return Response.json({ targets: commandTargets, nextCursor: null });
    if (path.endsWith('/confirm')) {
      return Response.json(
        path.includes('/api/devices/status-changes/') ? statusReceipt : receipt,
        { status: 201 },
      );
    }
    if (path === '/api/jobs/CMD-001') return Response.json(commandJob);
    if (path === '/api/jobs/STS-001') return Response.json(statusJob);
    return Response.json({}, { status: 404 });
  };
}

interface SetupOptions {
  family?: 'command' | 'status';
  count?: number;
  expired?: boolean;
  request?: RequestHandler;
  open?: boolean;
  /** The Re-enable preview that the Choose step reads. */
  reenable?: DeviceActionPreview;
  /** The Re-enable targets of that preview. */
  reenableTargets?: DeviceActionTarget[];
  /** The action permissions of the person. The default is the first build's set. */
  actions?: readonly string[];
}

const DISTRICT_CUSTOMER = 'C0123456';
const DEVICES_GRID = 'devices';
const DEFAULT_ACTIONS = [
  'devices:read',
  'devices:bulk-actions',
  'devices:commands',
  'devices:status',
];

async function setup(options: SetupOptions = {}) {
  sessionStorage.clear();
  const spec = signal<DeviceSelectionSpec | null>(
    selection(
      options.count ?? 8,
      options.expired ? '2026-10-20T19:20:00.000Z' : null,
    ),
  );
  const revision = signal(0);
  const getSpec = vi.fn(async () => {
    spec.set(
      selection(
        options.count ?? 8,
        options.expired ? '2026-10-20T19:20:00.000Z' : null,
      ),
    );
    return { terms: [], selectedCount: spec()?.selectedCount ?? 0 };
  });
  const devices = {
    selection: { getSpec, spec, revision },
    selectionTab: tabId,
    selectedView: signal(false),
    offline: signal(false),
    sync: signal({ customerId: DISTRICT_CUSTOMER }),
  };
  const reenablePreviewValue = options.reenable ?? reenablePreview;
  const reenableTargetValues = options.reenableTargets ?? reenableTargets;
  const ordinary = standardRequest(reenablePreviewValue, reenableTargetValues);
  const request = vi.fn(
    async (path: string, body?: unknown): Promise<Response> => {
      if (options.request) return options.request(path, body);
      return ordinary(path, body);
    },
  );
  TestBed.configureTestingModule({
    imports: [DeviceActionSheet],
    providers: [
      provideRouter([]),
      { provide: DevicesStore, useValue: devices },
      { provide: ConnectionStore, useValue: { readable: signal(false) } },
      {
        provide: AuthStore,
        useValue: {
          session: signal({
            identity: { id: principal, grants: [] },
            expiresAt: '2026-10-21T12:00:00.000Z',
            csrfToken: 'a'.repeat(64),
          }),
          metadata: signal({
            phase: 3,
            authenticationConfigured: true,
            version: 'test',
            build: 'client-review',
          }),
          // The district scope grants of this person, read by each Choose option.
          can: (action: string) =>
            (options.actions ?? DEFAULT_ACTIONS).includes(action),
          request,
        },
      },
    ],
  });
  const navigate = vi
    .spyOn(TestBed.inject(Router), 'navigate')
    .mockResolvedValue(true);
  const fixture = TestBed.createComponent(DeviceActionSheet);
  fixture.componentRef.setInput('family', options.family ?? 'command');
  fixture.componentRef.setInput('open', options.open ?? true);
  fixture.detectChanges();
  const closed = vi.fn();
  fixture.componentInstance.closed.subscribe(closed);
  const element: HTMLElement = fixture.nativeElement;
  const settle = async () => {
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await settle();
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent?.replace(/\s+/g, ' ').trim() === name,
    );
  const radios = () => [
    ...element.querySelectorAll<HTMLInputElement>('mat-radio-button input'),
  ];
  const choose = async (index: number) => {
    radios()[index]?.click();
    await settle();
  };
  const acknowledge = async () => {
    const box = element.querySelector<HTMLInputElement>(
      'mat-checkbox input[type="checkbox"]',
    );
    if (!box) throw new Error('The acknowledgment checkbox is missing.');
    box.click();
    await settle();
  };
  const rows = () => [...element.querySelectorAll('tbody tr')];
  return {
    fixture,
    element,
    spec,
    request,
    navigate,
    closed,
    button,
    radios,
    choose,
    acknowledge,
    rows,
    settle,
  };
}

it('opens at Choose with the command and its target summary', async () => {
  const { element, button, radios } = await setup();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Choose a device command',
  );
  expect(element.textContent).toContain('8 selected devices · Not submitted');
  expect(element.textContent).toContain('Command');
  expect(radios()).toHaveLength(3);
  expect(radios()[0].checked).toBe(true);
  expect(radios()[1].disabled).toBe(true);
  expect(radios()[2].disabled).toBe(true);
  expect(element.textContent).toContain(
    'Restarts the devices and interrupts active sessions.',
  );
  expect(element.textContent).toContain('6 of 8 selected devices are active.');
  expect(element.textContent).toContain(
    'Excluded devices stay out of the job. The review lists each excluded device with its reason.',
  );
  expect(button('Review Reboot')?.disabled).toBe(false);
});

it('starts Change status with no option and the target summaries', async () => {
  const { element, button, choose } = await setup({ family: 'status' });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Change device status',
  );
  expect(element.textContent).toContain('Status change');
  expect(element.textContent).toContain(
    'Blocks user access while keeping devices enrolled.',
  );
  expect(element.textContent).toContain('Restores access to disabled devices.');
  expect(element.textContent).toContain('6 of 8 selected devices are active.');
  expect(element.textContent).toContain('1 of 8 selected devices is disabled.');
  expect(button('Review')?.disabled).toBe(true);
  await choose(0);
  expect(button('Review Disable')?.disabled).toBe(false);
  await choose(1);
  expect(button('Review Re-enable')?.disabled).toBe(false);
});

it('lists every frozen target with its status and exclusion reason', async () => {
  const { element, button, rows, settle } = await setup();
  button('Review Reboot')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 6 Reboot commands',
  );
  expect(element.textContent).toContain('8 devices · 6 commands · 2 excluded');
  expect(element.textContent).toContain(
    'Targets are frozen. New matching devices will not join this job.',
  );
  expect(element.textContent).toContain('Reboot targets');
  expect(element.textContent).toContain('Frozen Reboot targets');
  expect(rows()).toHaveLength(8);
  expect(rows()[0].textContent).toContain('C0A1-0001');
  expect(rows()[0].textContent).toContain('Active');
  expect(rows()[0].textContent).toContain('Reboot');
  expect(rows()[6].textContent).toContain('Disabled');
  expect(rows()[6].textContent).toContain('Not sent');
  expect(rows()[6].textContent).toContain('Excluded · Device is disabled');
  expect(rows()[7].textContent).toContain('Deprovisioned');
  expect(rows()[7].textContent).toContain('Excluded · Device is deprovisioned');
  expect(button('Continue to confirmation')?.disabled).toBe(false);
  expect(button('Back to command')).toBeDefined();
});

it('keeps Send disabled until the acknowledgment is ticked', async () => {
  const { element, button, acknowledge, settle } = await setup();
  button('Review Reboot')?.click();
  await settle();
  button('Continue to confirmation')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Reboot 6 devices',
  );
  expect(element.textContent).toContain('Reboot interrupts active sessions');
  expect(element.textContent).toContain(
    'I understand that restarting these devices interrupts users.',
  );
  expect(button('Send Reboot to 6 devices')?.disabled).toBe(true);
  await acknowledge();
  expect(button('Send Reboot to 6 devices')?.disabled).toBe(false);
});

it('sends the confirmation and shows the command receipt', async () => {
  const { element, button, acknowledge, settle, request, navigate } =
    await setup();
  button('Review Reboot')?.click();
  await settle();
  button('Continue to confirmation')?.click();
  await settle();
  await acknowledge();
  button('Send Reboot to 6 devices')?.click();
  await settle();
  expect(
    request.mock.calls.some(
      ([path]) =>
        path === `/api/devices/commands/previews/${commandPreviewId}/confirm`,
    ),
  ).toBe(true);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Command job created',
  );
  expect(element.textContent).toContain('Job CMD-001 · Running');
  expect(element.textContent).toContain('Your job is saved');
  expect(element.textContent).toContain(
    '6 devices · 6 Reboot commands. Google changes have not completed.',
  );
  expect(element.textContent).toContain(
    'You can close this panel and follow progress in Jobs.',
  );
  button('View job')?.click();
  await settle();
  expect(navigate).toHaveBeenCalledWith(['/jobs', 'CMD-001']);
});

it('confirms Disable with the destructive button and no checkbox', async () => {
  const { element, button, choose, settle, request } = await setup({
    family: 'status',
  });
  await choose(0);
  button('Review Disable')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 6 Disable status changes',
  );
  expect(element.textContent).toContain(
    '8 devices · 6 status changes · 2 excluded',
  );
  expect(element.textContent).toContain('Status change');
  button('Continue to confirmation')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Disable 6 devices',
  );
  expect(element.textContent).toContain('Block user access on 6 devices');
  expect(element.textContent).toContain(
    'Disable blocks user access. These devices remain enrolled. Re-enable restores access.',
  );
  expect(element.textContent).toContain(
    '6 eligible · 2 excluded · Exact targets are recorded with the job.',
  );
  expect(element.querySelector('mat-checkbox')).toBeNull();
  const confirm = button('Disable 6 devices');
  expect(confirm?.classList.contains('destructive')).toBe(true);
  expect(confirm?.disabled).toBe(false);
  confirm?.click();
  await settle();
  expect(
    request.mock.calls.some(
      ([path]) =>
        path ===
        `/api/devices/status-changes/previews/${disablePreviewId}/confirm`,
    ),
  ).toBe(true);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Status job created',
  );
  expect(element.textContent).toContain('6 devices · 6 status changes.');
});

it('shows the no-eligible state for Re-enable and lists each device', async () => {
  const { element, button, choose, settle, rows } = await setup({
    family: 'status',
    count: 3,
    reenable: reenableNone,
  });
  await choose(1);
  button('Review Re-enable')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Nothing to re-enable',
  );
  expect(element.textContent).toContain('3 selected devices · No job created');
  expect(element.textContent).toContain('No devices can be re-enabled');
  expect(element.textContent).toContain('All 3 devices are already active.');
  expect(element.textContent).toContain(
    'Eligible: 0 · Already active: 3. No job will be created.',
  );
  expect(element.textContent).toContain(
    'Select disabled devices to re-enable access.',
  );
  expect(element.textContent).toContain('Selected devices');
  expect(element.textContent).not.toContain('Re-enable targets');
  expect(rows()).toHaveLength(3);
  expect(rows()[0].textContent).toContain('Not changed');
  expect(rows()[0].textContent).toContain('Excluded · Device is active');
  expect(button('Continue to confirmation')).toBeUndefined();
  button('Change action')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Change device status',
  );
});

it('shows the expired preview problem when Review answers 410', async () => {
  const { element, button, settle } = await setup({
    request: (path) =>
      path.endsWith('/previews')
        ? Response.json(commandPreview, { status: 201 })
        : Response.json(
            {
              reason: 'preview-expired',
              expiresAt: '2026-10-20T19:17:00.000Z',
            },
            { status: 410 },
          ),
  });
  button('Review Reboot')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Preview expired',
  );
  expect(element.textContent).toContain(
    'Prepare a new preview before confirming',
  );
});

it('shows the permission problem when Review answers 403', async () => {
  const { element, button, settle } = await setup({
    request: () => Response.json({}, { status: 403 }),
  });
  button('Review Reboot')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Send command is unavailable',
  );
  expect(element.textContent).toContain(
    'You need the devices:read, devices:commands, and devices:bulk-actions permissions to send device commands. Ask your administrator for access.',
  );
});

it('shows the selection-expired state instead of the options', async () => {
  const { element, radios } = await setup({ expired: true });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Selection expired',
  );
  expect(element.textContent).toContain(
    'The browsing selection expired. Return to Devices and select the devices again.',
  );
  expect(radios()).toHaveLength(0);
});

it('reports a changed selection only after the review freezes a preview', async () => {
  const note = 'The selection changed after this preview.';
  const { element, button, spec, settle } = await setup();
  expect(element.textContent).not.toContain(note);
  button('Review Reboot')?.click();
  await settle();
  expect(element.textContent).not.toContain(note);
  spec.set(selection(9));
  await settle();
  expect(element.textContent).toContain(note);
  expect(element.textContent).toContain(
    'Change action to preview the new selection.',
  );
});

it('shows the three step labels with the active step', async () => {
  const { element } = await setup();
  const steps = [...element.querySelectorAll('li.step')];
  expect(steps.map((step) => step.textContent?.trim())).toEqual([
    '1Choose',
    '2Review, not started',
    '3Confirm, not started',
  ]);
  expect(steps[0].getAttribute('aria-current')).toBe('step');
  expect(element.querySelector('ol.stepper')?.getAttribute('aria-label')).toBe(
    'Send command steps',
  );
});

it('replays a lost confirmation when the sheet reopens', async () => {
  const ordinary = standardRequest(reenablePreview, reenableTargets);
  let confirmations = 0;
  const { fixture, element, button, acknowledge, settle, request } =
    await setup({
      request: (path) => {
        if (path.endsWith('/confirm')) {
          confirmations++;
          return confirmations === 1
            ? Promise.reject(new TypeError('The connection closed.'))
            : Response.json(receipt, { status: 201 });
        }
        return ordinary(path);
      },
    });
  button('Review Reboot')?.click();
  await settle();
  button('Continue to confirmation')?.click();
  await settle();
  await acknowledge();
  button('Send Reboot to 6 devices')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'The confirmation did not finish',
  );
  const confirmed = () =>
    request.mock.calls.filter(([path]) => path.endsWith('/confirm'));
  expect(confirmed()).toHaveLength(1);
  const previewPosts = request.mock.calls.filter(
    ([path]) => path === '/api/devices/commands/previews',
  ).length;

  // Close the sheet and open it again in the same tab.
  fixture.componentRef.setInput('open', false);
  fixture.detectChanges();
  fixture.componentRef.setInput('open', true);
  await settle();

  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Command job created',
  );
  expect(element.textContent).toContain('Job CMD-001 · Running');
  expect(confirmed()).toHaveLength(2);
  const [first, second] = confirmed();
  expect(second?.[0]).toBe(first?.[0]);
  expect(second?.[1]).toEqual(first?.[1]);
  expect(first?.[1]).toEqual({
    manifestDigest: commandPreview.manifestDigest,
    acknowledged: true,
  });
  // The replay answered before the sheet prepared another preview.
  expect(
    request.mock.calls.filter(
      ([path]) => path === '/api/devices/commands/previews',
    ),
  ).toHaveLength(previewPosts);
});

it('recovers a status receipt without a chosen option', async () => {
  const ordinary = standardRequest(reenablePreview, reenableTargets);
  const { fixture, element, settle } = await setup({
    family: 'status',
    open: false,
    request: (path) => {
      if (path.endsWith('/confirm'))
        return Response.json(statusReceipt, { status: 201 });
      return ordinary(path);
    },
  });
  sessionStorage.setItem(
    `${ACTION_CONFIRMATION_PREFIX}${principal}.status.${disablePreviewId}`,
    JSON.stringify({
      family: 'status',
      previewId: disablePreviewId,
      manifestDigest: disablePreview.manifestDigest,
    }),
  );
  fixture.componentRef.setInput('open', true);
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Status job created',
  );
  expect(element.textContent).toContain('Job STS-001 · Running');
  expect(element.textContent).toContain(
    '6 devices · 6 status changes. Google changes have not completed.',
  );
});

it('prepares a new preview when the selection changes under Choose', async () => {
  const ordinary = standardRequest(reenablePreview, reenableTargets);
  let rebootPosts = 0;
  const { element, button, spec, settle } = await setup({
    request: (path, body) => {
      if (path === '/api/devices/commands/previews') {
        if ((body as { commandType?: string }).commandType !== 'REBOOT')
          return ordinary(path, body);
        rebootPosts++;
        return Response.json(
          rebootPosts === 1 ? commandPreview : replacementPreview,
          { status: 201 },
        );
      }
      if (path === `/api/devices/commands/previews/${replacementPreviewId}`)
        return Response.json(replacementPreview);
      if (path.includes(`${replacementPreviewId}/targets`))
        return Response.json({
          targets: commandTargets.slice(0, 4),
          nextCursor: null,
        });
      return ordinary(path, body);
    },
  });
  // The same device count with another scope is still another selection.
  spec.set({ ...selection(8), added: 7, excluded: 1 });
  await settle();
  button('Review Reboot')?.click();
  await settle();
  expect(rebootPosts).toBe(2);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 4 Reboot commands',
  );
  expect(element.textContent).not.toContain(
    'The selection changed after this preview.',
  );
});

it('keeps the frozen scope when Back to preview follows a selection change', async () => {
  const ordinary = standardRequest(reenablePreview, reenableTargets);
  let rebootPosts = 0;
  const { element, button, spec, settle } = await setup({
    request: (path, body) => {
      if (path === '/api/devices/commands/previews') {
        if ((body as { commandType?: string }).commandType !== 'REBOOT')
          return ordinary(path, body);
        rebootPosts++;
        return Response.json(
          rebootPosts === 1 ? commandPreview : replacementPreview,
          { status: 201 },
        );
      }
      if (path === `/api/devices/commands/previews/${replacementPreviewId}`)
        return Response.json(replacementPreview);
      if (path.includes(`${replacementPreviewId}/targets`))
        return Response.json({
          targets: commandTargets.slice(0, 4),
          nextCursor: null,
        });
      return ordinary(path, body);
    },
  });
  button('Review Reboot')?.click();
  await settle();
  button('Continue to confirmation')?.click();
  await settle();
  spec.set({ ...selection(8), added: 7, excluded: 1 });
  await settle();
  button('Back to preview')?.click();
  await settle();
  // The reviewed scope stays frozen; a new selection needs Change action.
  expect(rebootPosts).toBe(1);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 6 Reboot commands',
  );
  expect(element.textContent).toContain(
    'The selection changed after this preview.',
  );
});

it('prepares a fresh command preview after the cached one expires', async () => {
  const ordinary = standardRequest(reenablePreview, reenableTargets);
  let rebootPosts = 0;
  let expiredReads = 0;
  const { element, button, settle } = await setup({
    request: (path, body) => {
      if (path === '/api/devices/commands/previews') {
        if ((body as { commandType?: string }).commandType !== 'REBOOT')
          return ordinary(path, body);
        rebootPosts++;
        return Response.json(
          rebootPosts === 1 ? commandPreview : replacementPreview,
          { status: 201 },
        );
      }
      if (path === `/api/devices/commands/previews/${commandPreviewId}`) {
        expiredReads++;
        return Response.json(
          { reason: 'preview-expired', expiresAt: '2026-10-20T19:17:00.000Z' },
          { status: 410 },
        );
      }
      if (path === `/api/devices/commands/previews/${replacementPreviewId}`)
        return Response.json(replacementPreview);
      if (path.includes(`${replacementPreviewId}/targets`))
        return Response.json({
          targets: commandTargets.slice(0, 4),
          nextCursor: null,
        });
      return ordinary(path, body);
    },
  });
  button('Review Reboot')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Preview expired',
  );
  button('Change action')?.click();
  await settle();
  button('Review Reboot')?.click();
  await settle();
  expect(expiredReads).toBe(1);
  expect(rebootPosts).toBe(2);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 4 Reboot commands',
  );
});

it('prepares a fresh Disable preview after the cached one expires', async () => {
  const ordinary = standardRequest(reenablePreview, reenableTargets);
  let disablePosts = 0;
  let expiredReads = 0;
  const { element, button, choose, settle } = await setup({
    family: 'status',
    request: (path, body) => {
      if (path === '/api/devices/status-changes/previews') {
        const action = (body as { statusAction?: string } | undefined)
          ?.statusAction;
        if (action === 'disable') {
          disablePosts++;
          return Response.json(
            disablePosts === 1 ? disablePreview : replacementDisable,
            { status: 201 },
          );
        }
        return Response.json(reenablePreview, { status: 201 });
      }
      if (path === `/api/devices/status-changes/previews/${disablePreviewId}`) {
        expiredReads++;
        return Response.json({ reason: 'preview-expired' }, { status: 410 });
      }
      if (
        path === `/api/devices/status-changes/previews/${replacementDisableId}`
      )
        return Response.json(replacementDisable);
      if (path.includes(`${replacementDisableId}/targets`))
        return Response.json({
          targets: commandTargets.slice(0, 4),
          nextCursor: null,
        });
      return ordinary(path, body);
    },
  });
  await choose(0);
  button('Review Disable')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Preview expired',
  );
  button('Change action')?.click();
  await settle();
  button('Review Disable')?.click();
  await settle();
  expect(expiredReads).toBe(1);
  expect(disablePosts).toBe(2);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 4 Disable status changes',
  );
});

it('retries the preparation when Review has no preview', async () => {
  const ordinary = standardRequest(reenablePreview, reenableTargets);
  let commandPosts = 0;
  const { element, button, settle } = await setup({
    request: (path, body) => {
      if (path === '/api/devices/commands/previews') {
        commandPosts++;
        if (commandPosts < 3)
          return Response.json({ reason: 'unavailable' }, { status: 503 });
        const commandType = (body as { commandType?: string }).commandType;
        return Response.json(
          commandType === 'WIPE_USERS'
            ? wipePreview
            : commandType === 'REMOTE_POWERWASH'
              ? powerwashPreview
              : commandPreview,
          { status: 201 },
        );
      }
      return ordinary(path, body);
    },
  });
  button('Review Reboot')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'The preview is unavailable',
  );
  expect(commandPosts).toBe(2);
  button('Retry')?.click();
  await settle();
  expect(commandPosts).toBe(3);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 6 Reboot commands',
  );
});

it('keeps a lost command confirmation when a named replay answer may hide a job', async () => {
  const ordinary = standardRequest(reenablePreview, reenableTargets);
  let confirmations = 0;
  let replayForbidden = false;
  let commandPosts = 0;
  const { fixture, element, button, acknowledge, settle, request } =
    await setup({
      request: (path) => {
        if (path === '/api/devices/commands/previews') commandPosts++;
        if (path.endsWith('/confirm')) {
          confirmations++;
          if (confirmations === 1)
            return Promise.reject(new TypeError('The connection closed.'));
          if (confirmations === 2 && replayForbidden)
            return Response.json({}, { status: 403 });
          return Response.json(receipt, { status: 201 });
        }
        return ordinary(path);
      },
    });
  button('Review Reboot')?.click();
  await settle();
  button('Continue to confirmation')?.click();
  await settle();
  await acknowledge();
  button('Send Reboot to 6 devices')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'The confirmation did not finish',
  );
  const confirmed = () =>
    request.mock.calls.filter(([path]) => path.endsWith('/confirm'));
  expect(confirmed()).toHaveLength(1);
  const postsAfterSubmit = commandPosts;

  // The replay answers 403, which the API returns before the receipt lookup.
  fixture.componentRef.setInput('open', false);
  fixture.detectChanges();
  replayForbidden = true;
  fixture.componentRef.setInput('open', true);
  await settle();

  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'The command job may exist',
  );
  expect(element.textContent).toContain('The receipt is unavailable');
  expect(element.textContent).toContain('Check Jobs for this job');
  expect(button('View jobs')).toBeDefined();
  expect(button('Change action')).toBeUndefined();
  expect(confirmed()).toHaveLength(2);
  expect(confirmed()[1]?.[0]).toBe(confirmed()[0]?.[0]);
  expect(confirmed()[1]?.[1]).toEqual(confirmed()[0]?.[1]);
  expect(commandPosts).toBe(postsAfterSubmit);

  // The identity survives another closure and settles on the receipt.
  fixture.componentRef.setInput('open', false);
  fixture.detectChanges();
  replayForbidden = false;
  fixture.componentRef.setInput('open', true);
  await settle();

  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Command job created',
  );
  expect(element.textContent).toContain('Job CMD-001 · Running');
  expect(confirmed()).toHaveLength(3);
  expect(confirmed()[2]?.[0]).toBe(confirmed()[0]?.[0]);
  expect(confirmed()[2]?.[1]).toEqual(confirmed()[0]?.[1]);
  expect(commandPosts).toBe(postsAfterSubmit);
});

it('keeps a lost status confirmation when a named replay answer may hide a job', async () => {
  const ordinary = standardRequest(reenablePreview, reenableTargets);
  let confirmations = 0;
  let statusPosts = 0;
  const { fixture, element, settle, request } = await setup({
    family: 'status',
    open: false,
    request: (path, body) => {
      if (path === '/api/devices/status-changes/previews') statusPosts++;
      if (path.endsWith('/confirm')) {
        confirmations++;
        return confirmations === 1
          ? Response.json({ reason: 'preview-changed' }, { status: 409 })
          : Response.json(statusReceipt, { status: 201 });
      }
      return ordinary(path, body);
    },
  });
  sessionStorage.setItem(
    `${ACTION_CONFIRMATION_PREFIX}${principal}.status.${disablePreviewId}`,
    JSON.stringify({
      family: 'status',
      previewId: disablePreviewId,
      manifestDigest: disablePreview.manifestDigest,
    }),
  );
  fixture.componentRef.setInput('open', true);
  await settle();

  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'The status job may exist',
  );
  expect(element.textContent).toContain('The receipt is unavailable');
  expect(element.textContent).toContain('Check Jobs for this job');
  expect(confirmations).toBe(1);
  expect(statusPosts).toBe(0);

  fixture.componentRef.setInput('open', false);
  fixture.detectChanges();
  fixture.componentRef.setInput('open', true);
  await settle();

  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Status job created',
  );
  expect(element.textContent).toContain('Job STS-001 · Running');
  expect(confirmations).toBe(2);
  expect(statusPosts).toBe(0);
  const confirmed = request.mock.calls.filter(([path]) =>
    path.endsWith('/confirm'),
  );
  expect(confirmed[1]?.[0]).toBe(confirmed[0]?.[0]);
  expect(confirmed[1]?.[1]).toEqual(confirmed[0]?.[1]);
});

for (const answer of [
  'forbidden',
  'permission-changed',
  'preview-changed',
  'connection-required',
] as const) {
  it(`keeps a command confirmation when its opening replay answers ${answer}`, async () => {
    const ordinary = standardRequest(reenablePreview, reenableTargets);
    let confirmations = 0;
    let previewPosts = 0;
    const { fixture, element, settle, request } = await setup({
      open: false,
      request: (path) => {
        if (path === '/api/devices/commands/previews') previewPosts++;
        if (path.endsWith('/confirm')) {
          confirmations++;
          if (confirmations === 1)
            return Response.json(
              answer === 'forbidden' ? {} : { reason: answer },
              { status: answer === 'forbidden' ? 403 : 409 },
            );
          return Response.json(receipt, { status: 201 });
        }
        return ordinary(path);
      },
    });
    sessionStorage.setItem(
      `${ACTION_CONFIRMATION_PREFIX}${principal}.command.${commandPreviewId}`,
      JSON.stringify({
        family: 'command',
        previewId: commandPreviewId,
        manifestDigest: commandPreview.manifestDigest,
      }),
    );
    fixture.componentRef.setInput('open', true);
    await settle();
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'The command job may exist',
    );
    expect(element.textContent).toContain('Check Jobs for this job');
    expect(confirmations).toBe(1);
    expect(previewPosts).toBe(0);

    fixture.componentRef.setInput('open', false);
    fixture.detectChanges();
    fixture.componentRef.setInput('open', true);
    await settle();
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'Command job created',
    );
    expect(confirmations).toBe(2);
    expect(previewPosts).toBe(0);
    const confirmed = request.mock.calls.filter(([path]) =>
      path.endsWith('/confirm'),
    );
    expect(confirmed[1]?.[0]).toBe(confirmed[0]?.[0]);
    expect(confirmed[1]?.[1]).toEqual(confirmed[0]?.[1]);
  });
}

for (const family of ['command', 'status'] as const) {
  it(`initializes Choose after a ${family} replay problem offers Change action`, async () => {
    const ordinary = standardRequest(reenablePreview, reenableTargets);
    const retainedPreviewId =
      family === 'command' ? commandPreviewId : disablePreviewId;
    const retainedDigest =
      family === 'command'
        ? commandPreview.manifestDigest
        : disablePreview.manifestDigest;
    let previewPosts = 0;
    const { fixture, element, button, choose, settle } = await setup({
      family,
      open: false,
      request: (path, body) => {
        if (
          path ===
          (family === 'command'
            ? '/api/devices/commands/previews'
            : '/api/devices/status-changes/previews')
        )
          previewPosts++;
        if (path.endsWith('/confirm'))
          return Response.json(
            { reason: 'preview-not-found' },
            { status: 404 },
          );
        return ordinary(path, body);
      },
    });
    sessionStorage.setItem(
      `${ACTION_CONFIRMATION_PREFIX}${principal}.${family}.${retainedPreviewId}`,
      JSON.stringify({
        family,
        previewId: retainedPreviewId,
        manifestDigest: retainedDigest,
      }),
    );
    fixture.componentRef.setInput('open', true);
    await settle();

    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'Preview not found',
    );
    expect(element.textContent).toContain('This preview is unavailable');
    expect(previewPosts).toBe(0);

    button('Change action')?.click();
    await settle();
    expect(element.textContent).not.toContain('Loading the selection…');
    expect(
      element.querySelectorAll('mat-radio-button input').length,
    ).toBeGreaterThan(0);

    if (family === 'command') {
      button('Review Reboot')?.click();
    } else {
      await choose(0);
      button('Review Disable')?.click();
    }
    await settle();
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      family === 'command'
        ? 'Review 6 Reboot commands'
        : 'Review 6 Disable status changes',
    );
    expect(previewPosts).toBe(family === 'command' ? 1 : 2);
  });
}

/** The four labels of the Deprovision reason select, in record order (D11). */
const REASON_LABELS = [
  'Retiring from fleet',
  'Different model replacement',
  'Same model replacement',
  'ChromeOS Flex upgrade transfer',
];

/** Open the reason select and return its options. */
async function openReasons(
  element: HTMLElement,
  settle: () => Promise<void>,
): Promise<HTMLElement[]> {
  const select = element.querySelector<HTMLElement>('mat-select');
  if (!select) throw new Error('The reason select is missing.');
  select.click();
  await settle();
  const panels = [
    ...document.querySelectorAll<HTMLElement>('.mat-mdc-select-panel'),
  ];
  return [
    ...(panels.at(-1)?.querySelectorAll<HTMLElement>('mat-option') ?? []),
  ];
}

/** Type one value into the typed phrase field. */
async function typePhrase(
  element: HTMLElement,
  settle: () => Promise<void>,
  value: string,
): Promise<void> {
  const input = element.querySelector<HTMLInputElement>('.field-block input');
  if (!input) throw new Error('The typed phrase field is missing.');
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await settle();
}

it('keeps Wipe and Powerwash visible and disabled without devices:wipe', async () => {
  const { element, radios } = await setup();
  expect(radios()).toHaveLength(3);
  expect(radios()[1].disabled).toBe(true);
  expect(radios()[2].disabled).toBe(true);
  expect(element.textContent).toContain(
    'You need the devices:read, devices:wipe, and devices:bulk-actions permissions to wipe user data or powerwash devices. Ask your administrator for access.',
  );
  // The one command that this person can send starts selected (state 11).
  expect(radios()[0].checked).toBe(true);
});

it('keeps Deprovision visible and disabled without devices:deprovision', async () => {
  const { element, radios } = await setup({
    family: 'status',
    actions: ['devices:read', 'devices:bulk-actions', 'devices:status'],
  });
  expect(radios()).toHaveLength(3);
  expect(radios()[0].disabled).toBe(false);
  expect(radios()[1].disabled).toBe(false);
  expect(radios()[2].disabled).toBe(true);
  expect(element.textContent).toContain(
    'You need the devices:read, devices:deprovision, and devices:bulk-actions permissions to deprovision devices. Ask your administrator for access.',
  );
});

it('collects the Deprovision reason and freezes it into the preview (D12)', async () => {
  const ordinary = standardRequest(reenablePreview, reenableTargets);
  const { element, button, choose, radios, settle, request } = await setup({
    family: 'status',
    actions: [...DEFAULT_ACTIONS, 'devices:deprovision'],
    request: (path, body) => ordinary(path, body),
  });
  await choose(2);
  expect(radios()[2].checked).toBe(true);
  expect(button('Review Deprovision')?.disabled).toBe(true);

  const options = await openReasons(element, settle);
  expect(options.map((option) => option.textContent?.trim())).toEqual(
    REASON_LABELS,
  );
  options[0].click();
  await settle();

  expect(request).toHaveBeenCalledWith('/api/devices/status-changes/previews', {
    gridId: DEVICES_GRID,
    tabId,
    statusAction: 'deprovision',
    deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
  });
  expect(element.textContent).toContain(
    '5 of 8 selected devices are active or disabled.',
  );
  expect(button('Review Deprovision')?.disabled).toBe(false);

  button('Review Deprovision')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 5 Deprovision status changes',
  );
  expect(element.textContent).toContain(
    'Deprovision reason: Retiring from fleet',
  );
  expect(element.textContent).toContain(
    'Deprovision does not erase local data. Send Powerwash first to erase a device that leaves the district.',
  );
});

it('requires a new preview when the Deprovision reason changes (D12)', async () => {
  const ordinary = standardRequest(reenablePreview, reenableTargets);
  const posts: (string | undefined)[] = [];
  let currentReason: string | undefined;
  const { element, button, choose, settle } = await setup({
    family: 'status',
    actions: [...DEFAULT_ACTIONS, 'devices:deprovision'],
    request: (path, body) => {
      const parsed = body as
        | { statusAction?: string; deprovisionReason?: string }
        | undefined;
      if (
        path === '/api/devices/status-changes/previews' &&
        parsed?.statusAction === 'deprovision'
      ) {
        posts.push(parsed.deprovisionReason);
        currentReason = parsed.deprovisionReason;
        return Response.json({
          ...deprovisionPreview,
          deprovisionReason: parsed.deprovisionReason,
        });
      }
      if (
        path ===
          `/api/devices/status-changes/previews/${deprovisionPreviewId}` &&
        currentReason
      )
        return Response.json({
          ...deprovisionPreview,
          deprovisionReason: currentReason,
        });
      return ordinary(path, body);
    },
  });
  await choose(2);
  let options = await openReasons(element, settle);
  options[0].click();
  await settle();
  expect(posts).toEqual(['DEPROVISION_REASON_RETIRING_DEVICE']);

  // A second reason drops the frozen preview and prepares another one.
  options = await openReasons(element, settle);
  options[1].click();
  await settle();
  expect(posts).toEqual([
    'DEPROVISION_REASON_RETIRING_DEVICE',
    'DEPROVISION_REASON_DIFFERENT_MODEL_REPLACEMENT',
  ]);

  button('Review Deprovision')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 5 Deprovision status changes',
  );
  expect(element.textContent).toContain(
    'Deprovision reason: Different model replacement',
  );
});

it('enables Deprovision only when DEPROVISION is typed exactly (D7)', async () => {
  const ordinary = standardRequest(reenablePreview, reenableTargets);
  let confirmBody: unknown = null;
  const { element, button, choose, settle } = await setup({
    family: 'status',
    actions: [...DEFAULT_ACTIONS, 'devices:deprovision'],
    request: (path, body) => {
      if (path.endsWith('/confirm')) {
        confirmBody = body;
        return Response.json(statusReceipt, { status: 201 });
      }
      return ordinary(path, body);
    },
  });
  await choose(2);
  const options = await openReasons(element, settle);
  options[0].click();
  await settle();
  button('Review Deprovision')?.click();
  await settle();
  button('Continue to confirmation')?.click();
  await settle();

  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Deprovision 5 devices',
  );
  // Deprovision carries no acknowledgment box (D8).
  expect(element.querySelectorAll('mat-checkbox')).toHaveLength(0);
  const create = () => button('Deprovision 5 devices');
  expect(create()?.disabled).toBe(true);
  expect(element.textContent).not.toContain('The phrase does not match.');

  await typePhrase(element, settle, 'deprovision');
  expect(create()?.disabled).toBe(true);
  expect(element.textContent).toContain(
    'The phrase does not match. Type DEPROVISION.',
  );

  await typePhrase(element, settle, ' DEPROVISION ');
  expect(create()?.disabled).toBe(false);
  create()?.click();
  await settle();
  expect(confirmBody).toEqual({
    manifestDigest: deprovisionPreview.manifestDigest,
    acknowledged: true,
    typedPhrase: 'DEPROVISION',
  });
});

it('requires the acknowledgment and the phrase of Wipe and Powerwash (D8)', async () => {
  const { element, button, choose, acknowledge, settle } = await setup({
    actions: [...DEFAULT_ACTIONS, 'devices:wipe'],
  });
  await choose(1);
  expect(element.textContent).toContain(
    'Removes local user profiles. Device policy and enrollment remain.',
  );
  button('Review Wipe user data')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 6 Wipe user data commands',
  );
  expect(element.textContent).toContain(
    'An offline device runs Wipe user data when it next connects, unless the command expires first. The job shows the expiry that Google returns.',
  );
  button('Continue to confirmation')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Wipe user data on 6 devices',
  );
  expect(element.textContent).toContain(
    'I understand that all local user profile data will be removed.',
  );
  expect(button('Send Wipe to 6 devices')?.disabled).toBe(true);
  await typePhrase(element, settle, 'WIPE');
  expect(button('Send Wipe to 6 devices')?.disabled).toBe(true);
  await acknowledge();
  expect(button('Send Wipe to 6 devices')?.disabled).toBe(false);

  // POWERWASH is not WIPE (completion step 3).
  await typePhrase(element, settle, 'POWERWASH');
  expect(button('Send Wipe to 6 devices')?.disabled).toBe(true);

  button('Back to preview')?.click();
  await settle();
  button('Back to command')?.click();
  await settle();
  await choose(2);
  button('Review Powerwash')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 6 Powerwash commands',
  );
  button('Continue to confirmation')?.click();
  await settle();
  await typePhrase(element, settle, 'WIPE');
  await acknowledge();
  expect(button('Send Powerwash to 6 devices')?.disabled).toBe(true);
  await typePhrase(element, settle, 'POWERWASH');
  expect(button('Send Powerwash to 6 devices')?.disabled).toBe(false);
});
