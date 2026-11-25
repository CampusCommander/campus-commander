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
import { UserAttributeEditFlow } from './user-attribute-edit-flow';
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

async function setup(
  options: {
    flow?: ReturnType<typeof flow>;
    user?: UserDetail;
    categories?: UserAttributeCategory[];
  } = {},
) {
  const subject = options.user ?? user;
  const categoryList = options.categories ?? categories;
  const mocked = options.flow ?? flow();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: UserAttributeEditFlow, useValue: mocked },
    ],
  });
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
    mocked,
  };
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
});
