import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  JobDetail,
  UserAttributeCategory,
  UserAttributeEdit,
  UserAttributeField,
  UserAttributePreview,
  UserAttributeTarget,
  UserDetail,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { UserAttributeEditFlow } from './user-attribute-edit-flow';
import {
  USER_ATTRIBUTE_CONFIRMATION_PREFIX,
  UserAttributeConfirmationStore,
} from './user-attribute-confirmation';
import {
  UserAttributeEditor,
  type UserAttributeSaveResult,
} from './user-attribute-editor';

function field(extra: Partial<UserAttributeField>): UserAttributeField {
  return {
    fieldId: 'Student.grade_level',
    fieldName: 'grade_level',
    displayName: 'Grade level',
    fieldType: 'INT64',
    multiValued: false,
    indexed: true,
    readAccessType: 'ALL_DOMAIN_USERS',
    numericIndexingSpec: null,
    holders: 1,
    ...extra,
  };
}

const categories: UserAttributeCategory[] = [
  {
    schemaId: 'schema-student',
    schemaName: 'Student',
    displayName: 'Student information',
    etag: '"student-etag"',
    fields: [
      field({}),
      field({
        fieldId: 'Student.homeroom',
        fieldName: 'homeroom',
        displayName: 'Homeroom',
        fieldType: 'STRING',
      }),
      field({
        fieldId: 'Student.programs',
        fieldName: 'programs',
        displayName: 'Programs',
        fieldType: 'STRING',
        multiValued: true,
      }),
    ],
    holders: 2,
    readAt: '2026-11-01T13:12:00.000Z',
  },
  {
    schemaId: 'schema-staff',
    schemaName: 'Staff',
    displayName: 'Staff information',
    etag: '"staff-etag"',
    fields: [
      field({
        fieldId: 'Staff.hire_date',
        fieldName: 'hire_date',
        displayName: 'Hire date',
        fieldType: 'DATE',
      }),
      field({
        fieldId: 'Staff.certifications',
        fieldName: 'certifications',
        displayName: 'Certifications',
        fieldType: 'STRING',
        multiValued: true,
      }),
    ],
    holders: 0,
    readAt: '2026-11-01T13:12:00.000Z',
  },
  {
    schemaId: 'schema-device',
    schemaName: 'Device',
    displayName: 'Device program',
    etag: '"device-etag"',
    fields: [
      field({
        fieldId: 'Device.take_home',
        fieldName: 'take_home',
        displayName: 'Take-home approved',
        fieldType: 'BOOL',
      }),
    ],
    holders: 1,
    readAt: '2026-11-01T13:12:00.000Z',
  },
];

const user: UserDetail = {
  userId: '110000000000000000001',
  primaryEmail: 'amara.okafor@example.org',
  orgUnitPath: '/Students/High School',
  givenName: 'Amara',
  familyName: 'Okafor',
  fullName: 'Amara Okafor',
  suspended: false,
  suspensionReason: null,
  archived: false,
  lastLoginTime: '2026-11-01T12:51:00.000Z',
  creationTime: '2023-08-14T12:00:00.000Z',
  twoStepEnrolled: true,
  department: null,
  title: null,
  aliases: [],
  customSchemas: {
    Student: {
      grade_level: '10',
      homeroom: '214',
      programs: [{ value: 'Gifted' }, { value: 'Band' }],
    },
    Device: { take_home: true },
  },
  lastEntitySync: '2026-11-01T13:12:00.000Z',
  stale: false,
  removedAt: null,
  recordVersion: 1,
};

const previewId = '2f1c6a0e-6d3b-4a1f-9f0e-3c4ce0b6a910';

/** One multi-value field of each info type (B section 12, R1-B). */
const multiCategories: UserAttributeCategory[] = [
  {
    schemaId: 'schema-multi',
    schemaName: 'Multi',
    displayName: 'Multi information',
    etag: '"multi-etag"',
    fields: [
      field({
        fieldId: 'Multi.numbers',
        fieldName: 'numbers',
        displayName: 'Numbers',
        fieldType: 'INT64',
        multiValued: true,
      }),
      field({
        fieldId: 'Multi.decimals',
        fieldName: 'decimals',
        displayName: 'Decimals',
        fieldType: 'DOUBLE',
        multiValued: true,
      }),
      field({
        fieldId: 'Multi.answers',
        fieldName: 'answers',
        displayName: 'Answers',
        fieldType: 'BOOL',
        multiValued: true,
      }),
      field({
        fieldId: 'Multi.dates',
        fieldName: 'dates',
        displayName: 'Dates',
        fieldType: 'DATE',
        multiValued: true,
      }),
      field({
        fieldId: 'Multi.emails',
        fieldName: 'emails',
        displayName: 'Emails',
        fieldType: 'EMAIL',
        multiValued: true,
      }),
      field({
        fieldId: 'Multi.phones',
        fieldName: 'phones',
        displayName: 'Phones',
        fieldType: 'PHONE',
        multiValued: true,
      }),
    ],
    holders: 1,
    readAt: '2026-11-01T13:12:00.000Z',
  },
];

const multiUser: UserDetail = {
  ...user,
  userId: '110000000000000000009',
  primaryEmail: 'multi@example.org',
  fullName: 'Multi Values',
  customSchemas: {
    Multi: {
      numbers: [{ value: 1 }, { value: 2 }],
      decimals: [{ value: 1.5 }, { value: 2.5 }],
      answers: [{ value: true }],
      dates: [{ value: '2026-11-01' }, { value: '2026-11-02' }],
      emails: [{ value: 'one@example.org' }],
      phones: [{ value: '+1 555 0100' }],
    },
  },
};

function preview(
  extra: Partial<UserAttributePreview> = {},
): UserAttributePreview {
  return {
    previewId,
    source: 'edit-list',
    changes: null,
    attributeChanges: 1,
    selected: 1,
    eligible: 1,
    unchanged: 0,
    conflicts: 0,
    oldestObservedAt: '2026-11-01T13:12:00.000Z',
    stale: false,
    preparedAt: '2026-11-01T13:12:00.000Z',
    expiresAt: '2026-11-01T13:22:00.000Z',
    manifestDigest: 'a'.repeat(64),
    ...extra,
  };
}

