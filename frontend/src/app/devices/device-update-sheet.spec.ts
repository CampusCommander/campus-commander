import { ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  DeviceRow,
  DeviceSelectionSpec,
  DeviceUpdateField,
  DeviceUpdatePreview,
  DeviceUpdateTarget,
  DeviceUpdateTextField,
  JobDetail,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DevicesStore } from './devices.store';
import { DeviceUpdateConfirmationStore } from './device-update-confirmation.store';
import { DeviceUpdateDraftStore } from './device-update-draft.store';
import { DeviceGridDraftStore } from './device-grid-draft.store';
import { DeviceOrgUnitTreeStore } from './device-org-unit-tree.store';
import {
  DeviceUpdateSheet,
  ORG_UNIT_MOVE_BLOCKED_NOTE,
  SELECTION_CHANGED_NOTE,
} from './device-update-sheet';

const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const previewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

const preview: DeviceUpdatePreview = {
  previewId,
  displayId: 'PV-006',
  changes: [
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ],
  fieldChanges: 6,
  selected: 6,
  eligible: 6,
  unchanged: 0,
  excluded: 0,
  conflicts: 0,
  oldestObservedAt: '2026-10-19T10:00:00.000Z',
  stale: false,
  preparedAt: '2026-10-19T12:00:00.000Z',
  expiresAt: '2026-10-19T12:15:00.000Z',
  manifestDigest: 'a'.repeat(64),
};

const previewReadPath = `/api/devices/updates/previews/${previewId}`;

/** The organization unit tree of the granted read (design section 6). */
const orgUnitTree = {
  state: 'granted' as const,
  scope: 'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
  failure: null,
  orgUnits: [
    {
      orgUnitId: 'ou-root',
      name: 'example.org',
      orgUnitPath: '/',
      parentOrgUnitId: null,
    },
    {
      orgUnitId: 'ou-chrome',
      name: 'Chrome Devices',
      orgUnitPath: '/Chrome Devices',
      parentOrgUnitId: 'ou-root',
    },
    {
      orgUnitId: 'ou-cart',
      name: 'Cart Devices',
      orgUnitPath: '/Chrome Devices/Cart Devices',
      parentOrgUnitId: 'ou-chrome',
    },
  ],
  observedAt: '2026-10-21T12:00:00.000Z',
};

/** The answer of a read without the organization unit scope. */
const deniedOrgUnitTree = {
  ...orgUnitTree,
  state: 'denied' as const,
  failure: 'scope-mismatch' as const,
  orgUnits: null,
};

const targets = [
  {
    deviceId: 'synthetic-device-1',
    serialNumber: 'C0A1-0001',
    field: 'annotatedLocation' as const,
    observedValue: 'Science wing',
    baselineValue: 'Science wing',
    approvedValue: 'North lab',
    duplicateSerialNumber: null,
    disposition: 'eligible' as const,
    exclusionReason: null,
  },
  {
    deviceId: 'synthetic-device-2',
    serialNumber: 'C0A1-0002',
    field: 'annotatedLocation' as const,
    observedValue: null,
    baselineValue: null,
    approvedValue: 'North lab',
    duplicateSerialNumber: null,
    disposition: 'eligible' as const,
    exclusionReason: null,
  },
  {
    deviceId: 'synthetic-device-3',
    serialNumber: 'C0A1-0003',
    field: 'annotatedLocation' as const,
    observedValue: 'Science wing',
    baselineValue: 'Science wing',
    approvedValue: null,
    duplicateSerialNumber: null,
    disposition: 'excluded' as const,
    exclusionReason: 'removed',
  },
];

const receipt = {
  jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  displayId: 'UPD-006',
  status: 'accepted' as const,
  deviceCount: 6,
  updateCount: 6,
};

/** The three text fields of F2, one row per device and changed field. */
function targetRows(
  deviceId: string,
  serialNumber: string,
  disposition: 'eligible' | 'excluded',
): DeviceUpdateTarget[] {
  const values = [
    ['annotatedLocation', 'Science wing', 'North lab'],
    ['annotatedUser', 'luis.ortiz@example.org', 'maya.chen@example.org'],
    ['notes', null, 'Cart 7 loaner pool'],
  ] as const;
  return values.map(([field, observedValue, approvedValue]) => ({
    deviceId,
    serialNumber,
    field,
    observedValue,
    baselineValue: observedValue,
    approvedValue: disposition === 'excluded' ? null : approvedValue,
    duplicateSerialNumber: null,
    disposition,
    exclusionReason: disposition === 'excluded' ? 'removed' : null,
  }));
}

const multiTargets: DeviceUpdateTarget[] = [
  ...targetRows('synthetic-device-1', 'C0A1-0001', 'eligible'),
  ...targetRows('synthetic-device-2', 'C0A1-0002', 'eligible'),
  ...targetRows('synthetic-device-3', 'C0A1-0003', 'eligible'),
  ...targetRows('synthetic-device-4', 'C0A1-0004', 'eligible'),
  ...targetRows('synthetic-device-5', 'C0A1-0005', 'eligible'),
  ...targetRows('synthetic-device-6', 'C0A1-0006', 'excluded'),
];

const multiPreview: DeviceUpdatePreview = {
  ...preview,
  changes: [
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
    {
      field: 'annotatedUser',
      mode: 'replace',
      value: 'maya.chen@example.org',
    },
    { field: 'notes', mode: 'replace', value: 'Cart 7 loaner pool' },
  ],
  fieldChanges: 15,
  selected: 6,
  eligible: 5,
  excluded: 1,
};

const twoFieldPreview: DeviceUpdatePreview = {
  ...multiPreview,
  changes: [
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
    { field: 'notes', mode: 'replace', value: 'Cart 7 loaner pool' },
  ],
  fieldChanges: 10,
};

const twoFieldTargets: DeviceUpdateTarget[] = multiTargets.filter(
  (target) => target.field !== 'annotatedUser',
);

const job: JobDetail = {
  jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  displayId: 'UPD-006',
  revision: 1,
  action: 'update-device-annotations',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 6 },
  requestedBy: { id: principal, displayName: 'District operator' },
  createdAt: '2026-10-19T12:00:00.000Z',
  startedAt: '2026-10-19T12:01:00.000Z',
  finishedAt: null,
  progress: {
    total: 6,
    succeeded: 2,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    pending: 4,
  },
  failure: null,
  confirmedBy: { id: principal, displayName: 'District operator' },
  previewDisplayId: 'PV-006',
  changes: [
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ],
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: ['/School A'],
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: '2026-10-19T12:01:00.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
};

/** The job of the several-field receipt: 5 devices and 15 field changes. */
const multiJob: JobDetail = {
  ...job,
  scope: { kind: 'devices', deviceCount: 5 },
  progress: { ...job.progress, total: 5, pending: 2 },
  changes: multiPreview.changes,
};

type RequestHandler = (
  path: string,
  body: unknown,
) => Promise<Response> | Response;

interface SetupOptions {
  count?: number;
  spec?: DeviceSelectionSpec | null;
  request?: RequestHandler;
  open?: boolean;
  /** The draft that the sheet prepares. The grid source opens at its edit-list preview. */
  source?: 'selection' | 'grid';
  /** Stage grid entries after the test bed exists and before the sheet opens. */
  stage?: (grid: DeviceGridDraftStore) => void;
}

async function setup(options: SetupOptions = {}) {
  sessionStorage.clear();
  /** Every exception that Angular's error handler reports during the test. */
  const angularErrors: unknown[] = [];
  const spec = signal<DeviceSelectionSpec | null>(
    options.spec === undefined ? selection(options.count ?? 6) : options.spec,
  );
  const revision = signal(0);
  const getSpec = vi.fn(async () => {
    if (options.spec === undefined) spec.set(selection(options.count ?? 6));
    return { terms: [], selectedCount: spec()?.selectedCount ?? 0 };
  });
  /** One applied selection change: the grid sends ops, so the revision moves. */
  const mutate = (next: DeviceSelectionSpec) => {
    spec.set(next);
    revision.update((value) => value + 1);
  };
  const devices = {
    selection: { getSpec, spec, revision },
    selectionTab: tabId,
    selectedView: signal(false),
    offline: signal(false),
  };
  const request = vi.fn(
    async (path: string, body?: unknown): Promise<Response> => {
      if (options.request) return options.request(path, body);
      if (path === '/api/devices/updates/org-units')
        return Response.json(orgUnitTree);
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === `/api/devices/updates/previews/${previewId}`)
        return Response.json(preview);
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path.endsWith('/confirm'))
        return Response.json(receipt, { status: 201 });
      if (path === '/api/jobs/UPD-006') return Response.json(job);
      return Response.json({}, { status: 404 });
    },
  );
  TestBed.configureTestingModule({
    imports: [DeviceUpdateSheet],
    providers: [
      provideRouter([]),
      { provide: DevicesStore, useValue: devices },
      {
        provide: ErrorHandler,
        useValue: {
          handleError: (error: unknown) => angularErrors.push(error),
        },
      },
      {
        provide: AuthStore,
        useValue: {
          session: signal({
            identity: { id: principal, grants: [] },
            expiresAt: '2026-10-20T12:00:00.000Z',
            csrfToken: 'a'.repeat(64),
          }),
          metadata: signal({
            phase: 3,
            authenticationConfigured: true,
            version: 'test',
            build: 'client-review',
          }),
          request,
        },
      },
    ],
  });
  const navigate = vi
    .spyOn(TestBed.inject(Router), 'navigate')
    .mockResolvedValue(true);
  const fixture = TestBed.createComponent(DeviceUpdateSheet);
  if (options.stage) options.stage(TestBed.inject(DeviceGridDraftStore));
  fixture.componentRef.setInput('source', options.source ?? 'selection');
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
  const block = (field: DeviceUpdateField) =>
    element.querySelector<HTMLElement>(`.field-block[data-field="${field}"]`);
  const valueInput = (field: DeviceUpdateTextField = 'annotatedLocation') =>
    block(field)?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea',
    ) ?? null;
  const input = () => valueInput('annotatedLocation');
  const type = async (
    value: string,
    field: DeviceUpdateTextField = 'annotatedLocation',
  ) => {
    if (TestBed.inject(DeviceUpdateDraftStore).modeOf(field) !== 'replace') {
      TestBed.inject(DeviceUpdateDraftStore).setMode(field, 'replace');
      await settle();
    }
    const target = valueInput(field);
    if (!target) throw new Error(`The ${field} value field is missing.`);
    target.value = value;
    target.dispatchEvent(new Event('input'));
    await settle();
  };
  const open = async () => {
    fixture.componentRef.setInput('open', true);
    await settle();
  };
  const close = async () => {
    fixture.componentRef.setInput('open', false);
    await settle();
  };
  const save = async () => {
    button('Save and preview')?.click();
    await settle();
  };
  const acknowledge = async () => {
    const box = element.querySelector<HTMLInputElement>(
      'mat-checkbox input[type="checkbox"]',
    );
    if (!box) throw new Error('The acknowledgement checkbox is missing.');
    box.click();
    await settle();
  };
  /** The Organization unit field block and its mode select. */
  const orgBlock = () => block('orgUnitPath');
  const orgSelect = () =>
    orgBlock()?.querySelector<HTMLElement>('.mat-mdc-select-trigger') ?? null;
  const option = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('mat-option')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
  /** Open the mode select and choose one option, as a pointer does. */
  const chooseOrgMode = async (label: string) => {
    orgSelect()?.click();
    await settle();
    const found = option(label);
    if (!found) throw new Error(`The ${label} option is missing.`);
    found.click();
    await settle();
  };
  const picker = () =>
    element.querySelector<HTMLElement>('app-device-org-unit-picker');
  const treeItem = (name: string) =>
    [
      ...(picker()?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []),
    ].find((row) => row.textContent?.trim() === name);
  const pickerButton = (label: string) =>
    [...(picker()?.querySelectorAll('button') ?? [])].find(
      (candidate) =>
        candidate.textContent?.replace(/\s+/g, ' ').trim() === label,
    );
  const search = () =>
    picker()?.querySelector<HTMLInputElement>('input[type="search"]') ?? null;
  const typeSearch = async (value: string) => {
    const input = search();
    if (!input) throw new Error('The organization unit search is missing.');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  };
  return {
    fixture,
    element,
    spec,
    revision,
    mutate,
    request,
    navigate,
    closed,
    button,
    block,
    input,
    valueInput,
    type,
    settle,
    open,
    close,
    save,
    acknowledge,
    orgBlock,
    orgSelect,
    chooseOrgMode,
    picker,
    treeItem,
    pickerButton,
    search,
    typeSearch,
    angularErrors,
    tree: TestBed.inject(DeviceOrgUnitTreeStore),
    draft: TestBed.inject(DeviceUpdateDraftStore),
  };
}

