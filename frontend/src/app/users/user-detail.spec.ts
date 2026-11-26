import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, vi } from 'vitest';
import type {
  UserAttributeCategories,
  UserAttributeField,
  UserDetail,
  UserRow,
  UserSyncState,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { UserDetailPage, readAge } from './user-detail';
import { UserAttributeEditFlow } from './user-attribute-edit-flow';
import { UserAttributeConfirmationStore } from './user-attribute-confirmation';
import { UsersStore } from './users.store';
import type { UserRead } from './users.store';

const user = (extra: Partial<UserDetail> = {}): UserDetail => ({
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
      student_id: '204518',
      grade_level: '10',
      graduation_year: '2029',
      homeroom: '214',
      programs: [{ value: 'Gifted' }, { value: 'Band' }],
    },
    Device: { take_home: true },
  },
  lastEntitySync: '2026-11-01T13:12:00.000Z',
  stale: false,
  removedAt: null,
  recordVersion: 1,
  ...extra,
});

const sync: UserSyncState = {
  customerId: 'C0123456',
  generation: 1,
  status: 'ready',
  observedAt: '2026-11-01T13:12:00.000Z',
  userCount: 2418,
  failure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
};

const categories: UserAttributeCategories = {
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
      readAt: '2026-11-01T13:12:00.000Z',
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
          holders: 0,
        },
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
      readAt: '2026-11-01T13:12:00.000Z',
    },
  ],
  limits: {
    categories: 3,
    categoryLimit: 100,
    attributes: 4,
    attributeLimit: 100,
  },
  observedAt: '2026-11-01T13:12:00.000Z',
};

const nextRow: UserRow = {
  ...user(),
  userId: '110000000000000000002',
  primaryEmail: 'ania.reyes@example.org',
  fullName: 'Ania Reyes',
  stale: false,
};

/** The one writable field that the card form tests save. */
const gradeLevelField: UserAttributeField = {
  fieldId: 'Student.grade_level',
  fieldName: 'grade_level',
  displayName: 'Grade level',
  fieldType: 'INT64',
  multiValued: false,
  indexed: true,
  readAccessType: 'ALL_DOMAIN_USERS',
  numericIndexingSpec: null,
  holders: 1,
};
const writableCategories: UserAttributeCategories = {
  ...categories,
  categories: categories.categories.map((category) =>
    category.schemaName === 'Student'
      ? { ...category, fields: [...category.fields, gradeLevelField] }
      : category,
  ),
};

/** One edit-list preview of the card tests. */
const cardPreview = {
  previewId: '2f1c6a0e-6d3b-4a1f-9f0e-3c4ce0b6a910',
  source: 'edit-list' as const,
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
};

/** The receipt of one accepted card save. */
const cardReceipt = {
  ok: true as const,
  value: {
    jobId: '8f2b4b19-4c6a-47fd-8d0a-0f3ce4b0f2a1',
    displayId: 'UAT-015',
    status: 'accepted' as const,
    userCount: 1,
    changeCount: 1,
  },
};

/** A promise that the test releases. */
function held<T>() {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Creates the details page on the configured TestBed, as a navigation would (R4-A). */
async function mountPage(userId: string) {
  const fixture = TestBed.createComponent(UserDetailPage);
  fixture.componentRef.setInput('userId', userId);
  const element: HTMLElement = fixture.nativeElement;
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(element.textContent).not.toContain('Loading user details');
  });
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
  const fact = (label: string) =>
    [...element.querySelectorAll('.facts-list > div')]
      .find((row) => row.querySelector('dt')?.textContent?.trim() === label)
      ?.querySelector('dd')
      ?.textContent?.replace(/\s+/g, ' ')
      .trim();
  return { element, button, fact, fixture };
}