function target(extra: Partial<UserAttributeTarget> = {}): UserAttributeTarget {
  return {
    userId: user.userId,
    primaryEmail: user.primaryEmail,
    attribute: 'attr:Student.grade_level',
    currentValue: 10,
    newValue: 11,
    disposition: 'eligible',
    observedAt: '2026-11-01T13:12:00.000Z',
    ...extra,
  };
}

const job = {
  displayId: 'UAT-015',
  status: 'completed',
} as unknown as JobDetail;

const UNCERTAIN_TEXT =
  'Cannot reach Campus Commander. Your changes are still here.';
const UNCERTAIN_HINT = 'Retry the confirmation to keep the same preview.';

/** The answer of one accepted confirmation. */
function acceptedReceipt(changeCount: number) {
  return {
    ok: true as const,
    value: {
      jobId: '8f2b4b19-4c6a-47fd-8d0a-0f3ce4b0f2a1',
      displayId: 'UAT-015',
      status: 'accepted' as const,
      userCount: 1,
      changeCount,
    },
  };
}

/** The answer of one confirmation, for the held-answer lifetime tests (R3-A, R3-B). */
type TestConfirmAnswer =
  | ReturnType<typeof acceptedReceipt>
  | { ok: false; message: string; uncertain: boolean };

/** A promise that the test releases. */
function deferred<T>() {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function flow(extra: Record<string, unknown> = {}) {
  return {
    prepare: vi.fn().mockResolvedValue({ ok: true, value: preview() }),
    readTargets: vi.fn().mockResolvedValue({ ok: true, value: [target()] }),
    confirm: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        jobId: '8f2b4b19-4c6a-47fd-8d0a-0f3ce4b0f2a1',
        displayId: 'UAT-015',
        status: 'accepted',
        userCount: 1,
        changeCount: 1,
      },
    }),
    waitForJob: vi.fn().mockResolvedValue({ ok: true, value: job }),
    ...extra,
  };
}

/** Two changes, so the save shows the review rows before its confirmation. */
function reviewFlow(confirm: ReturnType<typeof vi.fn>) {
  return flow({
    prepare: vi.fn().mockResolvedValue({
      ok: true,
      value: preview({ attributeChanges: 2, selected: 2, eligible: 2 }),
    }),
    readTargets: vi.fn().mockResolvedValue({
      ok: true,
      value: [
        target(),
        target({
          attribute: 'attr:Student.homeroom',
          currentValue: '214',
          newValue: '216',
        }),
      ],
    }),
    confirm,
  });
}

/** Creates one editor on the configured TestBed. A root store persists across mounts. */
async function mount(
  subject: UserDetail = user,
  categoryList: UserAttributeCategory[] = categories,
) {
  const fixture = TestBed.createComponent(UserAttributeEditor);
  fixture.componentRef.setInput('user', subject);
  fixture.componentRef.setInput('categories', categoryList);
  const finished = signal<UserAttributeSaveResult | null>(null);
  let cancels = 0;
  fixture.componentInstance.finished.subscribe((result) =>
    finished.set(result),
  );
  fixture.componentInstance.cancelled.subscribe(() => {
    cancels += 1;
  });
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
  const input = (attribute: string) =>
    element.querySelector<HTMLInputElement>(
      `[data-attribute="${attribute}"] input`,
    );
  const type = (attribute: string, value: string) => {
    const target = input(attribute);
    if (!target) throw new Error(`No input for ${attribute}`);
    target.value = value;
    target.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  /** Adds one chip through the editor input, as a person pressing Enter or leaving it. */
  const addChip = (attribute: string, value: string) => {
    const target = input(attribute);
    if (!target) throw new Error(`No chip input for ${attribute}`);
    target.value = value;
    target.dispatchEvent(new Event('input'));
    target.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
  };
  return {
    fixture,
    element,
    button,
    input,
    type,
    addChip,
    finished,
    cancels: () => cancels,
  };
}

async function setup(
  options: {
    flow?: ReturnType<typeof flow>;
    user?: UserDetail;
    categories?: UserAttributeCategory[];
    /** The signed-in person, for a spec that seeds a retained confirmation. */
    session?: () => { identity: { id: string } } | null;
  } = {},
) {
  const mocked = options.flow ?? flow();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: UserAttributeEditFlow, useValue: mocked },
      ...(options.session
        ? [{ provide: AuthStore, useValue: { session: options.session } }]
        : []),
    ],
  });
  const mounted = await mount(
    options.user ?? user,
    options.categories ?? categories,
  );
  return { ...mounted, mocked };
}