it('opens at Edit with the selection count and the four fields', async () => {
  const { element, button, block, input } = await setup();
  const heading = element.querySelector('h1');
  expect(heading?.textContent?.trim()).toBe('Update 6 devices');
  expect(element.textContent).toContain(
    '6 devices · 0 changed fields · Not submitted',
  );
  expect(element.textContent).not.toContain('Asset tag');
  expect(element.querySelectorAll('.field-block')).toHaveLength(4);
  expect(
    [...element.querySelectorAll('.field-block mat-label')].map((label) =>
      label.textContent?.trim(),
    ),
  ).toEqual([
    'Annotated location',
    'Annotated user',
    'Notes',
    'Organization unit',
  ]);
  // Each field starts at Leave unchanged, so no value field is shown.
  for (const field of [
    'annotatedLocation',
    'annotatedUser',
    'notes',
    'orgUnitPath',
  ] as const) {
    expect(block(field)?.textContent).toContain('Leave unchanged');
    expect(
      block(field)?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        'input, textarea',
      ),
    ).toBeNull();
  }
  expect(input()).toBeNull();
  // The granted read leaves the Organization unit field usable.
  expect(block('orgUnitPath')?.textContent).not.toContain(
    'Google denied organization unit reads',
  );
  expect(button('Save and preview')?.disabled).toBe(true);
  expect(button('Reset')?.disabled).toBe(true);
});

it('shows the step order and the stepper states', async () => {
  const { element, type, save, settle, acknowledge } = await setup();
  const steps = () => [...element.querySelectorAll('li.step')];
  expect(steps().map((step) => step.textContent?.trim())).toEqual([
    '1Edit',
    '2Review, not started',
    '3Confirm, not started',
  ]);
  expect(steps()[0].getAttribute('aria-current')).toBe('step');
  expect(steps()[1].getAttribute('aria-current')).toBeNull();

  await type('North lab');
  await save();
  expect(steps()[0].classList).toContain('is-done');
  expect(steps()[1].classList).toContain('is-active');
  expect(steps()[1].getAttribute('aria-current')).toBe('step');

  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  expect(steps()[1].classList).toContain('is-done');
  expect(steps()[2].classList).toContain('is-active');

  await acknowledge();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Create update job')
      candidate.click();
  });
  await settle();
  expect(steps().every((step) => step.classList.contains('is-done'))).toBe(
    true,
  );
  expect(
    steps().every((step) => step.getAttribute('aria-current') === null),
  ).toBe(true);
});

it('shows one device and one changed field in the singular', async () => {
  const { element, type } = await setup({ count: 1 });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 1 device',
  );
  type('North lab');
  expect(element.textContent).toContain(
    '1 device · 1 changed field · Not submitted',
  );
});

it('rejects a whitespace-only value and keeps Save and preview disabled', async () => {
  const { element, button, type } = await setup();
  await type('   ');
  expect(element.textContent).toContain(
    'Annotated location needs a visible character.',
  );
  expect(button('Save and preview')?.disabled).toBe(true);
});

it('explains an empty Replace value once the field loses focus', async () => {
  const { block, draft, settle, valueInput } = await setup();
  draft.setMode('notes', 'replace');
  await settle();
  const notes = block('notes');
  expect(notes?.querySelector('.error')).toBeNull();
  expect(
    notes?.querySelector('mat-form-field.mat-form-field-invalid'),
  ).toBeNull();

  valueInput('notes')?.dispatchEvent(new Event('blur'));
  await settle();
  expect(notes?.textContent).toContain('Notes holds 1 to 500 characters.');
  expect(
    notes?.querySelector('mat-form-field.mat-form-field-invalid'),
  ).not.toBeNull();
});

it('shows the limit of each field in its hint and counter', async () => {
  const { element, block, type } = await setup();
  await type('North lab', 'annotatedLocation');
  await type('maya.chen@example.org', 'annotatedUser');
  await type('Cart 7 loaner pool', 'notes');
  expect(block('annotatedLocation')?.textContent).toContain(
    'Use 200 characters or fewer. Spaces alone do not count.',
  );
  expect(block('annotatedLocation')?.textContent).toContain(
    '9 of 200 characters',
  );
  expect(block('annotatedUser')?.textContent).toContain(
    'Use 100 characters or fewer. Spaces alone do not count.',
  );
  expect(block('annotatedUser')?.textContent).toContain('21 of 100 characters');
  expect(block('notes')?.textContent).toContain(
    'Use 500 characters or fewer. Spaces alone do not count.',
  );
  expect(block('notes')?.textContent).toContain('18 of 500 characters');
  expect(element.textContent).toContain(
    '6 devices · 3 changed fields · Not submitted',
  );
});

it('shows the Notes value in a text area that grows with the text', async () => {
  const { block, type } = await setup();
  await type('Cart 7 loaner pool', 'notes');
  expect(
    block('notes')?.querySelector('textarea.mat-mdc-input-element'),
  ).not.toBeNull();
  expect(block('annotatedLocation')?.querySelector('textarea')).toBeNull();
});

it('disables Save and preview while a value is over its limit', async () => {
  const { block, button, type } = await setup();
  await type('a'.repeat(501), 'notes');
  expect(block('notes')?.textContent).toContain('501 of 500 characters');
  const error = block('notes')?.querySelector('.error');
  expect(error?.textContent?.trim()).toBe('Notes holds 1 to 500 characters.');
  expect(error?.getAttribute('role')).toBe('alert');
  // The value field takes the error outline of frame 04.
  expect(
    block('notes')?.querySelector('mat-form-field.mat-form-field-invalid'),
  ).not.toBeNull();
  expect(button('Save and preview')?.disabled).toBe(true);

  await type('b'.repeat(101), 'annotatedUser');
  expect(block('annotatedUser')?.textContent).toContain(
    'Annotated user holds 1 to 100 characters.',
  );
  expect(button('Save and preview')?.disabled).toBe(true);

  await type('North lab', 'annotatedUser');
  await type('Cart 7 loaner pool', 'notes');
  expect(block('annotatedUser')?.querySelector('.error')).toBeNull();
  expect(block('notes')?.querySelector('.error')).toBeNull();
  expect(button('Save and preview')?.disabled).toBe(false);
});

it('sends every changed field in contract order', async () => {
  const { draft, request, type, save, settle } = await setup();
  await type('Cart 7 loaner pool', 'notes');
  await type('maya.chen@example.org', 'annotatedUser');
  draft.setMode('annotatedLocation', 'clear');
  await settle();
  await save();
  const create = request.mock.calls.find(([path]) =>
    path.endsWith('/previews'),
  );
  expect(create?.[1]).toEqual({
    gridId: 'devices',
    tabId,
    changes: [
      { field: 'annotatedLocation', mode: 'clear' },
      {
        field: 'annotatedUser',
        mode: 'replace',
        value: 'maya.chen@example.org',
      },
      { field: 'notes', mode: 'replace', value: 'Cart 7 loaner pool' },
    ],
  });
});

it('sends the replace value and shows the frozen review', async () => {
  const { element, request, type, save } = await setup();
  await type('North lab');
  await save();
  const create = request.mock.calls.find(([path]) =>
    path.endsWith('/previews'),
  );
  expect(create?.[1]).toEqual({
    gridId: 'devices',
    tabId,
    changes: [
      { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
    ],
  });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 6 device updates',
  );
  expect(element.textContent).toContain(
    '6 devices · 6 field changes · 0 excluded',
  );
  expect(element.textContent).toContain(
    'Targets and final values are frozen. New matching devices will not join this job.',
  );
  expect(element.textContent).toContain('Preview\u00a0PV\u2011006');
  expect(element.textContent).toContain('Annotated location');
  expect(element.textContent).toContain('C0A1-0001');
  expect(element.textContent).toContain('Science wing');
  expect(element.textContent).toContain('North lab');
  expect(element.textContent).toContain('Excluded · Removed from inventory');
});

it('shows one row group per device and one row per changed field', async () => {
  const { element, type, save } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(multiPreview, { status: 201 });
      if (path.includes('/targets'))
        return Response.json({ targets: multiTargets, nextCursor: null });
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  expect(element.textContent).toContain(
    '6 devices · 15 field changes · 1 excluded',
  );
  expect(element.querySelector('.list-label')?.textContent?.trim()).toBe(
    'Field changes',
  );
  expect(
    [...element.querySelectorAll('.targets thead th')].map((cell) =>
      cell.textContent?.trim(),
    ),
  ).toEqual(['Field', 'Observed value', 'Change', 'Approved value']);

  const groups = [...element.querySelectorAll('.targets tbody')];
  expect(groups).toHaveLength(6);
  expect(groups[0].querySelector('.device-row')?.textContent).toContain(
    'C0A1-0001',
  );
  expect(groups[0].querySelectorAll('tr')).toHaveLength(4);
  expect(
    [...groups[0].querySelectorAll('th[scope="row"]')].map((cell) =>
      cell.textContent?.trim(),
    ),
  ).toEqual(['Annotated location', 'Annotated user', 'Notes']);
  expect(groups[5].querySelector('.device-row')?.textContent).toContain(
    'Excluded · Removed from inventory',
  );
  expect(groups[5].querySelectorAll('td.not-updated')).toHaveLength(3);
});

it('lists one confirmation sentence per changed field and names the unchanged field', async () => {
  const { element, type, save, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(twoFieldPreview, { status: 201 });
      if (path === previewReadPath) return Response.json(twoFieldPreview);
      if (path.includes('/targets'))
        return Response.json({ targets: twoFieldTargets, nextCursor: null });
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  clickButton(element, 'Continue to confirmation');
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Confirm 5 device updates',
  );
  expect(
    element.querySelector('#confirm-scope-title')?.textContent?.trim(),
  ).toBe('Update 2 fields on 5 devices');
  expect(
    [...element.querySelectorAll('.change-list li')].map((item) =>
      item.textContent?.trim(),
    ),
  ).toEqual([
    'Set the annotated location to North lab on 5 devices.',
    'Set the notes to Cart 7 loaner pool on 5 devices.',
  ]);
  expect(element.textContent).toContain(
    'Annotated user and organization unit remain unchanged.',
  );
  expect(element.textContent).toContain(
    'Preview PV-006 · 6 devices · 10 field changes',
  );
});