async function setup(options: {
  detail?: UserDetail | null;
  /** The answer of the read, when the test needs a failure or a stale answer. */
  read?: UserRead;
  position?: { index: number; userId: string; scrollTop: number | null } | null;
  cursor?: { index: number; userId: string } | null;
  matching?: number;
  offline?: boolean;
  sync?: UserSyncState | null;
  syncLoaded?: boolean;
  statusError?: string;
  statusRetryable?: boolean;
  categories?: UserAttributeCategories | null;
  categoriesError?: string;
  categoriesRecovery?: boolean;
  next?: UserRow | null;
  /** Holds the neighbor answer, so a test can end the page first. */
  neighbor?: () => Promise<UserRow | null>;
  /** The `users:write` answer of the mocked AuthStore. */
  canWrite?: boolean;
  /** The mocked preview flow of the card form. */
  flow?: Record<string, unknown>;
}) {
  const detail = options.detail === undefined ? user() : options.detail;
  const position =
    options.position === undefined
      ? {
          index: 0,
          userId: '110000000000000000001',
          scrollTop: 0,
        }
      : options.position;
  const cursor =
    options.cursor === undefined
      ? position && { index: position.index, userId: position.userId }
      : options.cursor;
  const read =
    options.read ??
    (detail === null
      ? { kind: 'missing' as const }
      : { kind: 'user' as const, user: detail });
  const store = {
    sync: signal(options.sync === undefined ? sync : options.sync),
    syncLoaded: signal(options.syncLoaded ?? true),
    statusError: signal(options.statusError ?? ''),
    statusRetryable: signal(options.statusRetryable ?? true),
    position: signal<{
      index: number;
      userId: string;
      scrollTop: number | null;
    } | null>(position),
    cursor: signal<{ index: number; userId: string } | null>(cursor),
    page: signal(
      options.matching === undefined
        ? null
        : { matching: options.matching, total: 2418, observedAt: null },
    ),
    categories: signal(
      options.categories === undefined ? categories : options.categories,
    ),
    categoriesError: signal(options.categoriesError ?? ''),
    categoriesRecovery: signal(options.categoriesRecovery ?? false),
    offline: signal(options.offline ?? false),
    user: vi.fn().mockResolvedValue(read),
    neighbor: vi.fn(
      options.neighbor ?? (() => Promise.resolve(options.next ?? null)),
    ),
    loadSync: vi.fn().mockResolvedValue(true),
    loadCategories: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: UsersStore, useValue: store },
      ...(options.flow
        ? [{ provide: UserAttributeEditFlow, useValue: options.flow }]
        : []),
      {
        provide: AuthStore,
        useValue: {
          session: signal({
            identity: { id: 'synthetic-user-detail', grants: [] },
            expiresAt: '2026-11-20T12:00:00.000Z',
            csrfToken: 'a'.repeat(64),
          }),
          metadata: signal({ phase: 3 }),
          can: vi.fn().mockReturnValue(options.canWrite ?? false),
          request: vi.fn(async () => Response.json({}, { status: 404 })),
        },
      },
    ],
  });
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const mounted = await mountPage(detail?.userId ?? 'missing-user');
  return { store, navigate, ...mounted };
}

