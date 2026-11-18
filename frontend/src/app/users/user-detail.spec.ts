import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  UserAttributeCategories,
  UserDetail,
  UserRow,
  UserSyncState,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { UserDetailPage, readAge } from './user-detail';
import { UsersStore } from './users.store';

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

async function setup(options: {
  detail?: UserDetail | null;
  position?: { index: number; userId: string } | null;
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
}) {
  const detail = options.detail === undefined ? user() : options.detail;
  const store = {
    sync: signal(options.sync === undefined ? sync : options.sync),
    syncLoaded: signal(options.syncLoaded ?? true),
    statusError: signal(options.statusError ?? ''),
    statusRetryable: signal(options.statusRetryable ?? true),
    position: signal<{ index: number; userId: string } | null>(
      options.position === undefined
        ? { index: 0, userId: '110000000000000000001' }
        : options.position,
    ),
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
    user: vi.fn().mockResolvedValue(detail),
    neighbor: vi.fn().mockResolvedValue(options.next ?? null),
    loadSync: vi.fn().mockResolvedValue(true),
    loadCategories: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: UsersStore, useValue: store },
      {
        provide: AuthStore,
        useValue: {
          session: signal({
            identity: { id: 'synthetic-user-detail', grants: [] },
            expiresAt: '2026-11-20T12:00:00.000Z',
            csrfToken: 'a'.repeat(64),
          }),
          metadata: signal({ phase: 3 }),
          request: vi.fn(async () => Response.json({}, { status: 404 })),
        },
      },
    ],
  });
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(UserDetailPage);
  fixture.componentRef.setInput('userId', detail?.userId ?? 'missing-user');
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
  return { store, element, navigate, button, fact, fixture };
}

describe('the user details page', () => {
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
      position: { index: 0, userId: '110000000000000000001' },
      matching: 3,
      next: nextRow,
    });
    button('Next user')!.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(store.neighbor).toHaveBeenCalledWith(1);
    expect(store.position()).toEqual({
      index: 1,
      userId: '110000000000000000002',
    });
    expect(navigate).toHaveBeenCalledWith(['/users', '110000000000000000002']);
  });

  it('disables Next user on the last row of the order', async () => {
    const { button } = await setup({
      position: { index: 2, userId: '110000000000000000001' },
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
    const { element } = await setup({ detail: null, offline: true });
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'Cannot reach Campus Commander',
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