it('counts each confirmation sentence from its field rows when eligibility differs', async () => {
  // One eligible device already holds the requested Notes, so that sentence names four
  // devices while the location sentence names five.
  const mixedPreview: DeviceUpdatePreview = {
    ...twoFieldPreview,
    fieldChanges: 9,
  };
  const mixedTargets: DeviceUpdateTarget[] = twoFieldTargets.map((target) =>
    target.field === 'notes' && target.deviceId === 'synthetic-device-1'
      ? { ...target, disposition: 'unchanged' as const }
      : target,
  );
  const { element, type, save, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(mixedPreview, { status: 201 });
      if (path === previewReadPath) return Response.json(mixedPreview);
      if (path.includes('/targets'))
        return Response.json({ targets: mixedTargets, nextCursor: null });
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  clickButton(element, 'Continue to confirmation');
  await settle();
  expect(
    [...element.querySelectorAll('.change-list li')].map((item) =>
      item.textContent?.trim(),
    ),
  ).toEqual([
    'Set the annotated location to North lab on 5 devices.',
    'Set the notes to Cart 7 loaner pool on 4 devices.',
  ]);
});

it('names the unchanged field when the draft changes three of four fields', async () => {
  const { element, type, save, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(multiPreview, { status: 201 });
      if (path === previewReadPath) return Response.json(multiPreview);
      if (path.includes('/targets'))
        return Response.json({ targets: multiTargets, nextCursor: null });
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  clickButton(element, 'Continue to confirmation');
  await settle();
  expect(element.querySelectorAll('.change-list li')).toHaveLength(3);
  // Organization unit keeps its value, so the sentence names it.
  expect(element.textContent).toContain('Organization unit remains unchanged.');
});

it('shows the receipt for several fields', async () => {
  const { element, type, save, acknowledge, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(multiPreview, { status: 201 });
      if (path === previewReadPath) return Response.json(multiPreview);
      if (path.includes('/targets'))
        return Response.json({ targets: multiTargets, nextCursor: null });
      if (path.endsWith('/confirm'))
        return Response.json(receipt, { status: 201 });
      if (path === '/api/jobs/UPD-006') return Response.json(multiJob);
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  clickButton(element, 'Continue to confirmation');
  await settle();
  await acknowledge();
  clickButton(element, 'Create update job');
  await settle();
  expect(element.textContent).toContain(
    '5 devices · 15 field changes. Google changes have not completed.',
  );
});

it('sends a clear choice without a value', async () => {
  const { draft, request, save, settle } = await setup();
  draft.setMode('annotatedLocation', 'clear');
  await settle();
  await save();
  const create = request.mock.calls.find(([path]) =>
    path.endsWith('/previews'),
  );
  expect(create?.[1]).toEqual({
    gridId: 'devices',
    tabId,
    changes: [{ field: 'annotatedLocation', mode: 'clear' }],
  });
});

it('shows the stored expired selection without losing the draft', async () => {
  const { element, input, button } = await setup({
    spec: selection(0, '2026-10-19T11:00:00.000Z'),
  });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Selection expired',
  );
  expect(element.textContent).toContain('Select the devices again');
  expect(element.textContent).toContain(
    'The browsing selection expired. Approved jobs and their frozen targets remain available.',
  );
  expect(button('Save and preview')).toBeUndefined();
  expect(input()).toBeNull();
});

it('shows the empty selection state', async () => {
  const { element } = await setup({ count: 0 });
  expect(element.textContent).toContain('No devices are selected');
});

it('shows the expired selection on a 409 answer and keeps the draft', async () => {
  const { element, input, type, save } = await setup({
    request: (path) =>
      path.endsWith('/previews')
        ? Response.json({ reason: 'selection-expired' }, { status: 409 })
        : Response.json({}, { status: 404 }),
  });
  await type('North lab');
  expect(input()?.value).toBe('North lab');
  await save();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Selection expired',
  );
  expect(input()).toBeNull();
});

it('keeps the draft when the sheet closes and reopens at Edit', async () => {
  const { element, input, type, close, open, settle } = await setup();
  await type('North lab');
  await close();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );
  await open();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );
  await settle();
  expect(input()?.value).toBe('North lab');
});

it('closes with the Close button and with Escape', async () => {
  const { closed, element } = await setup();
  element
    .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    ?.click();
  expect(closed).toHaveBeenCalledTimes(1);
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  expect(closed).toHaveBeenCalledTimes(2);
});

it('moves focus to the sheet headline when it opens', async () => {
  const { fixture, element, open } = await setup({ open: false });
  fixture.detectChanges();
  await open();
  expect(document.activeElement).toBe(element.querySelector('h1'));
});

it('shows the selection-change note and keeps the frozen preview', async () => {
  const { element, mutate, type, save, settle } = await setup();
  await type('North lab');
  await save();
  expect(element.textContent).not.toContain(SELECTION_CHANGED_NOTE);

  mutate(selection(7));
  await settle();
  expect(element.textContent).toContain(SELECTION_CHANGED_NOTE);
  // The frozen targets stay visible.
  expect(element.textContent).toContain('C0A1-0001');
  expect(element.textContent).toContain(
    '6 devices · 6 field changes · 0 excluded',
  );

  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  expect(element.textContent).toContain(SELECTION_CHANGED_NOTE);
});

it('shows the note when a row is replaced at the same count', async () => {
  const { element, mutate, type, save, settle } = await setup();
  await type('North lab');
  await save();
  expect(element.textContent).not.toContain(SELECTION_CHANGED_NOTE);

  // Devices 1, 2, 3 become 2, 3, 4: every count stays the same.
  mutate(selection(6));
  await settle();
  expect(element.textContent).toContain(SELECTION_CHANGED_NOTE);
  expect(element.textContent).toContain('C0A1-0001');
  expect(element.textContent).toContain(
    '6 devices · 6 field changes · 0 excluded',
  );

  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Confirm 6 device updates',
  );
  expect(element.textContent).toContain(SELECTION_CHANGED_NOTE);
});

it('sends the preview digest after the acknowledgement', async () => {
  const { element, request, type, save, acknowledge, settle } = await setup();
  await type('North lab');
  await save();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  const create = () =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Create update job',
    );
  expect(create()?.disabled).toBe(true);
  await acknowledge();
  expect(create()?.disabled).toBe(false);
  create()?.click();
  await settle();
  const confirm = request.mock.calls.find(([path]) =>
    path.endsWith('/confirm'),
  );
  expect(confirm?.[1]).toEqual({
    manifestDigest: 'a'.repeat(64),
    acknowledged: true,
  });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update job created',
  );
  expect(element.textContent).toContain('Job UPD-006 · Running');
  expect(element.textContent).toContain('Your job is saved');
  expect(element.textContent).toContain(
    '6 devices · 6 field changes. Google changes have not completed.',
  );
  expect(element.textContent).toContain(
    'You can close this panel and follow progress in Jobs.',
  );
});

it('opens the job detail page with View job', async () => {
  const { element, navigate, type, save, acknowledge, settle } = await setup();
  await type('North lab');
  await save();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  await acknowledge();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Create update job')
      candidate.click();
  });
  await settle();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'View job') candidate.click();
  });
  expect(navigate).toHaveBeenCalledWith(['/jobs', 'UPD-006']);
});

it('shows the 410 expired preview inside the Review step', async () => {
  const { element, type, save } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path.includes('/targets'))
        return Response.json(
          {
            reason: 'preview-expired',
            expiresAt: '2026-10-19T12:15:00.000Z',
          },
          { status: 410 },
        );
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Preview expired',
  );
  expect(element.textContent).toContain(
    'Prepare a new preview before confirming',
  );
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Review',
  );
});

it('shows a 403 permission change inside the Confirm step', async () => {
  const { element, type, save, acknowledge, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) return Response.json(preview);
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path.endsWith('/confirm'))
        return Response.json({ reason: 'forbidden' }, { status: 403 });
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  await acknowledge();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Create update job')
      candidate.click();
  });
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update device is unavailable',
  );
  expect(element.textContent).toContain(
    'Your access does not permit this update',
  );
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Confirm',
  );
});

it('shows the offline state inside the step and keeps the draft', async () => {
  const { element, input, type, save } = await setup({
    request: () => Promise.reject(new TypeError('offline')),
  });
  await type('North lab');
  await save();
  expect(element.textContent).toContain('Cannot reach Campus Commander');
  expect(element.textContent).toContain(
    'Your draft stays in this tab. Reconnect before you prepare a preview.',
  );
  expect(input()?.value).toBe('North lab');
});

it('replays a retained confirmation before creating a preview', async () => {
  const { request, type, save } = await setup();
  sessionStorage.setItem(
    `cc.device-update-confirmation.${principal}.${previewId}`,
    JSON.stringify({
      previewId,
      manifestDigest: 'a'.repeat(64),
    }),
  );
  await type('North lab');
  await save();
  expect(request.mock.calls.some(([path]) => path.endsWith('/confirm'))).toBe(
    true,
  );
  expect(
    request.mock.calls.some(
      ([path]) => path === '/api/devices/updates/previews',
    ),
  ).toBe(false);
});

it('keeps a replayed update confirmation when the replay needs the connection', async () => {
  let confirmations = 0;
  const { element, type, save, settle, acknowledge } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) return Response.json(preview);
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path.endsWith('/confirm')) {
        confirmations++;
        return confirmations === 1
          ? Promise.reject(new TypeError('The connection closed.'))
          : Response.json({ reason: 'connection-required' }, { status: 409 });
      }
      if (path === '/api/jobs/UPD-006') return Response.json(job);
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  await acknowledge();
  clickButton(element, 'Create update job');
  await settle();
  expect(element.textContent).toContain('The confirmation did not finish');
  const key = `cc.device-update-confirmation.${principal}.${previewId}`;
  expect(sessionStorage.getItem(key)).not.toBeNull();

  // The replay answer arrives before the API reads the existing receipt.
  clickButton(element, 'Retry');
  await settle();
  expect(confirmations).toBe(2);
  expect(element.textContent).toContain('The update job may exist');
  expect(element.textContent).toContain('Check Jobs for the update job');
  expect(sessionStorage.getItem(key)).not.toBeNull();
});

// These replay answers arrive before the API checks for an existing receipt. None of
// them proves that the lost first request created no job.
const earlyAnswers = [
  { answer: 'forbidden', status: 403 },
  { answer: 'permission-changed', status: 409 },
  { answer: 'preview-changed', status: 409 },
  { answer: 'connection-required', status: 409 },
] as const;

/** The record that a lost confirmation leaves in this tab. */
function retainConfirmation(): void {
  sessionStorage.setItem(
    `cc.device-update-confirmation.${principal}.${previewId}`,
    JSON.stringify({ previewId, manifestDigest: 'a'.repeat(64) }),
  );
}

const retainedKey = `cc.device-update-confirmation.${principal}.${previewId}`;

for (const { answer, status } of earlyAnswers) {
  it(`keeps a retained confirmation when Save and preview answers ${answer}`, async () => {
    const { element, request, type, save } = await setup({
      request: (path) =>
        path.endsWith('/confirm')
          ? Response.json({ reason: answer }, { status })
          : Response.json({}, { status: 404 }),
    });
    retainConfirmation();
    await type('North lab');
    await save();
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'The update job may exist',
    );
    expect(element.textContent).toContain('The receipt is unavailable');
    expect(element.textContent).toContain('Check Jobs for the update job');
    // No replacement preview leaves the page.
    expect(
      request.mock.calls.filter(
        ([path]) => path === '/api/devices/updates/previews',
      ),
    ).toHaveLength(0);
    expect(sessionStorage.getItem(retainedKey)).not.toBeNull();
  });

  it(`keeps a retained confirmation when Prepare new preview answers ${answer}`, async () => {
    const { element, request, type, save, settle } = await setup({
      request: (path) => {
        if (path === '/api/devices/updates/previews')
          return Response.json(preview, { status: 201 });
        if (path.includes('/targets'))
          return Response.json(
            {
              reason: 'preview-expired',
              expiresAt: '2026-10-19T12:15:00.000Z',
            },
            { status: 410 },
          );
        if (path.endsWith('/confirm'))
          return Response.json({ reason: answer }, { status });
        return Response.json({}, { status: 404 });
      },
    });
    await type('North lab');
    await save();
    expect(element.textContent).toContain('Preview expired');
    retainConfirmation();
    clickButton(element, 'Prepare new preview');
    await settle();
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'The update job may exist',
    );
    expect(element.textContent).toContain(
      'Review the Jobs page before you prepare another preview.',
    );
    // The only preview request is the one that produced the expired preview.
    expect(
      request.mock.calls.filter(
        ([path]) => path === '/api/devices/updates/previews',
      ),
    ).toHaveLength(1);
    expect(sessionStorage.getItem(retainedKey)).not.toBeNull();
  });
}