describe('the user details page', () => {
  // A retained confirmation lives in the tab. One test never reads another test's record.
  beforeEach(() => sessionStorage.clear());

  it('shows the Account facts of the approved screen', async () => {
    const { element, fact } = await setup({});
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'Amara Okafor',
    );
    expect(element.querySelector('.subtitle')?.textContent?.trim()).toBe(
      'User details · /Students/High School',
    );
    expect(fact('Primary email')).toBe('amara.okafor@example.org');
    expect(fact('Status')).toBe('Active');
    expect(fact('2-step verification')).toBe('Enrolled');
    // The page shows the sign-in moment without a year, as the approved screen does.
    expect(fact('Last sign-in')).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/,
    );
    expect(fact('Created')).toBe('Aug 14, 2023');
  });

  it('starts focus at the heading of the page that replaced the skeleton (UI-09)', async () => {
    const { element } = await setup({});
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(element.querySelector('h1')),
    );
  });

  it('shows the Organization facts and Not set for an empty value', async () => {
    const { fact } = await setup({});
    expect(fact('Organization unit')).toBe('/Students/High School');
    expect(fact('Department')).toBe('Not set');
    expect(fact('Title')).toBe('Not set');
  });

  it('shows each category of the Custom attributes card', async () => {
    const { element } = await setup({});
    expect(
      [...element.querySelectorAll('.attr-section h3')].map((heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(['Student information', 'Staff information', 'Device program']);
    const boxes = [...element.querySelectorAll('.annotation')].map((box) => [
      box.querySelector('dt')?.textContent?.trim(),
      box.querySelector('dd')?.textContent?.replace(/\s+/g, ' ').trim(),
    ]);
    expect(boxes).toEqual([
      ['Student ID', '204518'],
      ['Programs', 'GiftedBand'],
      ['Take-home approved', 'Yes'],
    ]);
    // A multi-valued attribute shows static chips (UM notes composition 1).
    expect(
      [...element.querySelectorAll('.annotation')]
        .find(
          (box) => box.querySelector('dt')?.textContent?.trim() === 'Programs',
        )
        ?.querySelectorAll('.value-chips li').length,
    ).toBe(2);
  });

  it('shows No values set for a category without a value', async () => {
    const { element } = await setup({});
    const staff = [...element.querySelectorAll('.attr-section')].find(
      (section) =>
        section.querySelector('h3')?.textContent?.trim() ===
        'Staff information',
    );
    expect(staff?.querySelector('.empty')?.textContent?.trim()).toBe(
      'No values set',
    );
    expect(staff?.querySelectorAll('.annotation').length).toBe(0);
  });

  it('shows a removed user with its removal time (A section 11)', async () => {
    const { element } = await setup({
      detail: user({ removedAt: '2026-11-01T13:12:00.000Z' }),
    });
    // A removed user keeps its record, names the moment, and shows the read age.
    expect(element.textContent).toContain('Google no longer returns this user');
    expect(element.textContent).toMatch(/since .+\d{1,2}:\d{2}\s[AP]M/);
    expect(element.textContent).toContain('Read from Google');
  });

  it('reads the next user of the filtered order', async () => {
    const { store, navigate, button } = await setup({
      position: { index: 0, userId: '110000000000000000001', scrollTop: 0 },
      matching: 3,
      next: nextRow,
    });
    button('Next user')!.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(store.neighbor).toHaveBeenCalledWith(1);
    // Next user moves the cursor. The return anchor stays on the opening row (R3).
    expect(store.cursor()).toEqual({
      index: 1,
      userId: '110000000000000000002',
    });
    expect(store.position()).toEqual({
      index: 0,
      userId: '110000000000000000001',
      scrollTop: 0,
    });
    expect(navigate).toHaveBeenCalledWith(['/users', '110000000000000000002']);
  });

  it('drops a neighbor answer that lands after the page ended (R2)', async () => {
    const neighbor = held<UserRow | null>();
    const { navigate, button, fixture } = await setup({
      matching: 3,
      neighbor: () => neighbor.promise,
    });
    button('Next user')!.click();
    // Back to users, browser Back, or a shell link ends the page while the query runs.
    fixture.destroy();
    neighbor.release(nextRow);
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('drops the answer of an earlier Next user request (R2)', async () => {
    const first = held<UserRow | null>();
    const second = held<UserRow | null>();
    let calls = 0;
    const { navigate, button } = await setup({
      matching: 3,
      neighbor: () => {
        calls++;
        return calls === 1 ? first.promise : second.promise;
      },
    });
    button('Next user')!.click();
    button('Next user')!.click();
    first.release(nextRow);
    await Promise.resolve();
    // The first request belongs to a navigation that a later request replaced.
    expect(navigate).not.toHaveBeenCalled();
    second.release({
      ...nextRow,
      userId: '110000000000000000003',
      fullName: 'Ania Reyes',
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith(['/users', '110000000000000000003']);
  });

  it('disables Next user on the last row of the order', async () => {
    const { button } = await setup({
      position: { index: 2, userId: '110000000000000000001', scrollTop: 0 },
      matching: 3,
    });
    expect(button('Next user')!.disabled).toBe(true);
  });

  it('disables Next user after a direct link', async () => {
    const { button } = await setup({ position: null, matching: 3 });
    expect(button('Next user')!.disabled).toBe(true);
  });

  it('offers Back to users beside Next user', async () => {
    const { element } = await setup({});
    const link = element.querySelector<HTMLAnchorElement>('a[href="/users"]');
    expect(link?.textContent?.trim()).toBe('Back to users');
  });

  it('shows User not found when the directory holds no such user', async () => {
    const { element } = await setup({ detail: null });
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'User not found',
    );
    expect(element.querySelector('a[href="/users"]')).not.toBeNull();
  });

  it('shows the offline card with the cached record kept out of reach', async () => {
    const { element } = await setup({
      detail: null,
      read: { kind: 'offline' },
    });
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'Cannot reach Campus Commander',
    );
  });

  it('names a failed details read with a Retry that reads again (R5)', async () => {
    const { element, store, fixture } = await setup({
      detail: null,
      read: { kind: 'failed' },
    });
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'User details are unavailable',
    );
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Campus Commander could not read this user from the directory.',
    );
    // The failed read is not shown as a missing user and holds no busy state.
    expect(element.textContent).not.toContain('User not found');
    expect(element.querySelector('.detail')?.getAttribute('aria-busy')).toBe(
      'false',
    );
    const retry = [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Retry',
    );
    retry?.click();
    await vi.waitFor(() => expect(store.user).toHaveBeenCalledTimes(2));
    fixture.detectChanges();
  });

  it('names denied access without a Retry that cannot help (R5)', async () => {
    const { element } = await setup({
      detail: null,
      read: { kind: 'denied' },
    });
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'You cannot read this user',
    );
    expect(element.textContent).toContain(
      'You do not have permission to read users for this customer.',
    );
    expect(
      [...element.querySelectorAll('button')].some(
        (candidate) => candidate.textContent?.trim() === 'Retry',
      ),
    ).toBe(false);
  });

  it('keeps a missing user for a missing-record answer alone (R5)', async () => {
    const { element } = await setup({ read: { kind: 'missing' } });
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'User not found',
    );
  });

  it('names the Google scope and the raw keys without the category read', async () => {
    const { element } = await setup({
      categories: null,
      categoriesError:
        'Custom attribute columns are unavailable. Add https://www.googleapis.com/auth/admin.directory.userschema.readonly to the delegation client in the Google Admin Console.',
      categoriesRecovery: true,
    });
    expect(element.textContent).toContain(
      'admin.directory.userschema.readonly',
    );
    expect(
      [...element.querySelectorAll('.attr-section h3')].map((heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(['Student', 'Device']);
    expect(
      element.querySelector('a[href="/google-connection"]'),
    ).not.toBeNull();
  });

  it('asks for the Google connection when the customer holds none', async () => {
    const { element } = await setup({ sync: null });
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'Connect Google Workspace',
    );
    expect(
      element.querySelector('a[href="/google-connection"]'),
    ).not.toBeNull();
  });

  it('shows the status failure with a Retry', async () => {
    const { element, store } = await setup({
      statusError: 'User directory status is unavailable.',
    });
    expect(element.textContent).toContain('User directory status');
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'User directory status is unavailable.',
    );
    [...element.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Retry')
      ?.click();
    await vi.waitFor(() => expect(store.loadSync).toHaveBeenCalled());
  });

  it('shows no Edit button without users:write', async () => {
    const { button } = await setup({});
    expect(button('Edit')).toBeUndefined();
  });

  it('returns focus to the Edit button when the form closes (UI-09)', async () => {
    const { fixture, button } = await setup({ canWrite: true });
    button('Edit')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('.attribute-form'),
    ).not.toBeNull();
    button('Cancel')?.click();
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement?.textContent?.trim()).toBe('Edit');
    });
  });

  it('shows the saved line with the job link after one change (composition 13)', async () => {
    const oneChange = {
      prepare: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          previewId: '2f1c6a0e-6d3b-4a1f-9f0e-3c4ce0b6a910',
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
        },
      }),
      readTargets: vi.fn(),
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
      waitForJob: vi.fn().mockResolvedValue({
        ok: true,
        value: { displayId: 'UAT-015', status: 'completed' },
      }),
    };
    const { fixture, element, button, store } = await setup({
      canWrite: true,
      categories: writableCategories,
      flow: oneChange,
    });
    button('Edit')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const input = element.querySelector<HTMLInputElement>(
      '[data-attribute="attr:Student.grade_level"] input',
    );
    if (!input) throw new Error('No grade level field');
    input.value = '11';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button('Save changes')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Grade level saved to Google');
    });
    expect(element.textContent).toContain('Job');
    expect(
      element.querySelector('a[href="/jobs/UAT-015"]')?.textContent?.trim(),
    ).toBe('UAT-015');
    expect(oneChange.confirm).toHaveBeenCalledTimes(1);
    // The card reads the user again after the job settles.
    expect(store.user).toHaveBeenCalledTimes(2);
  });

  it('closes the open form when the route moves to the next user (R1-A)', async () => {
    const { fixture, element, store, button } = await setup({ canWrite: true });
    button('Edit')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const building = element.querySelector<HTMLInputElement>(
      '[data-attribute="attr:Staff.building"] input',
    );
    if (!building) throw new Error('No Building field');
    building.value = 'Room 230';
    building.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    // The next record belongs to Ania. Her card must not inherit the open draft.
    const next = user({
      userId: '110000000000000000002',
      primaryEmail: 'ania.reyes@example.org',
      givenName: 'Ania',
      familyName: 'Reyes',
      fullName: 'Ania Reyes',
      customSchemas: { Student: {}, Device: {} },
    });
    store.user.mockResolvedValue({ kind: 'user', user: next });
    fixture.componentRef.setInput('userId', next.userId);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Ania Reyes');
    });
    expect(element.querySelector('.attribute-form')).toBeNull();
    expect(
      element.querySelector<HTMLInputElement>(
        '[data-attribute="attr:Staff.building"] input',
      ),
    ).toBeNull();
    expect(button('Edit')).toBeDefined();
  });

  it('keeps a pending save with its own user across Next user (R1-A)', async () => {
    const pending = held<{
      ok: true;
      value: {
        jobId: string;
        displayId: string;
        status: string;
        userCount: number;
        changeCount: number;
      };
    }>();
    const card = {
      prepare: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          previewId: '2f1c6a0e-6d3b-4a1f-9f0e-3c4ce0b6a910',
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
        },
      }),
      readTargets: vi.fn(),
      confirm: vi.fn(() => pending.promise),
      waitForJob: vi.fn().mockResolvedValue({
        ok: true,
        value: { displayId: 'UAT-015', status: 'completed' },
      }),
    };
    const { fixture, element, store, button } = await setup({
      canWrite: true,
      flow: card,
    });
    button('Edit')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const studentId = element.querySelector<HTMLInputElement>(
      '[data-attribute="attr:Student.student_id"] input',
    );
    if (!studentId) throw new Error('No Student ID field');
    studentId.value = '204519';
    studentId.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button('Save changes')?.click();
    await vi.waitFor(() => expect(card.confirm).toHaveBeenCalled());
    const next = user({
      userId: '110000000000000000002',
      primaryEmail: 'ania.reyes@example.org',
      fullName: 'Ania Reyes',
      customSchemas: { Student: {}, Device: {} },
    });
    store.user.mockResolvedValue({ kind: 'user', user: next });
    fixture.componentRef.setInput('userId', next.userId);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Ania Reyes');
    });
    // The answer of the first save lands after the route moved. It changes nothing here.
    pending.release({
      ok: true,
      value: {
        jobId: '8f2b4b19-4c6a-47fd-8d0a-0f3ce4b0f2a1',
        displayId: 'UAT-015',
        status: 'accepted',
        userCount: 1,
        changeCount: 1,
      },
    });
    await vi.waitFor(() => expect(card.waitForJob).not.toHaveBeenCalled());
    expect(element.textContent).not.toContain('saved to Google');
    expect(element.querySelector('.attribute-form')).toBeNull();
    expect(store.user).toHaveBeenCalledTimes(2);
  });

  it('keeps a saved result off the next user card (R1-A)', async () => {
    const card = {
      prepare: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          previewId: '2f1c6a0e-6d3b-4a1f-9f0e-3c4ce0b6a910',
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
        },
      }),
      readTargets: vi.fn(),
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
      waitForJob: vi.fn().mockResolvedValue({
        ok: true,
        value: { displayId: 'UAT-015', status: 'completed' },
      }),
    };
    const { fixture, element, store, button } = await setup({
      canWrite: true,
      flow: card,
    });
    button('Edit')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const studentId = element.querySelector<HTMLInputElement>(
      '[data-attribute="attr:Student.student_id"] input',
    );
    if (!studentId) throw new Error('No Student ID field');
    studentId.value = '204519';
    studentId.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button('Save changes')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Student ID saved to Google');
    });
    const next = user({
      userId: '110000000000000000002',
      primaryEmail: 'ania.reyes@example.org',
      fullName: 'Ania Reyes',
      customSchemas: { Student: {}, Device: {} },
    });
    store.user.mockResolvedValue({ kind: 'user', user: next });
    fixture.componentRef.setInput('userId', next.userId);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Ania Reyes');
    });
    expect(element.querySelector('.saved-line')).toBeNull();
    expect(element.textContent).not.toContain('saved to Google');
  });

  it('keeps the heading and the save target aligned during a held next-user read (R2-A)', async () => {
    const heldRead = held<UserRead>();
    const card = {
      prepare: vi.fn().mockResolvedValue({ ok: true, value: cardPreview }),
      readTargets: vi.fn(),
      confirm: vi.fn().mockResolvedValue(cardReceipt),
      waitForJob: vi.fn().mockResolvedValue({
        ok: true,
        value: { displayId: 'UAT-015', status: 'completed' },
      }),
    };
    const { store, fixture, element, button } = await setup({
      canWrite: true,
      flow: card,
    });
    // The route moves to Ania while her record read stays open. Amara stays on screen.
    store.user.mockImplementation(() => heldRead.promise);
    const next = user({
      userId: '110000000000000000002',
      primaryEmail: 'ania.reyes@example.org',
      givenName: 'Ania',
      familyName: 'Reyes',
      fullName: 'Ania Reyes',
      customSchemas: { Student: {}, Device: {} },
    });
    fixture.componentRef.setInput('userId', next.userId);
    fixture.detectChanges();
    await vi.waitFor(() => expect(store.user).toHaveBeenCalledTimes(2));
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'Amara Okafor',
    );
    // The retained card offers no form, because its record is not the route's user.
    expect(button('Edit')).toBeUndefined();
    expect(element.querySelector('.attribute-form')).toBeNull();

    heldRead.release({ kind: 'user', user: next });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Ania Reyes');
    });
    button('Edit')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const studentId = element.querySelector<HTMLInputElement>(
      '[data-attribute="attr:Student.student_id"] input',
    );
    if (!studentId) throw new Error('No Student ID field');
    studentId.value = '204519';
    studentId.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button('Save changes')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Student ID saved to Google');
    });
    // The visible identity and the outgoing user ID agree.
    expect(element.querySelector('h1')?.textContent?.trim()).toBe('Ania Reyes');
    expect(card.prepare).toHaveBeenCalledWith([
      {
        userId: next.userId,
        attribute: 'attr:Student.student_id',
        mode: 'set',
        values: ['204519'],
        baselineValue: null,
      },
    ]);
  });

  it('refreshes the card when an accepted job settles after the polling cap (R2-C)', async () => {
    const card = {
      prepare: vi.fn().mockResolvedValue({ ok: true, value: cardPreview }),
      readTargets: vi.fn(),
      confirm: vi.fn().mockResolvedValue(cardReceipt),
      // The editor reached its 120-read budget without a terminal answer.
      waitForJob: vi.fn().mockResolvedValue({
        ok: false,
        message: 'The job is still running.',
      }),
      readJob: vi.fn().mockResolvedValue({
        ok: true,
        value: { displayId: 'UAT-015', status: 'completed' },
      }),
    };
    const { store, fixture, element, button } = await setup({
      canWrite: true,
      categories: writableCategories,
      flow: card,
    });
    // The settlement read answers the value that the job wrote.
    store.user.mockResolvedValue({
      kind: 'user',
      user: user({
        customSchemas: {
          Student: {
            student_id: '204518',
            grade_level: '11',
            graduation_year: '2029',
            homeroom: '214',
            programs: [{ value: 'Gifted' }, { value: 'Band' }],
          },
          Device: { take_home: true },
        },
      }),
    });
    button('Edit')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const grade = element.querySelector<HTMLInputElement>(
      '[data-attribute="attr:Student.grade_level"] input',
    );
    if (!grade) throw new Error('No Grade level field');
    grade.value = '11';
    grade.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button('Save changes')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Grade level saved to Google');
    });
    // The continuation observed the same receipt after the cap and refreshed the card.
    expect(card.waitForJob).toHaveBeenCalledWith(
      'UAT-015',
      120,
      1000,
      expect.any(Function),
    );
    expect(card.readJob).toHaveBeenCalledWith('UAT-015');
    expect(store.user).toHaveBeenCalledTimes(2);
    const annotation = [...element.querySelectorAll('.annotation')].find(
      (box) => box.querySelector('dt')?.textContent?.trim() === 'Grade level',
    );
    expect(annotation?.querySelector('dd')?.textContent?.trim()).toBe('11');
  });

  it('releases the accepted receipt only after its job settles after the cap (R4-A)', async () => {
    const settlement = held<{
      ok: true;
      value: { displayId: string; status: string };
    }>();
    const card = {
      prepare: vi.fn().mockResolvedValue({ ok: true, value: cardPreview }),
      readTargets: vi.fn(),
      confirm: vi.fn().mockResolvedValue(cardReceipt),
      // The editor reached its 120-read budget without a terminal answer.
      waitForJob: vi.fn().mockResolvedValue({
        ok: false,
        message: 'The job is still running.',
      }),
      // The card's own continuation reads the receipt until the job answers.
      readJob: vi.fn(() => settlement.promise),
    };
    const { store, fixture, element, button } = await setup({
      canWrite: true,
      categories: writableCategories,
      flow: card,
    });
    store.user.mockResolvedValue({
      kind: 'user',
      user: user({
        customSchemas: {
          Student: {
            student_id: '204518',
            grade_level: '11',
            graduation_year: '2029',
            homeroom: '214',
            programs: [{ value: 'Gifted' }, { value: 'Band' }],
          },
          Device: { take_home: true },
        },
      }),
    });
    button('Edit')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const grade = element.querySelector<HTMLInputElement>(
      '[data-attribute="attr:Student.grade_level"] input',
    );
    if (!grade) throw new Error('No Grade level field');
    grade.value = '11';
    grade.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button('Save changes')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('The job is still running.');
    });
    // The cap handed observation over, and the receipt stays under recovery.
    const confirmations = TestBed.inject(UserAttributeConfirmationStore);
    expect(confirmations.pending(user().userId)).toMatchObject({
      phase: 'accepted',
      displayId: 'UAT-015',
    });
    expect(card.readJob).toHaveBeenCalledWith('UAT-015');

    settlement.release({
      ok: true,
      value: { displayId: 'UAT-015', status: 'completed' },
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Grade level saved to Google');
    });
    // Only the settled job released the receipt, and the card shows the new value.
    expect(confirmations.pending(user().userId)).toBeNull();
    expect(card.prepare).toHaveBeenCalledTimes(1);
    expect(store.user).toHaveBeenCalledTimes(2);
    const annotation = [...element.querySelectorAll('.annotation')].find(
      (box) => box.querySelector('dt')?.textContent?.trim() === 'Grade level',
    );
    expect(annotation?.querySelector('dd')?.textContent?.trim()).toBe('11');
  });

  it('recovers the accepted receipt on the next page after the cap (R4-A)', async () => {
    const card = {
      prepare: vi.fn().mockResolvedValue({ ok: true, value: cardPreview }),
      readTargets: vi.fn(),
      confirm: vi.fn().mockResolvedValue(cardReceipt),
      // The editor reaches its cap, and the next form observes the same job to its end.
      waitForJob: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          message: 'The job is still running.',
        })
        .mockResolvedValue({
          ok: true,
          value: { displayId: 'UAT-015', status: 'completed' },
        }),
      // The departed card's continuation never answers.
      readJob: vi.fn(() => new Promise(() => undefined)),
    };
    const first = await setup({
      canWrite: true,
      categories: writableCategories,
      flow: card,
    });
    first.button('Edit')?.click();
    first.fixture.detectChanges();
    await first.fixture.whenStable();
    const grade = first.element.querySelector<HTMLInputElement>(
      '[data-attribute="attr:Student.grade_level"] input',
    );
    if (!grade) throw new Error('No Grade level field');
    grade.value = '11';
    grade.dispatchEvent(new Event('input'));
    first.fixture.detectChanges();
    first.button('Save changes')?.click();
    await vi.waitFor(() => {
      first.fixture.detectChanges();
      expect(first.element.textContent).toContain('The job is still running.');
    });
    const confirmations = TestBed.inject(UserAttributeConfirmationStore);
    expect(confirmations.pending(user().userId)).toMatchObject({
      phase: 'accepted',
      displayId: 'UAT-015',
    });

    // The person leaves the details page before the job has any provider effect.
    first.fixture.destroy();
    first.store.user.mockResolvedValue({
      kind: 'user',
      user: user({
        customSchemas: {
          Student: {
            student_id: '204518',
            grade_level: '11',
            graduation_year: '2029',
            homeroom: '214',
            programs: [{ value: 'Gifted' }, { value: 'Band' }],
          },
          Device: { take_home: true },
        },
      }),
    });
    const second = await mountPage(user().userId);
    second.button('Edit')?.click();
    second.fixture.detectChanges();
    await second.fixture.whenStable();
    // The reopened form recovers the receipt instead of preparing a second preview.
    expect(second.element.querySelector('.attribute-form')).toBeNull();
    await vi.waitFor(() => {
      second.fixture.detectChanges();
      expect(second.element.textContent).toContain(
        'Grade level saved to Google',
      );
    });
    expect(card.prepare).toHaveBeenCalledTimes(1);
    expect(card.confirm).toHaveBeenCalledTimes(1);
    expect(card.waitForJob).toHaveBeenCalledTimes(2);
    expect(confirmations.pending(user().userId)).toBeNull();
    const annotation = [...second.element.querySelectorAll('.annotation')].find(
      (box) => box.querySelector('dt')?.textContent?.trim() === 'Grade level',
    );
    expect(annotation?.querySelector('dd')?.textContent?.trim()).toBe('11');
  });

  it('recovers an accepted receipt after a closed form and refreshes the card (R3-B)', async () => {
    const card = {
      prepare: vi.fn().mockResolvedValue({ ok: true, value: cardPreview }),
      readTargets: vi.fn(),
      confirm: vi.fn().mockResolvedValue(cardReceipt),
      waitForJob: vi.fn().mockResolvedValue({
        ok: true,
        value: { displayId: 'UAT-015', status: 'completed' },
      }),
      readJob: vi.fn(),
    };
    const { store, fixture, element, button } = await setup({
      canWrite: true,
      categories: writableCategories,
      flow: card,
    });
    // The editor that accepted this receipt died before its job settled (R3-B).
    TestBed.inject(UserAttributeConfirmationStore).accept(
      user().userId,
      cardPreview,
      ['Grade level'],
      'UAT-015',
    );
    store.user.mockResolvedValue({
      kind: 'user',
      user: user({
        customSchemas: {
          Student: {
            student_id: '204518',
            grade_level: '11',
            graduation_year: '2029',
            homeroom: '214',
            programs: [{ value: 'Gifted' }, { value: 'Band' }],
          },
          Device: { take_home: true },
        },
      }),
    });
    button('Edit')?.click();
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Grade level saved to Google');
    });
    // The recovery observed the same receipt, then refreshed the matching card.
    expect(card.waitForJob).toHaveBeenCalledWith(
      'UAT-015',
      120,
      1000,
      expect.any(Function),
    );
    expect(card.prepare).not.toHaveBeenCalled();
    expect(store.user).toHaveBeenCalledTimes(2);
    const annotation = [...element.querySelectorAll('.annotation')].find(
      (box) => box.querySelector('dt')?.textContent?.trim() === 'Grade level',
    );
    expect(annotation?.querySelector('dd')?.textContent?.trim()).toBe('11');
  });

  it('names a job that needs review without claiming a failure (R1-F)', async () => {
    const card = {
      prepare: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          previewId: '2f1c6a0e-6d3b-4a1f-9f0e-3c4ce0b6a910',
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
        },
      }),
      readTargets: vi.fn(),
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
      waitForJob: vi.fn().mockResolvedValue({
        ok: true,
        value: { displayId: 'UAT-015', status: 'needs-review' },
      }),
    };
    const { fixture, element, button } = await setup({
      canWrite: true,
      flow: card,
    });
    button('Edit')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const studentId = element.querySelector<HTMLInputElement>(
      '[data-attribute="attr:Student.student_id"] input',
    );
    if (!studentId) throw new Error('No Student ID field');
    studentId.value = '204519';
    studentId.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button('Save changes')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('The job needs review.');
    });
    // The unknown result keeps its job link and does not claim that Google saved nothing.
    expect(element.textContent).not.toContain('The values did not save.');
    expect(
      element.querySelector('a[href="/jobs/UAT-015"]')?.textContent?.trim(),
    ).toBe('UAT-015');
    expect(
      element.querySelector('.saved-line')?.classList.contains('is-warning'),
    ).toBe(true);
  });
});

describe('the read age', () => {
  it('counts minutes, hours, and days', () => {
    const now = Date.parse('2026-11-01T13:12:00.000Z');
    expect(readAge('2026-11-01T13:11:40.000Z', now)).toBe('just now');
    expect(readAge('2026-11-01T12:52:00.000Z', now)).toBe('20 min ago');
    expect(readAge('2026-11-01T11:12:00.000Z', now)).toBe('2 h ago');
    expect(readAge('2026-10-30T13:12:00.000Z', now)).toBe('2 d ago');
  });
});