describe('the Custom attributes card form', () => {
  it('shows an editor of each info type', async () => {
    const { element } = await setup();
    expect(element.querySelector('h3')?.textContent?.trim()).toBe(
      'Student information',
    );
    expect(
      element
        .querySelector('[data-attribute="attr:Student.grade_level"] input')
        ?.getAttribute('inputmode'),
    ).toBe('numeric');
    expect(
      element
        .querySelector('[data-attribute="attr:Staff.hire_date"] input')
        ?.getAttribute('type'),
    ).toBe('date');
    expect(
      element.querySelector(
        '[data-attribute="attr:Device.take_home"] mat-button-toggle-group',
      ),
    ).not.toBeNull();
    // The multi-value field starts from the values that the card showed.
    expect(
      [...element.querySelectorAll('mat-chip-row')].map((chip) =>
        chip.textContent?.replace('cancel', '').trim(),
      ),
    ).toEqual(['Gifted', 'Band']);
    expect(
      element
        .querySelector('[data-attribute="attr:Student.programs"] input')
        ?.getAttribute('aria-label'),
    ).toBe('Add a Programs value');
  });

  it('shows the count message of in-grid editing over 500 characters', async () => {
    const { element, type, button } = await setup();
    type('attr:Student.homeroom', 'x'.repeat(512));
    expect(element.textContent).toContain('512 of 500 characters');
    expect(button('Save changes')?.disabled).toBe(true);
  });

  it('confirms one change in one step', async () => {
    const { type, button, finished, mocked } = await setup();
    type('attr:Student.grade_level', '11');
    button('Save changes')?.click();
    await vi.waitFor(() => expect(finished()?.displayId).toBe('UAT-015'));
    expect(mocked.prepare).toHaveBeenCalledWith([
      {
        userId: user.userId,
        attribute: 'attr:Student.grade_level',
        mode: 'set',
        values: [11],
        baselineValue: 10,
      },
    ]);
    expect(mocked.confirm).toHaveBeenCalledWith(previewId, 'a'.repeat(64));
    expect(mocked.readTargets).not.toHaveBeenCalled();
    expect(finished()).toEqual({
      outcome: 'saved',
      userId: user.userId,
      displayId: 'UAT-015',
      attributeNames: ['Grade level'],
    });
  });

  it('shows the review rows for two changes, then Confirm starts the job', async () => {
    const two = flow({
      prepare: vi.fn().mockResolvedValue({
        ok: true,
        value: preview({
          attributeChanges: 2,
          selected: 2,
          eligible: 2,
        }),
      }),
      readTargets: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          target(),
          target({
            attribute: 'attr:Student.homeroom',
            currentValue: '214',
            newValue: '216',
          }),
          target({
            attribute: 'attr:Student.programs',
            currentValue: ['Gifted', 'Band'],
            newValue: ['Gifted', 'Band', 'ESL'],
            disposition: 'unchanged',
          }),
        ],
      }),
    });
    const { element, type, button, finished, mocked } = await setup({
      flow: two,
    });
    type('attr:Student.grade_level', '11');
    type('attr:Student.homeroom', '216');
    button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(element.textContent).toContain('Current value'),
    );
    expect(mocked.readTargets).toHaveBeenCalledWith(previewId);
    expect(mocked.confirm).not.toHaveBeenCalled();
    const rows = [...element.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) =>
        cell.textContent?.replace(/\s+/g, ' ').trim(),
      ),
    );
    expect(rows[0]).toEqual(['Grade level', '10', '11', 'Proposed']);
    expect(rows[1]).toEqual(['Homeroom', '214', '216', 'Proposed']);
    expect(rows[2]).toEqual([
      'Programs',
      'Gifted, Band',
      'Gifted, Band, ESL',
      'No change needed',
    ]);
    expect(button('Confirm')?.disabled).toBe(false);
    button('Confirm')?.click();
    await vi.waitFor(() =>
      expect(finished()?.attributeNames).toEqual(['Grade level', 'Homeroom']),
    );
    expect(mocked.confirm).toHaveBeenCalledTimes(1);
  });

  it('blocks the save on a Conflict row and names the attribute', async () => {
    const conflict = flow({
      prepare: vi.fn().mockResolvedValue({
        ok: true,
        value: preview({
          selected: 2,
          eligible: 1,
          conflicts: 1,
          attributeChanges: 2,
        }),
      }),
      readTargets: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          target(),
          target({
            attribute: 'attr:Student.homeroom',
            currentValue: '999',
            newValue: '216',
            disposition: 'conflict',
          }),
        ],
      }),
    });
    const { element, type, button } = await setup({ flow: conflict });
    type('attr:Student.grade_level', '11');
    type('attr:Student.homeroom', '216');
    button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(element.textContent).toContain('A value changed in Google'),
    );
    expect(element.textContent).toContain('Homeroom');
    expect(element.textContent).toContain('Conflict');
    expect(button('Confirm')?.disabled).toBe(true);
  });

  it('keeps the form and its edits when the preview exceeds the size limit', async () => {
    const tooLarge = flow({
      prepare: vi.fn().mockResolvedValue({
        ok: false,
        message: 'The request exceeds the size limit.',
      }),
    });
    const { element, type, button } = await setup({ flow: tooLarge });
    type('attr:Student.grade_level', '11');
    button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(element.textContent).toContain(
        'The request exceeds the size limit.',
      ),
    );
    expect(element.querySelector('form')).not.toBeNull();
    expect(
      element.querySelector<HTMLInputElement>(
        '[data-attribute="attr:Student.grade_level"] input',
      )?.value,
    ).toBe('11');
  });

  it('renders and saves the list of every multi-value type (R1-B)', async () => {
    const six = flow({
      prepare: vi.fn().mockResolvedValue({
        ok: true,
        value: preview({ attributeChanges: 6, eligible: 6 }),
      }),
    });
    const { element, addChip, button, mocked } = await setup({
      flow: six,
      user: multiUser,
      categories: multiCategories,
    });
    const chipText = (attribute: string) =>
      [
        ...element.querySelectorAll(
          `[data-attribute="${attribute}"] mat-chip-row`,
        ),
      ].map((chip) => chip.textContent?.replace('cancel', '').trim());
    expect(chipText('attr:Multi.numbers')).toEqual(['1', '2']);
    expect(chipText('attr:Multi.decimals')).toEqual(['1.5', '2.5']);
    // A multi-value Yes or No list renders in the words of its editor.
    expect(chipText('attr:Multi.answers')).toEqual(['Yes']);
    expect(chipText('attr:Multi.dates')).toEqual(['2026-11-01', '2026-11-02']);
    expect(chipText('attr:Multi.emails')).toEqual(['one@example.org']);
    expect(chipText('attr:Multi.phones')).toEqual(['+1 555 0100']);

    addChip('attr:Multi.numbers', '3');
    addChip('attr:Multi.decimals', '3.5');
    addChip('attr:Multi.answers', 'No');
    addChip('attr:Multi.dates', '2026-11-03');
    addChip('attr:Multi.emails', 'two@example.org');
    addChip('attr:Multi.phones', '+1 555 0101');
    button('Save changes')?.click();
    await vi.waitFor(() => expect(mocked.prepare).toHaveBeenCalled());
    const edits = new Map(
      (mocked.prepare.mock.calls[0]?.[0] as UserAttributeEdit[]).map((edit) => [
        edit.attribute,
        edit,
      ]),
    );
    expect(edits.size).toBe(6);
    expect(edits.get('attr:Multi.numbers')).toEqual({
      userId: multiUser.userId,
      attribute: 'attr:Multi.numbers',
      mode: 'replace',
      values: [1, 2, 3],
      baselineValue: [1, 2],
    });
    expect(edits.get('attr:Multi.decimals')?.values).toEqual([1.5, 2.5, 3.5]);
    expect(edits.get('attr:Multi.answers')?.values).toEqual([true, false]);
    expect(edits.get('attr:Multi.dates')?.values).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ]);
    expect(edits.get('attr:Multi.emails')?.values).toEqual([
      'one@example.org',
      'two@example.org',
    ]);
    expect(edits.get('attr:Multi.phones')?.values).toEqual([
      '+1 555 0100',
      '+1 555 0101',
    ]);
    for (const edit of edits.values()) expect(edit.mode).toBe('replace');
  });

  it('replays the same confirmation after an uncertain answer (R1-D)', async () => {
    let confirmCalls = 0;
    const uncertain = flow({
      confirm: vi.fn().mockImplementation(() => {
        confirmCalls++;
        return Promise.resolve(
          confirmCalls === 1
            ? {
                ok: false,
                message:
                  'Cannot reach Campus Commander. Your changes are still here.',
                uncertain: true,
              }
            : {
                ok: true,
                value: {
                  jobId: '8f2b4b19-4c6a-47fd-8d0a-0f3ce4b0f2a1',
                  displayId: 'UAT-015',
                  status: 'accepted',
                  userCount: 1,
                  changeCount: 1,
                },
              },
        );
      }),
    });
    const { element, type, button, finished, mocked } = await setup({
      flow: uncertain,
    });
    type('attr:Student.grade_level', '11');
    button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(element.textContent).toContain(
        'Retry the confirmation to keep the same preview.',
      ),
    );
    // The preview identity survives, and no second preview is prepared.
    expect(mocked.prepare).toHaveBeenCalledTimes(1);
    expect(element.textContent).toContain(
      'Cannot reach Campus Commander. Your changes are still here.',
    );
    button('Confirm')?.click();
    await vi.waitFor(() => expect(finished()?.displayId).toBe('UAT-015'));
    expect(mocked.confirm).toHaveBeenCalledTimes(2);
    expect(mocked.confirm.mock.calls[1]).toEqual(mocked.confirm.mock.calls[0]);
    expect(mocked.prepare).toHaveBeenCalledTimes(1);
  });

  it('replays the same review confirmation after an uncertain answer (R1-D)', async () => {
    let confirmCalls = 0;
    const reviewFlow = flow({
      prepare: vi.fn().mockResolvedValue({
        ok: true,
        value: preview({ attributeChanges: 2, selected: 2, eligible: 2 }),
      }),
      readTargets: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          target(),
          target({
            attribute: 'attr:Student.homeroom',
            currentValue: '214',
            newValue: '216',
          }),
        ],
      }),
      confirm: vi.fn().mockImplementation(() => {
        confirmCalls++;
        return Promise.resolve(
          confirmCalls === 1
            ? {
                ok: false,
                message:
                  'Cannot reach Campus Commander. Your changes are still here.',
                uncertain: true,
              }
            : {
                ok: true,
                value: {
                  jobId: '8f2b4b19-4c6a-47fd-8d0a-0f3ce4b0f2a1',
                  displayId: 'UAT-015',
                  status: 'accepted',
                  userCount: 1,
                  changeCount: 2,
                },
              },
        );
      }),
    });
    const { element, type, button, finished, mocked } = await setup({
      flow: reviewFlow,
    });
    type('attr:Student.grade_level', '11');
    type('attr:Student.homeroom', '216');
    button('Save changes')?.click();
    await vi.waitFor(() => expect(element.textContent).toContain('Review'));
    button('Confirm')?.click();
    await vi.waitFor(() =>
      expect(element.textContent).toContain(
        'Retry the confirmation to keep the same preview.',
      ),
    );
    expect(mocked.prepare).toHaveBeenCalledTimes(1);
    button('Confirm')?.click();
    await vi.waitFor(() => expect(finished()?.displayId).toBe('UAT-015'));
    expect(mocked.confirm).toHaveBeenCalledTimes(2);
    expect(mocked.confirm.mock.calls[1]).toEqual(mocked.confirm.mock.calls[0]);
    expect(mocked.prepare).toHaveBeenCalledTimes(1);
  });

  it('keeps an uncertain confirmation across Cancel and reopening (R2-B)', async () => {
    let confirmCalls = 0;
    const uncertain = flow({
      confirm: vi.fn(() => {
        confirmCalls++;
        return Promise.resolve(
          confirmCalls === 1
            ? { ok: false, message: UNCERTAIN_TEXT, uncertain: true }
            : acceptedReceipt(1),
        );
      }),
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeEditFlow, useValue: uncertain },
      ],
    });
    const first = await mount();
    first.type('attr:Student.grade_level', '11');
    first.button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(first.element.textContent).toContain(UNCERTAIN_HINT),
    );
    // The recovery continuation holds focus, and its render throws nothing (R2-D).
    await vi.waitFor(() => {
      first.fixture.detectChanges();
      expect(document.activeElement).toBe(first.button('Confirm'));
    });
    first.button('Cancel')?.click();
    expect(first.cancels()).toBe(1);
    first.fixture.destroy();

    const second = await mount();
    // The reopened form continues the one confirmation and prepares no second preview.
    expect(second.element.querySelector('.attribute-form')).toBeNull();
    expect(second.element.textContent).toContain(UNCERTAIN_HINT);
    expect(second.element.textContent).toContain(UNCERTAIN_TEXT);
    second.button('Confirm')?.click();
    await vi.waitFor(() =>
      expect(second.finished()?.displayId).toBe('UAT-015'),
    );
    expect(uncertain.prepare).toHaveBeenCalledTimes(1);
    expect(uncertain.confirm).toHaveBeenCalledTimes(2);
    expect(uncertain.confirm.mock.calls[1]).toEqual(
      uncertain.confirm.mock.calls[0],
    );
  });

  it('keeps a review confirmation across Cancel and reopening (R2-B)', async () => {
    let confirmCalls = 0;
    const uncertain = reviewFlow(
      vi.fn(() => {
        confirmCalls++;
        return Promise.resolve(
          confirmCalls === 1
            ? { ok: false, message: UNCERTAIN_TEXT, uncertain: true }
            : acceptedReceipt(2),
        );
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeEditFlow, useValue: uncertain },
      ],
    });
    const first = await mount();
    first.type('attr:Student.grade_level', '11');
    first.type('attr:Student.homeroom', '216');
    first.button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(first.element.textContent).toContain('Current value'),
    );
    first.button('Confirm')?.click();
    await vi.waitFor(() =>
      expect(first.element.textContent).toContain(UNCERTAIN_HINT),
    );
    first.button('Cancel')?.click();
    first.fixture.destroy();

    const second = await mount();
    expect(second.element.querySelector('.review')).toBeNull();
    expect(second.element.textContent).toContain(UNCERTAIN_HINT);
    second.button('Confirm')?.click();
    await vi.waitFor(() =>
      expect(second.finished()?.attributeNames).toEqual([
        'Grade level',
        'Homeroom',
      ]),
    );
    expect(uncertain.prepare).toHaveBeenCalledTimes(1);
    expect(uncertain.confirm).toHaveBeenCalledTimes(2);
    expect(uncertain.confirm.mock.calls[1]).toEqual(
      uncertain.confirm.mock.calls[0],
    );
  });

  it('keeps the confirmation identity through a later refusal (R2-B)', async () => {
    let confirmCalls = 0;
    const refused = flow({
      confirm: vi.fn(() => {
        confirmCalls++;
        return Promise.resolve(
          confirmCalls === 1
            ? { ok: false, message: UNCERTAIN_TEXT, uncertain: true }
            : confirmCalls === 2
              ? {
                  ok: false,
                  message:
                    'You do not have permission to set user attribute values.',
                  uncertain: false,
                }
              : acceptedReceipt(1),
        );
      }),
    });
    const { element, type, button, finished, mocked } = await setup({
      flow: refused,
    });
    type('attr:Student.grade_level', '11');
    button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(element.textContent).toContain(UNCERTAIN_HINT),
    );
    button('Confirm')?.click();
    await vi.waitFor(() =>
      expect(element.textContent).toContain(
        'You do not have permission to set user attribute values.',
      ),
    );
    // The 403 is not proof that the first attempt created no job. The form stays on the
    // one confirmation instead of opening a replacement save.
    expect(element.querySelector('.attribute-form')).toBeNull();
    expect(element.textContent).toContain(UNCERTAIN_HINT);
    button('Confirm')?.click();
    await vi.waitFor(() => expect(finished()?.displayId).toBe('UAT-015'));
    expect(mocked.prepare).toHaveBeenCalledTimes(1);
    expect(mocked.confirm).toHaveBeenCalledTimes(3);
    for (const call of mocked.confirm.mock.calls)
      expect(call).toEqual(mocked.confirm.mock.calls[0]);
  });

  it('keeps a review confirmation through a later refusal (R2-B)', async () => {
    let confirmCalls = 0;
    const refused = reviewFlow(
      vi.fn(() => {
        confirmCalls++;
        return Promise.resolve(
          confirmCalls === 1
            ? { ok: false, message: UNCERTAIN_TEXT, uncertain: true }
            : confirmCalls === 2
              ? {
                  ok: false,
                  message:
                    'You do not have permission to set user attribute values.',
                  uncertain: false,
                }
              : acceptedReceipt(2),
        );
      }),
    );
    const { element, type, button, finished, mocked } = await setup({
      flow: refused,
    });
    type('attr:Student.grade_level', '11');
    type('attr:Student.homeroom', '216');
    button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(element.textContent).toContain('Current value'),
    );
    button('Confirm')?.click();
    await vi.waitFor(() =>
      expect(element.textContent).toContain(UNCERTAIN_HINT),
    );
    button('Confirm')?.click();
    await vi.waitFor(() =>
      expect(element.textContent).toContain(
        'You do not have permission to set user attribute values.',
      ),
    );
    expect(element.querySelector('.attribute-form')).toBeNull();
    button('Confirm')?.click();
    await vi.waitFor(() =>
      expect(finished()?.attributeNames).toEqual(['Grade level', 'Homeroom']),
    );
    expect(mocked.prepare).toHaveBeenCalledTimes(1);
    expect(mocked.confirm).toHaveBeenCalledTimes(3);
    for (const call of mocked.confirm.mock.calls)
      expect(call).toEqual(mocked.confirm.mock.calls[0]);
  });

  it('reports a job that needs review as unknown (R1-F)', async () => {
    const needsReview = flow({
      waitForJob: vi.fn().mockResolvedValue({
        ok: true,
        value: { ...job, status: 'needs-review' } as unknown as JobDetail,
      }),
    });
    const { type, button, finished } = await setup({ flow: needsReview });
    type('attr:Student.grade_level', '11');
    button('Save changes')?.click();
    await vi.waitFor(() => expect(finished()?.outcome).toBe('unknown'));
    expect(finished()?.displayId).toBe('UAT-015');
  });

  it('keeps the edits of the card that opened the form (R1-A)', async () => {
    const otherUser: UserDetail = {
      ...user,
      userId: '110000000000000000002',
      primaryEmail: 'ania.reyes@example.org',
      fullName: 'Ania Reyes',
    };
    const { fixture, type, button, finished, mocked } = await setup();
    type('attr:Student.grade_level', '11');
    // The route hands a later record to the live input. The draft stays with its user.
    fixture.componentRef.setInput('user', otherUser);
    fixture.detectChanges();
    button('Save changes')?.click();
    await vi.waitFor(() => expect(finished()?.displayId).toBe('UAT-015'));
    expect(mocked.prepare).toHaveBeenCalledWith([
      {
        userId: user.userId,
        attribute: 'attr:Student.grade_level',
        mode: 'set',
        values: [11],
        baselineValue: 10,
      },
    ]);
    expect(finished()?.userId).toBe(user.userId);
  });

  it('cancels the form', async () => {
    const { button, cancels } = await setup();
    button('Cancel')?.click();
    expect(cancels()).toBe(1);
  });

  it('keeps a one-change confirmation that is in flight when the form reopens (R3-A)', async () => {
    const held = deferred<TestConfirmAnswer>();
    let confirmCalls = 0;
    const inFlight = flow({
      confirm: vi.fn(() => {
        confirmCalls++;
        return confirmCalls === 1
          ? held.promise
          : Promise.resolve(acceptedReceipt(1));
      }),
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeEditFlow, useValue: inFlight },
      ],
    });
    const first = await mount();
    first.type('attr:Student.grade_level', '11');
    first.button('Save changes')?.click();
    await vi.waitFor(() => expect(inFlight.confirm).toHaveBeenCalledTimes(1));
    // The person leaves the page before the first answer arrives.
    first.fixture.destroy();

    const second = await mount();
    // The reopened form honors the one confirmation and offers no editors (R3-A).
    expect(second.element.querySelector('.attribute-form')).toBeNull();
    expect(second.element.textContent).toContain('Creating the job…');
    expect(inFlight.prepare).toHaveBeenCalledTimes(1);

    // The held answer is lost. The reopened form becomes the recovery continuation.
    held.release({ ok: false, message: UNCERTAIN_TEXT, uncertain: true });
    await vi.waitFor(() => {
      second.fixture.detectChanges();
      expect(second.element.textContent).toContain(UNCERTAIN_HINT);
    });
    second.button('Confirm')?.click();
    await vi.waitFor(() =>
      expect(second.finished()?.displayId).toBe('UAT-015'),
    );
    expect(inFlight.prepare).toHaveBeenCalledTimes(1);
    expect(inFlight.confirm).toHaveBeenCalledTimes(2);
    expect(inFlight.confirm.mock.calls[1]).toEqual(
      inFlight.confirm.mock.calls[0],
    );
  });

  it('keeps a review confirmation that is in flight when the form reopens (R3-A)', async () => {
    const held = deferred<TestConfirmAnswer>();
    let confirmCalls = 0;
    const inFlight = reviewFlow(
      vi.fn(() => {
        confirmCalls++;
        return confirmCalls === 1
          ? held.promise
          : Promise.resolve(acceptedReceipt(2));
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeEditFlow, useValue: inFlight },
      ],
    });
    const first = await mount();
    first.type('attr:Student.grade_level', '11');
    first.type('attr:Student.homeroom', '216');
    first.button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(first.element.textContent).toContain('Current value'),
    );
    first.button('Confirm')?.click();
    await vi.waitFor(() => expect(inFlight.confirm).toHaveBeenCalledTimes(1));
    first.fixture.destroy();

    const second = await mount();
    expect(second.element.querySelector('.attribute-form')).toBeNull();
    expect(second.element.querySelector('.review')).toBeNull();
    expect(second.element.textContent).toContain('Creating the job…');
    expect(inFlight.prepare).toHaveBeenCalledTimes(1);

    held.release({ ok: false, message: UNCERTAIN_TEXT, uncertain: true });
    await vi.waitFor(() => {
      second.fixture.detectChanges();
      expect(second.element.textContent).toContain(UNCERTAIN_HINT);
    });
    second.button('Confirm')?.click();
    await vi.waitFor(() =>
      expect(second.finished()?.attributeNames).toEqual([
        'Grade level',
        'Homeroom',
      ]),
    );
    expect(inFlight.prepare).toHaveBeenCalledTimes(1);
    expect(inFlight.confirm).toHaveBeenCalledTimes(2);
    expect(inFlight.confirm.mock.calls[1]).toEqual(
      inFlight.confirm.mock.calls[0],
    );
  });

  it('replays a confirmation that the tab kept through a reload (K25)', async () => {
    sessionStorage.clear();
    const principal = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const session = signal({ identity: { id: principal } });
    const stored = preview();
    sessionStorage.setItem(
      `${USER_ATTRIBUTE_CONFIRMATION_PREFIX}${principal}.${user.userId}`,
      JSON.stringify({
        userId: user.userId,
        submittedBy: principal,
        preview: stored,
        attributeNames: ['Grade level'],
        edits: [
          {
            userId: user.userId,
            attribute: 'attr:Student.grade_level',
            mode: 'set',
            values: [11],
            baselineValue: 10,
          },
        ],
        message: '',
        phase: 'confirming',
        displayId: null,
      }),
    );
    const mocked = flow();
    const { element, finished } = await setup({ session, flow: mocked });
    // The reopened form replays the frozen preview before it prepares another one.
    await vi.waitFor(() =>
      expect(mocked.confirm).toHaveBeenCalledWith(
        stored.previewId,
        stored.manifestDigest,
      ),
    );
    expect(mocked.prepare).not.toHaveBeenCalled();
    expect(element.querySelector('.attribute-form')).toBeNull();
    await vi.waitFor(() => expect(finished()?.displayId).toBe('UAT-015'));
    sessionStorage.clear();
  });

  /** Mount one save whose answer the test releases after another person signs in. */
  async function heldSave(first: string, second: string) {
    sessionStorage.clear();
    let signedIn: { identity: { id: string } } | null = {
      identity: { id: first },
    };
    const session = () => signedIn;
    const held = deferred<TestConfirmAnswer>();
    const inFlight = flow({ confirm: vi.fn(() => held.promise) });
    const mounted = await setup({ session, flow: inFlight });
    mounted.type('attr:Student.grade_level', '11');
    mounted.button('Save changes')?.click();
    await vi.waitFor(() => expect(inFlight.confirm).toHaveBeenCalledTimes(1));
    // The form leaves the page before the answer arrives.
    mounted.fixture.destroy();
    signedIn = { identity: { id: second } };
    const store = TestBed.inject(UserAttributeConfirmationStore);
    // The store follows the person who signed in.
    store.restore();
    return { held, store };
  }

  it('never retains a late uncertain answer under the person who signed in next (K25)', async () => {
    const first = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const second = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const { held, store } = await heldSave(first, second);
    const uncertain = vi.spyOn(store, 'uncertain');
    held.release({ ok: false, message: UNCERTAIN_TEXT, uncertain: true });
    await vi.waitFor(() => expect(uncertain).toHaveBeenCalled());

    expect(store.pending(user.userId)).toBeNull();
    expect(
      sessionStorage.getItem(
        `${USER_ATTRIBUTE_CONFIRMATION_PREFIX}${second}.${user.userId}`,
      ),
    ).toBeNull();
    // A fresh store of the second person restores nothing.
    const fresh = TestBed.runInInjectionContext(
      () => new UserAttributeConfirmationStore(),
    );
    expect(fresh.pending(user.userId)).toBeNull();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('never retains a late accepted receipt under the person who signed in next (K25)', async () => {
    const first = 'abababab-abab-4bab-8bab-abababababab';
    const second = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const { held, store } = await heldSave(first, second);
    const accept = vi.spyOn(store, 'accept');
    held.release(acceptedReceipt(1));
    await vi.waitFor(() => expect(accept).toHaveBeenCalled());

    expect(store.pending(user.userId)).toBeNull();
    expect(
      sessionStorage.getItem(
        `${USER_ATTRIBUTE_CONFIRMATION_PREFIX}${second}.${user.userId}`,
      ),
    ).toBeNull();
    const fresh = TestBed.runInInjectionContext(
      () => new UserAttributeConfirmationStore(),
    );
    expect(fresh.pending(user.userId)).toBeNull();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('observes an accepted answer that lands on the reopened form (R3-B)', async () => {
    const held = deferred<TestConfirmAnswer>();
    const inFlight = flow({ confirm: vi.fn(() => held.promise) });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeEditFlow, useValue: inFlight },
      ],
    });
    const first = await mount();
    first.type('attr:Student.grade_level', '11');
    first.button('Save changes')?.click();
    await vi.waitFor(() => expect(inFlight.confirm).toHaveBeenCalledTimes(1));
    first.fixture.destroy();

    // The reopened form waits on the same confirmation while its answer is in flight.
    const second = await mount();
    expect(second.element.textContent).toContain('Creating the job…');
    held.release(acceptedReceipt(1));
    await vi.waitFor(() =>
      expect(second.finished()?.displayId).toBe('UAT-015'),
    );
    expect(second.element.querySelector('.attribute-form')).toBeNull();
    expect(inFlight.prepare).toHaveBeenCalledTimes(1);
    expect(inFlight.confirm).toHaveBeenCalledTimes(1);
    expect(inFlight.waitForJob).toHaveBeenCalledWith(
      'UAT-015',
      120,
      1000,
      expect.any(Function),
    );
  });

  it('recovers the first accepted receipt after its editor closed (R3-B)', async () => {
    const held = deferred<TestConfirmAnswer>();
    const inFlight = flow({ confirm: vi.fn(() => held.promise) });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeEditFlow, useValue: inFlight },
      ],
    });
    const first = await mount();
    first.type('attr:Student.grade_level', '11');
    first.button('Save changes')?.click();
    await vi.waitFor(() => expect(inFlight.confirm).toHaveBeenCalledTimes(1));
    first.fixture.destroy();

    // The accepted answer lands on the closed form. Its receipt must survive (R3-B).
    held.release(acceptedReceipt(1));
    await Promise.resolve();
    await Promise.resolve();

    const second = await mount();
    expect(second.element.querySelector('.attribute-form')).toBeNull();
    expect(second.element.textContent).toContain('Saving to Google…');
    await vi.waitFor(() =>
      expect(second.finished()?.displayId).toBe('UAT-015'),
    );
    expect(second.finished()?.attributeNames).toEqual(['Grade level']);
    expect(inFlight.prepare).toHaveBeenCalledTimes(1);
    expect(inFlight.confirm).toHaveBeenCalledTimes(1);
    expect(inFlight.waitForJob).toHaveBeenCalledWith(
      'UAT-015',
      120,
      1000,
      expect.any(Function),
    );
  });

  it('recovers a review receipt that its editor never observed (R3-B)', async () => {
    const held = deferred<TestConfirmAnswer>();
    const inFlight = reviewFlow(vi.fn(() => held.promise));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeEditFlow, useValue: inFlight },
      ],
    });
    const first = await mount();
    first.type('attr:Student.grade_level', '11');
    first.type('attr:Student.homeroom', '216');
    first.button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(first.element.textContent).toContain('Current value'),
    );
    first.button('Confirm')?.click();
    await vi.waitFor(() => expect(inFlight.confirm).toHaveBeenCalledTimes(1));
    first.fixture.destroy();

    held.release(acceptedReceipt(2));
    await Promise.resolve();
    await Promise.resolve();

    const second = await mount();
    expect(second.element.querySelector('.attribute-form')).toBeNull();
    await vi.waitFor(() =>
      expect(second.finished()?.displayId).toBe('UAT-015'),
    );
    expect(second.finished()?.attributeNames).toEqual([
      'Grade level',
      'Homeroom',
    ]);
    expect(inFlight.prepare).toHaveBeenCalledTimes(1);
    expect(inFlight.confirm).toHaveBeenCalledTimes(1);
  });

  it('recovers the receipt of a successful replay after its editor closed (R3-B)', async () => {
    const held = deferred<TestConfirmAnswer>();
    let confirmCalls = 0;
    const inFlight = flow({
      confirm: vi.fn(() => {
        confirmCalls++;
        return confirmCalls === 1
          ? Promise.resolve({
              ok: false,
              message: UNCERTAIN_TEXT,
              uncertain: true,
            })
          : held.promise;
      }),
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeEditFlow, useValue: inFlight },
      ],
    });
    const first = await mount();
    first.type('attr:Student.grade_level', '11');
    first.button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(first.element.textContent).toContain(UNCERTAIN_HINT),
    );
    first.button('Confirm')?.click();
    await vi.waitFor(() => expect(inFlight.confirm).toHaveBeenCalledTimes(2));
    first.fixture.destroy();

    held.release(acceptedReceipt(1));
    await Promise.resolve();
    await Promise.resolve();

    const second = await mount();
    expect(second.element.querySelector('.attribute-form')).toBeNull();
    await vi.waitFor(() =>
      expect(second.finished()?.displayId).toBe('UAT-015'),
    );
    expect(inFlight.prepare).toHaveBeenCalledTimes(1);
    expect(inFlight.confirm).toHaveBeenCalledTimes(2);
    expect(inFlight.confirm.mock.calls[1]).toEqual(
      inFlight.confirm.mock.calls[0],
    );
  });

  it('recovers a successful review replay after its editor closed (R3-B)', async () => {
    const held = deferred<TestConfirmAnswer>();
    let confirmCalls = 0;
    const inFlight = reviewFlow(
      vi.fn(() => {
        confirmCalls++;
        return confirmCalls === 1
          ? Promise.resolve({
              ok: false,
              message: UNCERTAIN_TEXT,
              uncertain: true,
            })
          : held.promise;
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeEditFlow, useValue: inFlight },
      ],
    });
    const first = await mount();
    first.type('attr:Student.grade_level', '11');
    first.type('attr:Student.homeroom', '216');
    first.button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(first.element.textContent).toContain('Current value'),
    );
    first.button('Confirm')?.click();
    await vi.waitFor(() =>
      expect(first.element.textContent).toContain(UNCERTAIN_HINT),
    );
    first.button('Confirm')?.click();
    await vi.waitFor(() => expect(inFlight.confirm).toHaveBeenCalledTimes(2));
    first.fixture.destroy();

    held.release(acceptedReceipt(2));
    await Promise.resolve();
    await Promise.resolve();

    const second = await mount();
    expect(second.element.querySelector('.attribute-form')).toBeNull();
    await vi.waitFor(() =>
      expect(second.finished()?.displayId).toBe('UAT-015'),
    );
    expect(second.finished()?.attributeNames).toEqual([
      'Grade level',
      'Homeroom',
    ]);
    expect(inFlight.prepare).toHaveBeenCalledTimes(1);
    expect(inFlight.confirm).toHaveBeenCalledTimes(2);
    expect(inFlight.confirm.mock.calls[1]).toEqual(
      inFlight.confirm.mock.calls[0],
    );
  });

  it('keeps the accepted receipt when the one-change save reaches the polling cap (R4-A)', async () => {
    const capped = flow({
      waitForJob: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          message: 'The job is still running.',
        })
        .mockResolvedValue({ ok: true, value: job }),
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeEditFlow, useValue: capped },
      ],
    });
    const confirmations = TestBed.inject(UserAttributeConfirmationStore);
    const first = await mount();
    first.type('attr:Student.grade_level', '11');
    first.button('Save changes')?.click();
    await vi.waitFor(() => expect(first.finished()?.outcome).toBe('unsettled'));
    // The 120-read cap transfers observation. It does not release the receipt.
    expect(confirmations.pending(user.userId)).toMatchObject({
      phase: 'accepted',
      displayId: 'UAT-015',
    });
    first.fixture.destroy();

    // The next form recovers the same receipt and prepares no second preview.
    const second = await mount();
    expect(second.element.querySelector('.attribute-form')).toBeNull();
    expect(second.element.textContent).toContain('Saving to Google…');
    await vi.waitFor(() => expect(second.finished()?.outcome).toBe('saved'));
    expect(second.finished()?.displayId).toBe('UAT-015');
    expect(capped.prepare).toHaveBeenCalledTimes(1);
    expect(capped.confirm).toHaveBeenCalledTimes(1);
    expect(capped.waitForJob).toHaveBeenCalledTimes(2);
    // Only the settled job releases the retained identity.
    expect(confirmations.pending(user.userId)).toBeNull();
  });

  it('keeps the accepted receipt of a review save when it reaches the polling cap (R4-A)', async () => {
    const capped = reviewFlow(vi.fn().mockResolvedValue(acceptedReceipt(2)));
    capped.waitForJob = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        message: 'The job is still running.',
      })
      .mockResolvedValue({ ok: true, value: job });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeEditFlow, useValue: capped },
      ],
    });
    const confirmations = TestBed.inject(UserAttributeConfirmationStore);
    const first = await mount();
    first.type('attr:Student.grade_level', '11');
    first.type('attr:Student.homeroom', '216');
    first.button('Save changes')?.click();
    await vi.waitFor(() =>
      expect(first.element.textContent).toContain('Current value'),
    );
    first.button('Confirm')?.click();
    await vi.waitFor(() => expect(first.finished()?.outcome).toBe('unsettled'));
    expect(confirmations.pending(user.userId)).toMatchObject({
      phase: 'accepted',
      displayId: 'UAT-015',
      attributeNames: ['Grade level', 'Homeroom'],
    });
    first.fixture.destroy();

    const second = await mount();
    await vi.waitFor(() => expect(second.finished()?.outcome).toBe('saved'));
    expect(second.finished()?.attributeNames).toEqual([
      'Grade level',
      'Homeroom',
    ]);
    expect(capped.prepare).toHaveBeenCalledTimes(1);
    expect(capped.confirm).toHaveBeenCalledTimes(1);
    expect(capped.waitForJob).toHaveBeenCalledTimes(2);
    expect(confirmations.pending(user.userId)).toBeNull();
  });

  it('keeps a recovered receipt through a second polling cap (R4-A)', async () => {
    const capped = flow({
      waitForJob: vi.fn().mockResolvedValue({
        ok: false,
        message: 'The job is still running.',
      }),
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeEditFlow, useValue: capped },
      ],
    });
    const confirmations = TestBed.inject(UserAttributeConfirmationStore);
    const first = await mount();
    first.type('attr:Student.grade_level', '11');
    first.button('Save changes')?.click();
    await vi.waitFor(() => expect(first.finished()?.outcome).toBe('unsettled'));
    first.fixture.destroy();

    // The resumed observer also reaches its cap. The same receipt stays recoverable.
    const second = await mount();
    await vi.waitFor(() =>
      expect(second.finished()?.outcome).toBe('unsettled'),
    );
    expect(confirmations.pending(user.userId)).toMatchObject({
      phase: 'accepted',
      displayId: 'UAT-015',
    });
    second.fixture.destroy();

    capped.waitForJob.mockResolvedValue({ ok: true, value: job });
    const third = await mount();
    await vi.waitFor(() => expect(third.finished()?.outcome).toBe('saved'));
    expect(capped.prepare).toHaveBeenCalledTimes(1);
    expect(capped.confirm).toHaveBeenCalledTimes(1);
    expect(capped.waitForJob).toHaveBeenCalledTimes(3);
    expect(confirmations.pending(user.userId)).toBeNull();
  });
});