it('replays the same preview and digest after a closure and opens the later receipt', async () => {
  let confirmations = 0;
  const { element, request, type, save, acknowledge, settle, close, open } =
    await setup({
      request: (path) => {
        if (path === '/api/devices/updates/previews')
          return Response.json(preview, { status: 201 });
        if (path === previewReadPath) return Response.json(preview);
        if (path.includes('/targets'))
          return Response.json({ targets, nextCursor: null });
        if (path.endsWith('/confirm')) {
          confirmations++;
          if (confirmations === 1)
            return Promise.reject(new TypeError('The connection closed.'));
          if (confirmations === 2)
            return Response.json(
              { reason: 'preview-changed' },
              { status: 409 },
            );
          return Response.json(receipt, { status: 201 });
        }
        if (path === '/api/jobs/UPD-006') return Response.json(job);
        return Response.json({}, { status: 404 });
      },
    });
  await reachConfirm(element, type, save, settle);
  await acknowledge();
  clickButton(element, 'Create update job');
  await settle();
  expect(element.textContent).toContain('The confirmation did not finish');
  expect(JSON.parse(sessionStorage.getItem(retainedKey) ?? '{}')).toEqual({
    previewId,
    manifestDigest: 'a'.repeat(64),
    submittedBy: principal,
  });

  // The transaction lives in this tab, so a closure keeps the record.
  element
    .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    ?.click();
  await close();
  await open();
  await save();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'The update job may exist',
  );
  expect(confirmations).toBe(2);
  expect(sessionStorage.getItem(retainedKey)).not.toBeNull();

  // The next replay answers the receipt and settles the record.
  element
    .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    ?.click();
  await close();
  await open();
  await save();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update job created',
  );
  expect(element.textContent).toContain('Job UPD-006 · Running');
  expect(confirmations).toBe(3);
  expect(sessionStorage.getItem(retainedKey)).toBeNull();
  // No replay prepared a replacement preview.
  expect(
    request.mock.calls.filter(
      ([path]) => path === '/api/devices/updates/previews',
    ),
  ).toHaveLength(1);
  expect(
    request.mock.calls
      .filter(([path]) => path.endsWith('/confirm'))
      .map(([path]) => path),
  ).toEqual([
    `/api/devices/updates/previews/${previewId}/confirm`,
    `/api/devices/updates/previews/${previewId}/confirm`,
    `/api/devices/updates/previews/${previewId}/confirm`,
  ]);
  expect(
    request.mock.calls
      .filter(([path]) => path.endsWith('/confirm'))
      .map(([, body]) => (body as { manifestDigest: string }).manifestDigest),
  ).toEqual(['a'.repeat(64), 'a'.repeat(64), 'a'.repeat(64)]);
});

it('clears a retained confirmation that a 410 expires and prepares the preview', async () => {
  const { element, request, type, save } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) return Response.json(preview);
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path.endsWith('/confirm'))
        return Response.json(
          {
            reason: 'preview-expired',
            expiresAt: '2026-10-19T12:15:00.000Z',
          },
          { status: 410 },
        );
      return Response.json({}, { status: 404 });
    },
  });
  retainConfirmation();
  await type('North lab');
  await save();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 6 device updates',
  );
  expect(
    request.mock.calls.filter(
      ([path]) => path === '/api/devices/updates/previews',
    ),
  ).toHaveLength(1);
  expect(sessionStorage.getItem(retainedKey)).toBeNull();
});

it('clears a retained confirmation when the replay answers connection-changed', async () => {
  const { element, request, type, save } = await setup({
    request: (path) =>
      path.endsWith('/confirm')
        ? Response.json({ reason: 'connection-changed' }, { status: 409 })
        : Response.json({}, { status: 404 }),
  });
  retainConfirmation();
  await type('North lab');
  await save();
  expect(element.textContent).toContain('The Google connection changed.');
  expect(element.textContent).toContain(
    'Reconnect Google Workspace before you create the job.',
  );
  expect(
    request.mock.calls.filter(
      ([path]) => path === '/api/devices/updates/previews',
    ),
  ).toHaveLength(0);
  expect(sessionStorage.getItem(retainedKey)).toBeNull();
});

it('shows the receipt of a clear job with the field-change count', async () => {
  const clearJob: JobDetail = {
    ...job,
    changes: [{ field: 'annotatedLocation', mode: 'clear' }],
  };
  const { element, type, save, acknowledge, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(
          {
            ...preview,
            changes: [{ field: 'annotatedLocation', mode: 'clear' }],
          },
          { status: 201 },
        );
      if (path === previewReadPath)
        return Response.json({
          ...preview,
          changes: [{ field: 'annotatedLocation', mode: 'clear' }],
        });
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path.endsWith('/confirm'))
        return Response.json(receipt, { status: 201 });
      if (path === '/api/jobs/UPD-006') return Response.json(clearJob);
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  await acknowledge();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Create update job')
      candidate.click();
  });
  await settle();
  expect(element.textContent).toContain(
    '6 devices · 6 field changes. Google changes have not completed.',
  );
});

it('shows a job read failure as not found', async () => {
  const { element, type, save, acknowledge, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) return Response.json(preview);
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path.endsWith('/confirm'))
        return Response.json(receipt, { status: 201 });
      if (path === '/api/jobs/UPD-006')
        return Response.json({ reason: 'not-found' }, { status: 404 });
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  await acknowledge();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Create update job')
      candidate.click();
  });
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Job not found',
  );
  expect(element.textContent).toContain('This job is unavailable');
});

const clickButton = (element: HTMLElement, name: string) => {
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.replace(/\s+/g, ' ').trim() === name)
      candidate.click();
  });
};

/** Save the draft and open the Confirm step. */
async function reachConfirm(
  element: HTMLElement,
  type: (value: string) => Promise<void>,
  save: () => Promise<void>,
  settle: () => Promise<void>,
) {
  await type('North lab');
  await save();
  clickButton(element, 'Continue to confirmation');
  await settle();
}

it('re-reads the frozen preview when it enters Confirm', async () => {
  const { element, request, type, save, settle } = await setup();
  await type('North lab');
  await save();
  const reads = () =>
    request.mock.calls.filter(([path]) => path === previewReadPath).length;
  expect(reads()).toBe(0);

  clickButton(element, 'Continue to confirmation');
  await settle();
  expect(reads()).toBe(1);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Confirm 6 device updates',
  );
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Confirm',
  );
});

it('shows a loading state when it enters Confirm', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { element, fixture, type, save, settle } = await setup({
    request: async (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) {
        entered();
        await gate;
        return Response.json(preview);
      }
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  clickButton(element, 'Continue to confirmation');
  await reached;
  fixture.detectChanges();
  expect(element.textContent).toContain('Loading the approved scope…');
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Confirm',
  );
  expect(
    [...element.querySelectorAll('button')].some(
      (candidate) => candidate.textContent?.trim() === 'Create update job',
    ),
  ).toBe(false);

  release();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Confirm 6 device updates',
  );
});

it('shows a loading state when Back to preview re-reads the frozen scope', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let previewReads = 0;
  const { element, fixture, type, save, settle } = await setup({
    request: async (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) {
        previewReads++;
        if (previewReads === 2) {
          entered();
          await gate;
        }
        return Response.json(preview);
      }
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  clickButton(element, 'Back to preview');
  await reached;
  fixture.detectChanges();
  expect(element.textContent).toContain('Loading the preview…');
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Review',
  );
  expect(element.textContent).not.toContain('Continue to confirmation');

  release();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 6 device updates',
  );
});

it('shows a 410 expired preview when it enters Confirm', async () => {
  const { element, type, save, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path === previewReadPath)
        return Response.json(
          {
            reason: 'preview-expired',
            expiresAt: '2026-10-19T12:15:00.000Z',
          },
          { status: 410 },
        );
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Preview expired',
  );
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Confirm',
  );
  expect(element.textContent).not.toContain('Create update job');
});

it('shows a 403 permission change when it enters Confirm', async () => {
  const { element, type, save, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path === previewReadPath)
        return Response.json({ reason: 'forbidden' }, { status: 403 });
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update device is unavailable',
  );
  expect(element.textContent).toContain(
    'Your access does not permit this update',
  );
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Confirm',
  );
});

it('shows the offline state when it enters Confirm and keeps the draft', async () => {
  const { element, draft, type, save, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path === previewReadPath)
        return Promise.reject(new TypeError('offline'));
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  expect(element.textContent).toContain('Cannot reach Campus Commander');
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Confirm',
  );
  expect(draft.valueOf('annotatedLocation')).toBe('North lab');
});

it('shows a failed frozen read inside Review after Back to preview', async () => {
  let targetReads = 0;
  const { element, type, save, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) return Response.json(preview);
      if (path.includes('/targets')) {
        targetReads++;
        if (targetReads > 2)
          return Response.json({ reason: 'forbidden' }, { status: 403 });
        return Response.json({ targets, nextCursor: null });
      }
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  clickButton(element, 'Back to preview');
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update device is unavailable',
  );
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Review',
  );
});

it('ignores a successful confirmation from an earlier opening', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => undefined;
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  const {
    element,
    input,
    draft,
    type,
    save,
    acknowledge,
    settle,
    close,
    open,
  } = await setup({
    request: async (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) return Response.json(preview);
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path.endsWith('/confirm')) {
        started();
        await gate;
        return Response.json(receipt, { status: 201 });
      }
      if (path === '/api/jobs/UPD-006') return Response.json(job);
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  await acknowledge();
  clickButton(element, 'Create update job');
  await sent;

  element
    .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    ?.click();
  await close();
  await open();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );
  expect(input()?.value).toBe('North lab');

  release();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );
  expect(element.textContent).not.toContain('Job UPD-006 · Running');
  expect(draft.valueOf('annotatedLocation')).toBe('North lab');
  expect(
    sessionStorage.getItem(
      `cc.device-update-confirmation.${principal}.${previewId}`,
    ),
  ).toBeNull();
});

it('keeps an uncertain confirmation out of a later opening', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => undefined;
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { element, draft, type, save, acknowledge, settle, close, open } =
    await setup({
      request: async (path) => {
        if (path === '/api/devices/updates/previews')
          return Response.json(preview, { status: 201 });
        if (path === previewReadPath) return Response.json(preview);
        if (path.includes('/targets'))
          return Response.json({ targets, nextCursor: null });
        if (path.endsWith('/confirm')) {
          started();
          await gate;
          throw new TypeError('offline');
        }
        return Response.json({}, { status: 404 });
      },
    });
  await reachConfirm(element, type, save, settle);
  await acknowledge();
  clickButton(element, 'Create update job');
  await sent;

  element
    .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    ?.click();
  await close();
  await open();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );

  release();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );
  expect(element.textContent).not.toContain('The confirmation did not finish');
  expect(draft.valueOf('annotatedLocation')).toBe('North lab');
  expect(
    sessionStorage.getItem(
      `cc.device-update-confirmation.${principal}.${previewId}`,
    ),
  ).not.toBeNull();
});
/** A Move preview: five eligible devices and one removed from the inventory. */
const movePreview: DeviceUpdatePreview = {
  ...preview,
  changes: [
    {
      field: 'orgUnitPath',
      mode: 'move',
      value: '/Chrome Devices/Cart Devices',
    },
  ],
  fieldChanges: 5,
  selected: 6,
  eligible: 5,
  unchanged: 0,
  excluded: 1,
};

const moveSource = '/Chrome Devices/Lowell Academy/One to One';

const moveTargets: DeviceUpdateTarget[] = [
  ...[1, 2, 3, 4, 5].map((index) => ({
    deviceId: `synthetic-device-${index}`,
    serialNumber: `C0A1-000${index}`,
    field: 'orgUnitPath' as const,
    observedValue: moveSource,
    baselineValue: moveSource,
    approvedValue: '/Chrome Devices/Cart Devices',
    duplicateSerialNumber: null,
    disposition: 'eligible' as const,
    exclusionReason: null,
  })),
  {
    deviceId: 'synthetic-device-6',
    serialNumber: 'C0A1-0006',
    field: 'orgUnitPath' as const,
    observedValue: null,
    baselineValue: null,
    approvedValue: null,
    duplicateSerialNumber: null,
    disposition: 'excluded' as const,
    exclusionReason: 'removed',
  },
];

/** The tree row of one unit. The row's own label names the unit, not its expand icon. */
function treeRow(input: HTMLElement | null | undefined, name: string) {
  return [
    ...(input?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []),
  ].find((row) => row.querySelector('.label')?.textContent?.trim() === name);
}

/** Answer every other read of the sheet, so a custom handler can own one route. */
function otherAnswers(path: string, preview_: DeviceUpdatePreview) {
  if (path === '/api/devices/updates/org-units')
    return Response.json(orgUnitTree);
  if (path === previewReadPath) return Response.json(preview_);
  if (path.includes('/targets'))
    return Response.json({ targets: moveTargets, nextCursor: null });
  return Response.json({}, { status: 404 });
}

it('opens the picker on Move and sets the read-only Destination', async () => {
  const { orgBlock, picker, pickerButton, chooseOrgMode, settle, draft } =
    await setup();
  await chooseOrgMode('Move to an organization unit');

  const dialog = picker()?.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog?.getAttribute('aria-modal')).toBe('true');
  expect(picker()?.textContent).toContain('Choose organization unit');
  expect(picker()?.textContent).toContain('Find an organization unit');
  // The current line counts the selected devices.
  expect(picker()?.querySelector('.current')?.textContent?.trim()).toBe(
    '6 devices',
  );
  // The tree starts at the top-level unit, so a nested unit is not shown yet.
  expect(treeRow(picker(), 'Root organizational unit')).toBeTruthy();
  expect(treeRow(picker(), 'Chrome Devices')).toBeTruthy();
  expect(treeRow(picker(), 'Cart Devices')).toBeUndefined();
  // Choose waits for a highlighted unit.
  expect(pickerButton('Choose')?.disabled).toBe(true);

  picker()
    ?.querySelector<HTMLElement>('[aria-label="Expand Chrome Devices"]')
    ?.click();
  await settle();
  expect(treeRow(picker(), 'Cart Devices')).toBeTruthy();
  treeRow(picker(), 'Cart Devices')?.click();
  await settle();
  expect(picker()?.querySelector('.selected-path')?.textContent?.trim()).toBe(
    'Selected: /Chrome Devices/Cart Devices',
  );
  expect(pickerButton('Choose')?.disabled).toBe(false);

  pickerButton('Choose')?.click();
  await settle();
  expect(picker()?.querySelector('[role="dialog"]')).toBeNull();
  const destination =
    orgBlock()?.querySelector<HTMLTextAreaElement>('textarea');
  expect(destination?.value).toBe('/Chrome Devices/Cart Devices');
  // The Destination is read-only; its button reopens the picker.
  expect(destination?.readOnly).toBe(true);
  expect(
    orgBlock()?.querySelector('[aria-label="Choose organization unit"]'),
  ).toBeTruthy();
  expect(draft.changes()).toEqual([
    {
      field: 'orgUnitPath',
      mode: 'move',
      value: '/Chrome Devices/Cart Devices',
    },
  ]);
  // The draft keeps the stable identity of the destination (TREE-01).
  expect(draft.orgUnitId()).toBe('ou-cart');
});

it('searches the tree by path and shows the match with its ancestors', async () => {
  const { picker, chooseOrgMode, typeSearch, settle } = await setup();
  await chooseOrgMode('Move to an organization unit');
  await typeSearch('cart');

  // One query names a nested category, and its ancestors show with it.
  expect(treeRow(picker(), 'Cart Devices')).toBeTruthy();
  expect(treeRow(picker(), 'Chrome Devices')).toBeTruthy();
  // A search shows every match, so no expansion control appears.
  expect(
    picker()?.querySelector('[aria-label="Expand Chrome Devices"]'),
  ).toBeNull();

  await typeSearch('no such unit');
  expect(picker()?.textContent).toContain('No organization units match.');

  await typeSearch('');
  expect(treeRow(picker(), 'Cart Devices')).toBeUndefined();
  expect(
    picker()?.querySelector('[aria-label="Expand Chrome Devices"]'),
  ).toBeTruthy();
  await settle();
});

it('returns the field to Leave unchanged when the first pick is cancelled', async () => {
  const { block, button, picker, pickerButton, chooseOrgMode, settle, draft } =
    await setup();
  await chooseOrgMode('Move to an organization unit');
  pickerButton('Cancel')?.click();
  await settle();

  expect(picker()?.querySelector('[role="dialog"]')).toBeNull();
  expect(draft.modeOf('orgUnitPath')).toBe('unchanged');
  expect(draft.changed()).toBe(false);
  expect(block('orgUnitPath')?.textContent).not.toContain('Destination');
  expect(button('Save and preview')?.disabled).toBe(true);
});

it('closes the picker with Escape and keeps the sheet open', async () => {
  const { element, picker, chooseOrgMode, settle, draft } = await setup();
  await chooseOrgMode('Move to an organization unit');
  picker()
    ?.querySelector('[role="dialog"]')
    ?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  await settle();

  expect(picker()?.querySelector('[role="dialog"]')).toBeNull();
  expect(draft.modeOf('orgUnitPath')).toBe('unchanged');
  expect(
    element.querySelector('.bulk-sheet')?.classList.contains('is-open'),
  ).toBe(true);
});

it('reopens the picker from the Destination button with the chosen path and its branch', async () => {
  const { block, picker, pickerButton, chooseOrgMode, settle, draft } =
    await setup();
  await chooseOrgMode('Move to an organization unit');
  picker()
    ?.querySelector<HTMLElement>('[aria-label="Expand Chrome Devices"]')
    ?.click();
  await settle();
  treeRow(picker(), 'Cart Devices')?.click();
  await settle();
  pickerButton('Choose')?.click();
  await settle();

  block('orgUnitPath')
    ?.querySelector<HTMLElement>('[aria-label="Choose organization unit"]')
    ?.click();
  await settle();
  // The chosen unit is highlighted, so Choose is ready again.
  expect(picker()?.querySelector('.selected-path')?.textContent?.trim()).toBe(
    'Selected: /Chrome Devices/Cart Devices',
  );
  expect(pickerButton('Choose')?.disabled).toBe(false);
  // The reopened tree shows the branch that holds the chosen destination.
  expect(treeRow(picker(), 'Cart Devices')).toBeTruthy();
  expect(treeRow(picker(), 'Cart Devices')?.getAttribute('aria-selected')).toBe(
    'true',
  );
  expect(
    treeRow(picker(), 'Chrome Devices')?.getAttribute('aria-expanded'),
  ).toBe('true');

  // Cancel keeps the earlier destination.
  pickerButton('Cancel')?.click();
  await settle();
  expect(draft.valueOf('orgUnitPath')).toBe('/Chrome Devices/Cart Devices');
  expect(draft.modeOf('orgUnitPath')).toBe('move');
});

it('sends a Move with its path and shows the source and destination rows', async () => {
  let posted: { changes?: unknown } = {};
  const { element, picker, pickerButton, chooseOrgMode, settle, save } =
    await setup({
      request: (path, body) => {
        if (path === '/api/devices/updates/previews') {
          posted = body as { changes?: unknown };
          return Response.json(movePreview, { status: 201 });
        }
        return otherAnswers(path, movePreview);
      },
    });
  await chooseOrgMode('Move to an organization unit');
  picker()
    ?.querySelector<HTMLElement>('[aria-label="Expand Chrome Devices"]')
    ?.click();
  await settle();
  treeRow(picker(), 'Cart Devices')?.click();
  await settle();
  pickerButton('Choose')?.click();
  await settle();
  expect(element.textContent).toContain(
    '6 devices · 1 changed field · Not submitted',
  );
  await save();

  expect(posted.changes).toEqual([
    {
      field: 'orgUnitPath',
      mode: 'move',
      value: '/Chrome Devices/Cart Devices',
    },
  ]);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 5 device updates',
  );
  expect(element.textContent).toContain(
    '6 devices · 5 field changes · 1 excluded',
  );
  const first = element.querySelectorAll('.targets tbody')[0]!;
  expect(first.querySelector('th[scope="row"]')?.textContent?.trim()).toBe(
    'Organization unit',
  );
  // The source OU and the destination OU, in the same row.
  expect(first.querySelector('td')?.textContent).toContain(moveSource);
  expect(first.textContent).toContain('/Chrome Devices/Cart Devices');
  // Each path breaks after a slash (design note 17).
  expect(first.querySelectorAll('wbr').length).toBeGreaterThan(1);

  clickButton(element, 'Continue to confirmation');
  await settle();
  const sentence = element.querySelector('.change-list li');
  expect(sentence?.textContent?.trim()).toBe(
    'Move 5 devices into /Chrome Devices/Cart Devices. Destination policies apply.',
  );
  expect(sentence?.querySelector('wbr')).toBeTruthy();
  expect(element.textContent).toContain(
    'Annotated location, annotated user, and notes remain unchanged.',
  );
});

it('disables the field and names the read scope without the scope', async () => {
  const treeRequests: string[] = [];
  const { block, picker, orgSelect, button, request, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/org-units') {
        treeRequests.push(path);
        return Response.json(deniedOrgUnitTree);
      }
      return otherAnswers(path, preview);
    },
  });
  const orgBlock = block('orgUnitPath');
  expect(orgBlock?.textContent).toContain(
    'Google denied organization unit reads. Add https://www.googleapis.com/auth/admin.directory.orgunit.readonly to the delegation client in the Google Admin Console.',
  );
  expect(orgBlock?.querySelector('.mat-form-field-disabled')).not.toBeNull();
  // The select opens no panel while the read is refused.
  orgSelect()?.click();
  await settle();
  expect(
    [...document.querySelectorAll('mat-option')].some(
      (option) => option.textContent?.trim() === 'Move to an organization unit',
    ),
  ).toBe(false);
  expect(picker()?.querySelector('[role="dialog"]')).toBeNull();
  expect(button('Save and preview')?.disabled).toBe(true);

  // Copy scope copies the scope that the note names.
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  clickButton(orgBlock!, 'Copy scope');
  await settle();
  expect(writeText).toHaveBeenCalledWith(
    'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
  );
  expect(orgBlock?.textContent).toContain(
    'Copied the Google organization unit scope.',
  );

  // Recheck reads the tree again.
  expect(treeRequests).toHaveLength(1);
  clickButton(orgBlock!, 'Recheck');
  await settle();
  expect(treeRequests).toHaveLength(2);
  expect(request).toHaveBeenCalledWith('/api/devices/updates/org-units');
});

it('shows the failure note and a Recheck action when the read is unavailable', async () => {
  const { block } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/org-units')
        return Response.json({
          ...orgUnitTree,
          state: 'unavailable',
          failure: 'network-failure',
          orgUnits: null,
        });
      return otherAnswers(path, preview);
    },
  });
  const orgBlock = block('orgUnitPath');
  expect(orgBlock?.textContent).toContain(
    'Google connection unavailable. Check outbound connectivity and DNS. Retry after the connection returns.',
  );
  expect(orgBlock?.querySelector('.mat-form-field-disabled')).not.toBeNull();
  expect(orgBlock?.textContent).toContain('Recheck');
  // An unavailable read offers no scope to copy.
  expect(orgBlock?.textContent).not.toContain('Copy scope');
});

it('keeps the Destination usable after the picker closes', async () => {
  const { block, picker, pickerButton, chooseOrgMode, settle } = await setup();
  await chooseOrgMode('Move to an organization unit');
  picker()
    ?.querySelector<HTMLElement>('[aria-label="Expand Chrome Devices"]')
    ?.click();
  await settle();
  treeRow(picker(), 'Cart Devices')?.click();
  await settle();
  pickerButton('Choose')?.click();
  await settle();

  const destination = block('orgUnitPath')?.querySelector('textarea');
  expect(destination?.getAttribute('readonly')).not.toBeNull();
  // The focus returns to the control that opened the picker.
  expect(document.activeElement?.tagName.toLowerCase()).toBe('mat-select');
});

/** Choose the destination through the first opening of the picker. */
async function pickDestination(ui: Awaited<ReturnType<typeof setup>>) {
  const { picker, pickerButton, chooseOrgMode, settle } = ui;
  await chooseOrgMode('Move to an organization unit');
  picker()
    ?.querySelector<HTMLElement>('[aria-label="Expand Chrome Devices"]')
    ?.click();
  await settle();
  treeRow(picker(), 'Cart Devices')?.click();
  await settle();
  pickerButton('Choose')?.click();
  await settle();
}

it('returns focus to the Destination button after every exit from a reopened picker', async () => {
  const ui = await setup();
  const { block, picker, pickerButton, settle, angularErrors } = ui;
  await pickDestination(ui);
  const destinationButton = () =>
    block('orgUnitPath')?.querySelector<HTMLButtonElement>(
      '[aria-label="Choose organization unit"]',
    ) ?? null;
  const reopen = async () => {
    destinationButton()?.click();
    await settle();
    expect(picker()?.querySelector('[role="dialog"]')).not.toBeNull();
  };
  const expectClosedAtDestination = async () => {
    await settle();
    // A failed focus query throws inside afterNextRender, so this proves the close path.
    expect(angularErrors).toEqual([]);
    expect(document.activeElement).toBe(destinationButton());
  };

  // Cancel keeps the earlier destination and returns focus to its button.
  await reopen();
  pickerButton('Cancel')?.click();
  await expectClosedAtDestination();

  // Choose sets the same destination and returns focus the same way.
  await reopen();
  pickerButton('Choose')?.click();
  await expectClosedAtDestination();

  // Escape closes the picker only.
  await reopen();
  picker()
    ?.querySelector('[role="dialog"]')
    ?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  await expectClosedAtDestination();

  // The scrim is the fourth exit that reaches the same close path.
  await reopen();
  picker()
    ?.querySelector('.picker-scrim')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await expectClosedAtDestination();
});

for (const state of ['denied', 'unavailable'] as const) {
  it(`keeps a retained Move out of a new preview when the next read answers ${state}`, async () => {
    let treeAnswer: unknown = orgUnitTree;
    const ui = await setup({
      request: (path) => {
        if (path === '/api/devices/updates/org-units')
          return Response.json(treeAnswer);
        return otherAnswers(path, preview);
      },
    });
    const { block, button, request, close, open, draft, angularErrors } = ui;
    await pickDestination(ui);
    expect(draft.modeOf('orgUnitPath')).toBe('move');

    await close();
    // A reload restores the Move from tab storage before the sheet opens again.
    draft.restore();
    expect(draft.modeOf('orgUnitPath')).toBe('move');
    expect(draft.valueOf('orgUnitPath')).toBe('/Chrome Devices/Cart Devices');
    treeAnswer =
      state === 'denied'
        ? deniedOrgUnitTree
        : {
            ...orgUnitTree,
            state: 'unavailable',
            failure: 'network-failure',
            orgUnits: null,
          };
    await open();

    const orgBlock = block('orgUnitPath');
    // The field keeps the destination, and the draft keeps it for recovery.
    expect(orgBlock?.querySelector('textarea')?.value).toBe(
      '/Chrome Devices/Cart Devices',
    );
    expect(draft.modeOf('orgUnitPath')).toBe('move');
    expect(draft.valueOf('orgUnitPath')).toBe('/Chrome Devices/Cart Devices');
    expect(orgBlock?.querySelector('.mat-form-field-disabled')).not.toBeNull();
    expect(orgBlock?.textContent).toContain(ORG_UNIT_MOVE_BLOCKED_NOTE);
    expect(orgBlock?.textContent).toContain('Discard move');
    // The disabled field cannot reopen the picker from its Destination button.
    expect(
      orgBlock?.querySelector<HTMLButtonElement>(
        '[aria-label="Choose organization unit"]',
      )?.disabled,
    ).toBe(true);
    // No preview leaves the page with the disabled Move.
    expect(button('Save and preview')?.disabled).toBe(true);
    expect(
      request.mock.calls.filter(
        ([path]) => path === '/api/devices/updates/previews',
      ),
    ).toHaveLength(0);
    expect(angularErrors).toEqual([]);
  });
}

it('prepares the retained Move again after Recheck grants the read', async () => {
  let treeAnswer: unknown = orgUnitTree;
  let posted: { changes?: unknown } = {};
  const ui = await setup({
    request: (path, body) => {
      if (path === '/api/devices/updates/org-units')
        return Response.json(treeAnswer);
      if (path === '/api/devices/updates/previews') {
        posted = body as { changes?: unknown };
        return Response.json(movePreview, { status: 201 });
      }
      return otherAnswers(path, movePreview);
    },
  });
  const { block, button, close, open, save, settle, draft } = ui;
  await pickDestination(ui);
  await close();
  treeAnswer = deniedOrgUnitTree;
  await open();
  expect(button('Save and preview')?.disabled).toBe(true);

  treeAnswer = orgUnitTree;
  clickButton(block('orgUnitPath')!, 'Recheck');
  await settle();
  expect(
    block('orgUnitPath')?.querySelector('.mat-form-field-disabled'),
  ).toBeNull();
  expect(button('Save and preview')?.disabled).toBe(false);
  expect(draft.modeOf('orgUnitPath')).toBe('move');
  await save();
  // The retained destination travels again, unchanged.
  expect(posted.changes).toEqual([
    {
      field: 'orgUnitPath',
      mode: 'move',
      value: '/Chrome Devices/Cart Devices',
    },
  ]);
});

it('keeps a text edit usable after Discard move removes the blocked Move', async () => {
  let treeAnswer: unknown = orgUnitTree;
  let posted: { changes?: unknown } = {};
  const ui = await setup({
    request: (path, body) => {
      if (path === '/api/devices/updates/org-units')
        return Response.json(treeAnswer);
      if (path === '/api/devices/updates/previews') {
        posted = body as { changes?: unknown };
        return Response.json({ ...preview, fieldChanges: 1 }, { status: 201 });
      }
      return otherAnswers(path, movePreview);
    },
  });
  const { block, button, close, open, save, settle, type, draft } = ui;
  await pickDestination(ui);
  await close();
  treeAnswer = deniedOrgUnitTree;
  await open();
  await type('North lab');
  expect(button('Save and preview')?.disabled).toBe(true);

  clickButton(block('orgUnitPath')!, 'Discard move');
  await settle();
  expect(draft.modeOf('orgUnitPath')).toBe('unchanged');
  expect(draft.valueOf('orgUnitPath')).toBe('');
  expect(block('orgUnitPath')?.textContent).not.toContain('Destination');
  expect(button('Save and preview')?.disabled).toBe(false);
  await save();
  // The text edit survives; the discarded Move travels nowhere.
  expect(posted.changes).toEqual([
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ]);
});

it('prepares a text edit when the organization unit stays unchanged without the read', async () => {
  let posted: { changes?: unknown } = {};
  const { button, request, save, type } = await setup({
    request: (path, body) => {
      if (path === '/api/devices/updates/org-units')
        return Response.json(deniedOrgUnitTree);
      if (path === '/api/devices/updates/previews') {
        posted = body as { changes?: unknown };
        return Response.json({ ...preview, fieldChanges: 1 }, { status: 201 });
      }
      return otherAnswers(path, preview);
    },
  });
  await type('North lab');
  expect(button('Save and preview')?.disabled).toBe(false);
  await save();
  expect(posted.changes).toEqual([
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ]);
  expect(
    request.mock.calls.filter(
      ([path]) => path === '/api/devices/updates/previews',
    ),
  ).toHaveLength(1);
});

it('does not prepare a new preview from a retained Move while the read is denied', async () => {
  let treeAnswer: unknown = orgUnitTree;
  let previewRead: 'ok' | 'expired' = 'ok';
  const ui = await setup({
    request: (path, body) => {
      if (path === '/api/devices/updates/org-units')
        return Response.json(treeAnswer);
      if (path === '/api/devices/updates/previews') {
        return Response.json(movePreview, { status: 201 });
      }
      if (path === previewReadPath && previewRead === 'expired')
        return Response.json(
          { reason: 'preview-expired', expiresAt: preview.expiresAt },
          { status: 410 },
        );
      return otherAnswers(path, movePreview);
    },
  });
  const { element, save, settle, tree, draft } = ui;
  await pickDestination(ui);
  await save();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 5 device updates',
  );
  const previewPosts = () =>
    ui.request.mock.calls.filter(
      ([path]) => path === '/api/devices/updates/previews',
    ).length;
  expect(previewPosts()).toBe(1);

  // The grant is lost while the sheet stays open, and the frozen preview expires.
  treeAnswer = deniedOrgUnitTree;
  await tree.load();
  previewRead = 'expired';
  clickButton(element, 'Continue to confirmation');
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Preview expired',
  );

  // The recovery action prepares no preview with the blocked Move.
  clickButton(element, 'Prepare new preview');
  await settle();
  expect(previewPosts()).toBe(1);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );
  expect(
    element.querySelector('.field-block[data-field="orgUnitPath"]')
      ?.textContent,
  ).toContain(ORG_UNIT_MOVE_BLOCKED_NOTE);
  expect(draft.modeOf('orgUnitPath')).toBe('move');
  expect(draft.valueOf('orgUnitPath')).toBe('/Chrome Devices/Cart Devices');
});

it('replays a retained confirmation after the blocked move returns to the draft', async () => {
  // A lost confirmation for an earlier preview keeps its record (F5).
  const earlierPreviewId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const earlierKey = `cc.device-update-confirmation.${principal}.${earlierPreviewId}`;
  let treeAnswer: unknown = orgUnitTree;
  let previewRead: 'ok' | 'expired' = 'ok';
  let confirmations = 0;
  let replayed: { path?: string; manifestDigest?: string } = {};
  const ui = await setup({
    request: (path, body) => {
      if (path === '/api/devices/updates/org-units')
        return Response.json(treeAnswer);
      if (path === '/api/devices/updates/previews')
        return Response.json(movePreview, { status: 201 });
      if (path === previewReadPath && previewRead === 'expired')
        return Response.json(
          { reason: 'preview-expired', expiresAt: preview.expiresAt },
          { status: 410 },
        );
      if (path.endsWith('/confirm')) {
        confirmations++;
        replayed = {
          path,
          manifestDigest: (body as { manifestDigest?: string }).manifestDigest,
        };
        return Response.json({ reason: 'permission-changed' }, { status: 409 });
      }
      return otherAnswers(path, movePreview);
    },
  });
  const { block, button, element, save, settle, tree } = ui;
  await pickDestination(ui);
  await save();
  sessionStorage.setItem(
    earlierKey,
    JSON.stringify({
      previewId: earlierPreviewId,
      manifestDigest: 'b'.repeat(64),
    }),
  );

  // The grant is lost, and the frozen preview expires under the problem card.
  treeAnswer = deniedOrgUnitTree;
  await tree.load();
  previewRead = 'expired';
  clickButton(element, 'Continue to confirmation');
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Preview expired',
  );

  // The blocked move returns to the draft and leaves the record for the replay.
  clickButton(element, 'Prepare new preview');
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );
  expect(confirmations).toBe(0);
  expect(sessionStorage.getItem(earlierKey)).not.toBeNull();

  // A granted read lets Save replay the retained confirmation before any preview.
  treeAnswer = orgUnitTree;
  clickButton(block('orgUnitPath')!, 'Recheck');
  await settle();
  expect(button('Save and preview')?.disabled).toBe(false);
  await save();
  expect(confirmations).toBe(1);
  expect(replayed.path).toBe(
    `/api/devices/updates/previews/${earlierPreviewId}/confirm`,
  );
  expect(replayed.manifestDigest).toBe('b'.repeat(64));
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'The update job may exist',
  );
  expect(sessionStorage.getItem(earlierKey)).not.toBeNull();
});

/**
 * The grid draft of a save. Each row names one device and one field, and the baseline is the
 * value that the person saw when the edit began.
 */
const gridRow = (deviceId: string, serialNumber: string): DeviceRow =>
  ({
    deviceId,
    serialNumber,
    assetTag: null,
    orgUnitPath: '/Chrome Devices',
    annotatedLocation: null,
    annotatedUser: null,
    notes: null,
  }) as unknown as DeviceRow;

/** An edit-list preview: the route keeps every request on its own target row. */
const editPreview = (
  overrides: Partial<DeviceUpdatePreview> = {},
): DeviceUpdatePreview => ({
  ...preview,
  changes: null,
  fieldChanges: 1,
  selected: 1,
  eligible: 1,
  unchanged: 0,
  excluded: 0,
  conflicts: 0,
  ...overrides,
});

/** One frozen target of an edit list. */
const editTarget = (
  deviceId: string,
  serialNumber: string,
  field: DeviceUpdateField,
  disposition: 'eligible' | 'conflict' | 'excluded',
  approvedValue: string | null,
  observedValue: string | null = null,
): DeviceUpdateTarget => ({
  deviceId,
  serialNumber,
  field,
  observedValue,
  baselineValue: observedValue,
  approvedValue,
  duplicateSerialNumber: null,
  disposition,
  exclusionReason: disposition === 'excluded' ? 'removed' : null,
});

/** The answers of the edit route, the frozen targets, the confirmation, and the job. */
function gridAnswers(answers: {
  preview?: DeviceUpdatePreview | (() => Response);
  targets?: DeviceUpdateTarget[];
  body?: (body: unknown) => void;
}): RequestHandler {
  return (path, body) => {
    if (path === '/api/devices/updates/edit-previews') {
      answers.body?.(body);
      const answer = answers.preview ?? editPreview();
      return typeof answer === 'function'
        ? answer()
        : Response.json(answer, { status: 201 });
    }
    if (path === `/api/devices/updates/previews/${previewId}`)
      return Response.json(
        typeof answers.preview === 'function' ? editPreview() : answers.preview,
      );
    if (path.includes('/targets'))
      return Response.json({
        targets: answers.targets ?? [],
        nextCursor: null,
      });
    if (path.endsWith('/confirm'))
      return Response.json(receipt, { status: 201 });
    if (path === '/api/jobs/UPD-006') return Response.json(job);
    return Response.json({}, { status: 404 });
  };
}

it('saves one pending grid change without a Review or Confirm screen', async () => {
  const sent: unknown[] = [];
  const ui = await setup({
    source: 'grid',
    stage: (grid) =>
      grid.stageText(gridRow('d1', 'C0A1-0001'), 'notes', 'Hinge repaired'),
    request: gridAnswers({
      preview: editPreview(),
      targets: [
        editTarget('d1', 'C0A1-0001', 'notes', 'eligible', 'Hinge repaired'),
      ],
      body: (body) => sent.push(body),
    }),
  });
  const { element, request, settle } = ui;
  expect(sent).toEqual([
    {
      edits: [
        {
          deviceId: 'd1',
          field: 'notes',
          mode: 'replace',
          value: 'Hinge repaired',
          baselineValue: null,
        },
      ],
    },
  ]);
  // The press of Save changes acknowledged the one change, so the receipt opens at once.
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update job created',
  );
  expect(element.textContent).toContain('Your job is saved');
  expect(element.textContent).toContain('Google changes have not completed');
  expect(element.querySelector('.stepper')).toBeNull();
  expect(ui.button('Continue to confirmation')).toBeUndefined();
  expect(
    request.mock.calls.some(([path]) =>
      String(path).includes(`/previews/${previewId}/confirm`),
    ),
  ).toBe(true);

  // The confirmed row settles into an accepted cell, and the draft no longer holds it.
  const grid = TestBed.inject(DeviceGridDraftStore);
  expect(grid.entries()).toEqual([]);
  expect(grid.acceptedFor('d1', 'notes')).toEqual({
    deviceId: 'd1',
    field: 'notes',
    mode: 'replace',
    value: 'Hinge repaired',
    displayId: 'UPD-006',
  });
  await settle();
});

it('blocks Continue while the edit list holds a conflict and marks both cells', async () => {
  const ui = await setup({
    source: 'grid',
    stage: (grid) => {
      grid.stageText(gridRow('d1', 'C0A1-0001'), 'notes', 'Hinge repaired');
      grid.stageText(
        gridRow('d2', 'C0A1-0002'),
        'annotatedLocation',
        'Library',
      );
      grid.stageText(gridRow('d3', 'C0A1-0003'), 'notes', 'Door fixed');
    },
    request: gridAnswers({
      preview: editPreview({
        fieldChanges: 1,
        selected: 3,
        eligible: 1,
        excluded: 1,
        conflicts: 1,
      }),
      targets: [
        editTarget(
          'd1',
          'C0A1-0001',
          'notes',
          'conflict',
          'Hinge repaired',
          'Door fixed',
        ),
        editTarget('d2', 'C0A1-0002', 'annotatedLocation', 'excluded', null),
        editTarget('d3', 'C0A1-0003', 'notes', 'eligible', 'Door fixed'),
      ],
    }),
  });
  const { element, button } = ui;
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 3 device updates',
  );
  expect(element.textContent).toContain('1 conflict');
  expect(element.textContent).toContain(
    'Resolve the marked cells in the grid, then save the changes again.',
  );
  expect(button('Continue to confirmation')?.disabled).toBe(true);

  const grid = TestBed.inject(DeviceGridDraftStore);
  expect(grid.entryFor('d1', 'notes')).toMatchObject({
    state: 'conflict',
    currentValue: 'Door fixed',
  });
  expect(grid.entryFor('d2', 'annotatedLocation')).toMatchObject({
    state: 'excluded',
    exclusionReason: 'removed',
  });
});

it('keeps the draft when the edge refuses the save above its request cap', async () => {
  const ui = await setup({
    source: 'grid',
    stage: (grid) =>
      grid.stageText(gridRow('d1', 'C0A1-0001'), 'notes', 'Hinge repaired'),
    // The edge answers a body above the cap with plain text, so no reason field arrives.
    request: gridAnswers({
      preview: () => new Response('Payload Too Large', { status: 413 }),
    }),
  });
  const { element } = ui;
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'The save is too large',
  );
  expect(element.textContent).toContain(
    'The save is above the request limit of 98,304 bytes.',
  );
  expect(element.textContent).toContain('Draft preserved · No job created');
  expect(TestBed.inject(DeviceGridDraftStore).entries()).toHaveLength(1);
});

it('names the Google failure when the edited devices cannot be read', async () => {
  const ui = await setup({
    source: 'grid',
    stage: (grid) =>
      grid.stageText(gridRow('d1', 'C0A1-0001'), 'notes', 'Hinge repaired'),
    request: gridAnswers({
      preview: () =>
        Response.json(
          { reason: 'device-read-failed', failure: 'quota' },
          { status: 503 },
        ),
    }),
  });
  const { element } = ui;
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'The devices could not be read from Google',
  );
  expect(element.textContent).toContain('Prepare a new preview to try again');
  expect(element.textContent).toContain('quota');
  expect(TestBed.inject(DeviceGridDraftStore).entries()).toHaveLength(1);
});

it('shows the pending devices when the grid review asks for them', async () => {
  const ui = await setup({
    source: 'grid',
    stage: (grid) => {
      grid.stageText(gridRow('d1', 'C0A1-0001'), 'notes', 'Hinge repaired');
      grid.stageText(gridRow('d2', 'C0A1-0002'), 'notes', 'Door fixed');
    },
    request: gridAnswers({
      preview: editPreview({ fieldChanges: 2, selected: 2, eligible: 2 }),
      targets: [
        editTarget('d1', 'C0A1-0001', 'notes', 'eligible', 'Hinge repaired'),
        editTarget('d2', 'C0A1-0002', 'notes', 'eligible', 'Door fixed'),
      ],
    }),
  });
  const { fixture, element, button, closed, settle } = ui;
  const pending = vi.fn();
  fixture.componentInstance.pendingViewRequested.subscribe(pending);
  // Two changes reach Review, where a grid save offers the marked cells instead of a
  // draft step that does not exist.
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 2 device updates',
  );
  expect(button('Edit draft')).toBeUndefined();
  button('Review pending devices')?.click();
  await settle();
  expect(pending).toHaveBeenCalledTimes(1);
  expect(closed).toHaveBeenCalledTimes(1);
});

it('recovers a grid confirmation from the selection sheet (B6)', async () => {
  const ui = await setup({
    source: 'selection',
    stage: (grid) => {
      grid.stageText(gridRow('d1', 'C0A1-0001'), 'notes', 'Hinge repaired');
      grid.stageText(gridRow('d2', 'C0A1-0002'), 'notes', 'Door fixed');
    },
    request: (path) => {
      if (path === '/api/devices/updates/org-units')
        return Response.json(orgUnitTree);
      if (path.endsWith('/confirm'))
        return Response.json(receipt, { status: 201 });
      if (path === '/api/jobs/UPD-006') return Response.json(job);
      return Response.json({}, { status: 404 });
    },
  });
  // A grid save retains its submission in this tab before the page closes.
  TestBed.inject(DeviceUpdateConfirmationStore).retain({
    previewId,
    manifestDigest: 'a'.repeat(64),
    entries: [
      {
        deviceId: 'd1',
        field: 'notes',
        mode: 'replace',
        value: 'Hinge repaired',
        baselineValue: null,
      },
      {
        deviceId: 'd2',
        field: 'notes',
        mode: 'replace',
        value: 'Door fixed',
        baselineValue: null,
      },
    ],
  });
  await ui.type('North lab');
  ui.button('Save and preview')?.click();
  await ui.settle();
  await ui.settle();

  // The selection sheet recovered the grid job, and the grid rows settled under it.
  expect(ui.element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update job created',
  );
  const grid = TestBed.inject(DeviceGridDraftStore);
  expect(grid.entries()).toEqual([]);
  expect(grid.accepted()).toHaveLength(2);
});

it('settles the confirmed rows when the sheet closes before its answer (B6)', async () => {
  let release: (value: Response) => void = () => undefined;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const ui = await setup({
    source: 'grid',
    stage: (grid) => {
      grid.stageText(gridRow('d1', 'C0A1-0001'), 'notes', 'Hinge repaired');
      grid.stageText(gridRow('d2', 'C0A1-0002'), 'notes', 'Door fixed');
    },
    request: (path) => {
      if (path === '/api/devices/updates/edit-previews')
        return Response.json(
          editPreview({ fieldChanges: 2, selected: 2, eligible: 2 }),
          { status: 201 },
        );
      if (path === `/api/devices/updates/previews/${previewId}`)
        return Response.json(
          editPreview({ fieldChanges: 2, selected: 2, eligible: 2 }),
        );
      if (path.includes('/targets'))
        return Response.json({
          targets: [
            editTarget(
              'd1',
              'C0A1-0001',
              'notes',
              'eligible',
              'Hinge repaired',
            ),
            editTarget('d2', 'C0A1-0002', 'notes', 'eligible', 'Door fixed'),
          ],
          nextCursor: null,
        });
      if (path.endsWith('/confirm')) return held;
      if (path === '/api/jobs/UPD-006') return Response.json(job);
      return Response.json({}, { status: 404 });
    },
  });
  const { element, button, close, settle } = ui;
  button('Continue to confirmation')?.click();
  await settle();
  element
    .querySelector<HTMLInputElement>('mat-checkbox input[type="checkbox"]')
    ?.click();
  await settle();
  button('Create update job')?.click();
  await settle();
  // The person dismisses the sheet while the answer is still on its way.
  await close();
  release(Response.json(receipt, { status: 201 }));
  await settle();
  await settle();

  // The job exists, so the submitted rows settle even though no receipt shows.
  const grid = TestBed.inject(DeviceGridDraftStore);
  expect(grid.entries()).toEqual([]);
  expect(grid.accepted()).toHaveLength(2);
  expect(grid.acceptedFor('d2', 'notes')?.value).toBe('Door fixed');
});

it('creates one job with a row per device and field after Review', async () => {
  const ui = await setup({
    source: 'grid',
    stage: (grid) => {
      grid.stageText(gridRow('d1', 'C0A1-0001'), 'notes', 'Hinge repaired');
      grid.stageText(
        gridRow('d1', 'C0A1-0001'),
        'annotatedUser',
        'maya@example.org',
      );
      grid.stageText(gridRow('d2', 'C0A1-0002'), 'notes', 'Door fixed');
    },
    request: gridAnswers({
      preview: editPreview({
        fieldChanges: 3,
        selected: 3,
        eligible: 3,
      }),
      targets: [
        editTarget(
          'd1',
          'C0A1-0001',
          'annotatedUser',
          'eligible',
          'maya@example.org',
        ),
        editTarget('d1', 'C0A1-0001', 'notes', 'eligible', 'Hinge repaired'),
        editTarget('d2', 'C0A1-0002', 'notes', 'eligible', 'Door fixed'),
      ],
    }),
  });
  const { element, button, settle } = ui;
  // The Review table lists one group per device and one row per field.
  expect(
    [...element.querySelectorAll('.device-row')].map((row) =>
      row.textContent?.trim(),
    ),
  ).toEqual(['C0A1-0001', 'C0A1-0002']);
  expect(button('Continue to confirmation')?.disabled).toBe(false);
  expect(button('Review pending devices')).toBeDefined();
  expect(button('Edit draft')).toBeUndefined();

  button('Continue to confirmation')?.click();
  await settle();
  // Confirm names one sentence per frozen row.
  const sentences = [...element.querySelectorAll('.change-list li')].map(
    (row) => row.textContent?.replace(/\s+/g, ' ').trim(),
  );
  expect(sentences).toEqual([
    'Set the annotated user to maya@example.org on C0A1-0001.',
    'Set the notes to Hinge repaired on C0A1-0001.',
    'Set the notes to Door fixed on C0A1-0002.',
  ]);
  expect(element.querySelector('h2')?.textContent?.trim()).toBe(
    'Update 2 fields on 3 devices',
  );

  const box = element.querySelector<HTMLInputElement>(
    'mat-checkbox input[type="checkbox"]',
  );
  box?.click();
  await settle();
  button('Create update job')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update job created',
  );
  const grid = TestBed.inject(DeviceGridDraftStore);
  expect(grid.entries()).toEqual([]);
  expect(grid.accepted()).toHaveLength(3);
  expect(grid.acceptedFor('d1', 'annotatedUser')?.value).toBe(
    'maya@example.org',
  );
});

it('settles the frozen edit list when a grid cell changes during Review (B8)', async () => {
  const ui = await setup({
    source: 'grid',
    stage: (grid) => {
      grid.stageText(gridRow('d1', 'C0A1-0001'), 'notes', 'FIRST-FROZEN-VALUE');
      grid.stageText(
        gridRow('d2', 'C0A1-0002'),
        'notes',
        'SECOND-FROZEN-VALUE',
      );
    },
    request: (path) => {
      if (path === '/api/devices/updates/edit-previews')
        return Response.json(
          editPreview({ fieldChanges: 2, selected: 2, eligible: 2 }),
          { status: 201 },
        );
      if (path === `/api/devices/updates/previews/${previewId}`)
        return Response.json(
          editPreview({ fieldChanges: 2, selected: 2, eligible: 2 }),
        );
      if (path.includes('/targets'))
        return Response.json({
          targets: [
            editTarget(
              'd1',
              'C0A1-0001',
              'notes',
              'eligible',
              'FIRST-FROZEN-VALUE',
            ),
            editTarget(
              'd2',
              'C0A1-0002',
              'notes',
              'eligible',
              'SECOND-FROZEN-VALUE',
            ),
          ],
          nextCursor: null,
        });
      if (path.endsWith('/confirm'))
        return Response.json(receipt, { status: 201 });
      if (path === '/api/jobs/UPD-006') return Response.json(job);
      return Response.json({}, { status: 404 });
    },
  });
  const { element, button, settle } = ui;
  const grid = TestBed.inject(DeviceGridDraftStore);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 2 device updates',
  );

  // The side sheet leaves the grid usable. This edit is later than the frozen preview.
  grid.stageText(gridRow('d1', 'C0A1-0001'), 'notes', 'LATER-KEEP-ME');
  expect(grid.counts()).toEqual({ changes: 2, devices: 2 });

  button('Continue to confirmation')?.click();
  await settle();
  element
    .querySelector<HTMLInputElement>('mat-checkbox input[type="checkbox"]')
    ?.click();
  await settle();
  button('Create update job')?.click();
  await settle();
  await settle();

  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update job created',
  );
  // The accepted cells describe the frozen requests that the job owns, not the later edits.
  expect(grid.acceptedFor('d1', 'notes')?.value).toBe('FIRST-FROZEN-VALUE');
  expect(grid.acceptedFor('d2', 'notes')?.value).toBe('SECOND-FROZEN-VALUE');
  // The later edit keeps its own draft, and the untouched frozen row left the draft.
  expect(grid.entryFor('d1', 'notes')).toMatchObject({
    value: 'LATER-KEEP-ME',
  });
  expect(grid.valueFor('d1', 'notes', 'HS-0001')).toBe('LATER-KEEP-ME');
  expect(grid.entryFor('d2', 'notes')).toBeNull();
  expect(grid.counts()).toEqual({ changes: 1, devices: 1 });
});

it('names the duplicate Asset tag on a one-change receipt (B3)', async () => {
  const target = {
    ...editTarget('d1', 'C0A1-0001', 'notes', 'eligible', 'Hinge repaired'),
    duplicateSerialNumber: 'OTHER-SERIAL-1',
  };
  const ui = await setup({
    source: 'grid',
    stage: (grid) =>
      grid.stageText(gridRow('d1', 'C0A1-0001'), 'notes', 'Hinge repaired'),
    request: gridAnswers({
      preview: editPreview(),
      targets: [target],
    }),
  });
  const { element } = ui;
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update job created',
  );
  expect(element.textContent).toContain(
    'C0A1-0001 · OTHER-SERIAL-1 already holds Hinge repaired. The asset tag repeats.',
  );
});

it('names the duplicate Asset tag at Review and on the receipt (B3)', async () => {
  const duplicate = {
    ...editTarget('d1', 'C0A1-0001', 'notes', 'eligible', 'Hinge repaired'),
    duplicateSerialNumber: 'OTHER-SERIAL-2',
  };
  const ui = await setup({
    source: 'grid',
    stage: (grid) => {
      grid.stageText(gridRow('d1', 'C0A1-0001'), 'notes', 'Hinge repaired');
      grid.stageText(gridRow('d2', 'C0A1-0002'), 'notes', 'Door fixed');
    },
    request: gridAnswers({
      preview: editPreview({ fieldChanges: 2, selected: 2, eligible: 2 }),
      targets: [
        duplicate,
        editTarget('d2', 'C0A1-0002', 'notes', 'eligible', 'Door fixed'),
      ],
    }),
  });
  const { element, button, settle } = ui;
  expect(element.textContent).toContain(
    'C0A1-0001 · OTHER-SERIAL-2 already holds Hinge repaired. The asset tag repeats.',
  );
  button('Continue to confirmation')?.click();
  await settle();
  element
    .querySelector<HTMLInputElement>('mat-checkbox input[type="checkbox"]')
    ?.click();
  await settle();
  button('Create update job')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update job created',
  );
  expect(element.textContent).toContain(
    'C0A1-0001 · OTHER-SERIAL-2 already holds Hinge repaired. The asset tag repeats.',
  );
});

it('retains and replays duplicate evidence across the supported 500-device bound (B3)', async () => {
  const ui = await setup({
    open: false,
    request: gridAnswers({ preview: editPreview() }),
  });
  const confirmations = TestBed.inject(DeviceUpdateConfirmationStore);
  const entries = Array.from({ length: 101 }, (_, index) => ({
    deviceId: `d${index}`,
    field: 'annotatedAssetId' as const,
    mode: 'replace' as const,
    value: 'SHARED-TAG',
    baselineValue: null,
  }));
  confirmations.retain({
    previewId,
    manifestDigest: 'a'.repeat(64),
    entries,
    duplicates: entries.map((entry, index) => ({
      serialNumber: `SERIAL-${index}`,
      duplicateSerialNumber: 'OTHER-SERIAL',
      approvedValue: entry.value,
    })),
  });
  const answer = await confirmations.prepareEdits(entries);
  expect(answer.kind).toBe('receipt');
  expect(
    ui.request.mock.calls.some(
      ([path]) => path === '/api/devices/updates/edit-previews',
    ),
  ).toBe(false);
});

it('keeps a 101-warning confirmation unresolved instead of preparing a second preview (B3)', async () => {
  const ui = await setup({
    open: false,
    request: (path) => {
      if (path.endsWith('/confirm'))
        return Promise.reject(new TypeError('The connection closed.'));
      return gridAnswers({ preview: editPreview() })(path, undefined);
    },
  });
  const confirmations = TestBed.inject(DeviceUpdateConfirmationStore);
  const entries = Array.from({ length: 101 }, (_, index) => ({
    deviceId: `d${index}`,
    field: 'annotatedAssetId' as const,
    mode: 'replace' as const,
    value: 'SHARED-TAG',
    baselineValue: null,
  }));
  confirmations.retain({
    previewId,
    manifestDigest: 'a'.repeat(64),
    entries,
    duplicates: entries.map((entry, index) => ({
      serialNumber: `SERIAL-${index}`,
      duplicateSerialNumber: 'OTHER-SERIAL',
      approvedValue: entry.value,
    })),
  });
  const answer = await confirmations.prepareEdits(entries);
  expect(answer.kind).toBe('uncertain');
  expect(
    ui.request.mock.calls.some(
      ([path]) => path === '/api/devices/updates/edit-previews',
    ),
  ).toBe(false);
});

it('a late accepted answer cannot install the previous principal values (B5)', async () => {
  let release: (value: Response) => void = () => undefined;
  let sent: () => void = () => undefined;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    sent = resolve;
  });
  const base = gridAnswers({ preview: editPreview() });
  const ui = await setup({
    source: 'grid',
    stage: (grid) =>
      grid.stageText(
        gridRow('d1', 'SERIAL-1'),
        'notes',
        'PERSON-A-PRIVATE-VALUE',
      ),
    request: (path, body) => {
      if (path.endsWith('/confirm')) {
        sent();
        return held;
      }
      return base(path, body);
    },
  });
  await started;
  ui.element
    .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    ?.click();
  ui.fixture.componentRef.setInput('open', false);
  const auth = TestBed.inject(AuthStore);
  (auth.session as unknown as ReturnType<typeof signal>).set({
    identity: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      grants: [],
    },
  });
  await ui.settle();
  const grid = TestBed.inject(DeviceGridDraftStore);
  expect(grid.accepted()).toEqual([]);
  expect(grid.entries()).toEqual([]);

  release(Response.json(receipt, { status: 201 }));
  await ui.settle();
  await ui.settle();
  expect(grid.valueFor('d1', 'notes', 'PERSON-B-GOOGLE-VALUE')).toBe(
    'PERSON-B-GOOGLE-VALUE',
  );
  expect(grid.accepted()).toEqual([]);
});
