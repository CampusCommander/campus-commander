import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { MatSelect } from '@angular/material/select';
import type { MatChipInputEvent } from '@angular/material/chips';
import { vi } from 'vitest';
import type {
  JobAttributeRow,
  JobDetail,
  UserAttributeCategory,
  UserAttributeField,
  UserAttributePreview,
  UserAttributeTarget,
} from '@campus/application-contracts';
import { UserAttributeBulkDialog } from './user-attribute-bulk-dialog';
import { UserAttributeBulkFlow } from './user-attribute-bulk-flow';
import { UserAttributeEditFlow } from './user-attribute-edit-flow';

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

const previewId = '2f1c6a0e-6d3b-4a1f-9f0e-3c4ce0b6a910';
const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const observedAt = '2026-11-01T13:12:00.000Z';

function preview(
  extra: Partial<UserAttributePreview> = {},
): UserAttributePreview {
  return {
    previewId,
    source: 'selection',
    changes: [
      {
        schemaName: 'Student',
        fieldName: 'programs',
        mode: 'add',
        values: ['ESL'],
      },
    ],
    attributeChanges: 18,
    selected: 25,
    eligible: 18,
    unchanged: 7,
    conflicts: 0,
    oldestObservedAt: observedAt,
    stale: false,
    preparedAt: observedAt,
    expiresAt: '2026-11-01T13:22:00.000Z',
    manifestDigest: 'a'.repeat(64),
    ...extra,
  };
}

function target(
  index: number,
  extra: Partial<UserAttributeTarget> = {},
): UserAttributeTarget {
  return {
    userId: `1100000000000000000${String(index).padStart(2, '0')}`,
    userName: `User ${index}`,
    primaryEmail: `user${index}@example.org`,
    attribute: 'attr:Student.programs',
    currentValue: ['Band'],
    newValue: ['Band', 'ESL'],
    disposition: 'eligible',
    observedAt,
    ...extra,
  };
}

function row(
  operation: number,
  extra: Partial<JobAttributeRow> = {},
): JobAttributeRow {
  return {
    operation,
    userId: `1100000000000000000${String(operation).padStart(2, '0')}`,
    userName: `User ${operation}`,
    primaryEmail: `user${operation}@example.org`,
    attribute: 'attr:Student.programs',
    displayName: 'Programs',
    currentValue: ['Band'],
    newValue: ['Band', 'ESL'],
    outcome: 'succeeded',
    failureText: null,
    ...extra,
  };
}

const job = {
  displayId: 'UAT-014',
  action: 'set-attributes',
  status: 'completed-with-errors',
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
  requestedBy: { displayName: 'Review administrator' },
  confirmedBy: { displayName: 'Review administrator' },
  createdAt: observedAt,
  finishedAt: '2026-11-01T14:41:00.000Z',
} as unknown as JobDetail;

const receipt = {
  ok: true as const,
  value: {
    jobId: '8f2b4b19-4c6a-47fd-8d0a-0f3ce4b0f2a1',
    displayId: 'UAT-014',
    status: 'accepted' as const,
    userCount: 18,
    changeCount: 18,
  },
};

interface DialogInternals {
  chooseCategory(name: string): void;
  chooseField(name: string): void;
  chooseMode(mode: string): void;
  setText(event: Event): void;
  setBool(value: boolean): void;
  addChip(event: MatChipInputEvent): void;
  review(): Promise<void>;
  confirm(): Promise<void>;
  step(): string;
}

describe('the Set attributes dialog', () => {
  let bulk: {
    prepare: ReturnType<typeof vi.fn>;
    readTargetsPage: ReturnType<typeof vi.fn>;
    readRowsPage: ReturnType<typeof vi.fn>;
  };
  let edit: {
    confirm: ReturnType<typeof vi.fn>;
    readJob: ReturnType<typeof vi.fn>;
    waitForJob: ReturnType<typeof vi.fn>;
  };
  let fixture: ComponentFixture<UserAttributeBulkDialog>;
  let element: HTMLElement;
  let dialog: DialogInternals;

  beforeEach(() => {
    bulk = {
      prepare: vi.fn().mockResolvedValue({ ok: true, value: preview() }),
      readTargetsPage: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          targets: Array.from({ length: 10 }, (_, index) => target(index + 1)),
          nextCursor: 'p2',
        },
      }),
      readRowsPage: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          rows: Array.from({ length: 10 }, (_, index) => row(index + 1)),
          totals: { all: 18, failed: 1 },
          nextCursor: 'r2',
        },
      }),
    };
    edit = {
      confirm: vi.fn().mockResolvedValue(receipt),
      readJob: vi.fn(),
      waitForJob: vi.fn().mockResolvedValue({ ok: true, value: job }),
    };
  });

  function build(
    prepared: UserAttributePreview | null = null,
    categoryList: UserAttributeCategory[] = categories,
    categoryError = '',
  ): void {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: UserAttributeBulkFlow, useValue: bulk },
        { provide: UserAttributeEditFlow, useValue: edit },
      ],
    });
    fixture = TestBed.createComponent(UserAttributeBulkDialog);
    fixture.componentRef.setInput('selection', { gridId: 'users', tabId });
    fixture.componentRef.setInput('selected', 25);
    fixture.componentRef.setInput('categories', categoryList);
    fixture.componentRef.setInput('categoriesError', categoryError);
    fixture.componentRef.setInput('prepared', prepared);
    fixture.detectChanges();
    element = fixture.nativeElement as HTMLElement;
    dialog = fixture.componentInstance as unknown as DialogInternals;
  }

  async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) {
      fixture.detectChanges();
      await Promise.resolve();
    }
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function text(): string {
    return element.textContent ?? '';
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...element.querySelectorAll('button')].find((item) =>
      `${item.textContent ?? ''} ${item.getAttribute('aria-label') ?? ''}`.includes(
        label,
      ),
    ) as HTMLButtonElement | undefined;
  }

  function selects(): MatSelect[] {
    return fixture.debugElement
      .queryAll(By.directive(MatSelect))
      .map((debug) => debug.injector.get(MatSelect));
  }

  it('offers every attribute, the modes of its kind, and its info type (states 08 and 11)', () => {
    build();
    expect(text()).toContain('25 selected users');
    expect(text()).toContain('Whole number · Single value');
    expect(text()).toContain('Set value');
    expect(text()).toContain('Clear value');
    const [category, attribute] = selects();
    expect(category.options.map((option) => option.value)).toEqual([
      'Student',
      'Device',
    ]);
    expect(attribute.options.map((option) => option.value)).toEqual([
      'grade_level',
      'homeroom',
      'programs',
    ]);

    dialog.chooseField('programs');
    fixture.detectChanges();
    expect(text()).toContain('Text · Multiple values');
    expect(text()).toContain('Add values');
    expect(text()).toContain('Remove values');
    expect(text()).toContain('Replace all values');
    expect(text()).toContain('Clear values');
    expect(text()).toContain('Values');

    dialog.chooseCategory('Device');
    fixture.detectChanges();
    expect(text()).toContain('Yes');
    expect(text()).toContain('No');
    expect(text()).toContain('Set value');
  });

  it('holds the review until a value passes the value rules, then sends one change', async () => {
    build();
    dialog.chooseField('programs');
    fixture.detectChanges();
    await dialog.review();
    await settle();
    expect(text()).toContain('Enter at least one value.');
    expect(bulk.prepare).not.toHaveBeenCalled();

    dialog.addChip({
      value: 'ESL',
      chipInput: { clear: () => undefined },
    } as unknown as MatChipInputEvent);
    fixture.detectChanges();
    (button('Review') as HTMLButtonElement).click();
    await settle();

    expect(bulk.prepare).toHaveBeenCalledWith({ gridId: 'users', tabId }, [
      {
        schemaName: 'Student',
        fieldName: 'programs',
        mode: 'add',
        values: ['ESL'],
      },
    ]);
  });

  it('shows the preview counts and one page of rows, then asks the next page at the cursor (state 09)', async () => {
    build();
    dialog.chooseField('programs');
    fixture.detectChanges();
    dialog.addChip({
      value: 'ESL',
      chipInput: { clear: () => undefined },
    } as unknown as MatChipInputEvent);
    fixture.detectChanges();
    (button('Review') as HTMLButtonElement).click();
    await settle();

    expect(text()).toContain('25');
    expect(text()).toContain('No change needed');
    expect(text()).toContain('Proposed');
    expect(text()).toContain('1–10 of 18 proposed changes');
    expect(text()).toContain('Band');
    expect(element.querySelectorAll('tbody tr').length).toBe(10);
    expect(bulk.readTargetsPage).toHaveBeenCalledWith(
      previewId,
      'eligible',
      null,
    );

    (button('Next review page') as HTMLButtonElement).click();
    await settle();
    expect(bulk.readTargetsPage).toHaveBeenLastCalledWith(
      previewId,
      'eligible',
      'p2',
    );

    (button('No change needed') as HTMLButtonElement).click();
    await settle();
    expect(bulk.readTargetsPage).toHaveBeenLastCalledWith(
      previewId,
      'unchanged',
      null,
    );
  });

  it('shows the stale note and turns Confirm off while a conflict remains (state 09)', async () => {
    bulk.prepare.mockResolvedValue({
      ok: true,
      value: preview({ stale: true, conflicts: 1, unchanged: 6 }),
    });
    build();
    dialog.chooseField('programs');
    fixture.detectChanges();
    dialog.addChip({
      value: 'ESL',
      chipInput: { clear: () => undefined },
    } as unknown as MatChipInputEvent);
    fixture.detectChanges();
    (button('Review') as HTMLButtonElement).click();
    await settle();

    expect(text()).toContain('more than 24 hours old');
    expect(text()).toContain('A value changed in Google');
    const confirm = button('Set attributes on 18 users') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('keeps the setup and the value when the request is too large (acceptance 6)', async () => {
    bulk.prepare.mockResolvedValue({
      ok: false,
      message: 'The request exceeds the size limit.',
    });
    build();
    dialog.chooseField('programs');
    fixture.detectChanges();
    dialog.addChip({
      value: 'ESL',
      chipInput: { clear: () => undefined },
    } as unknown as MatChipInputEvent);
    fixture.detectChanges();
    (button('Review') as HTMLButtonElement).click();
    await settle();

    expect(text()).toContain('The request exceeds the size limit.');
    expect(text()).toContain('ESL');
    expect(text()).toContain('Add values');
  });

  it('opens at the review of an edit-list preview and keeps Conflict rows from Confirm (K26 entry)', async () => {
    build(
      preview({
        source: 'edit-list',
        changes: null,
        attributeChanges: 2,
        selected: 2,
        eligible: 2,
        unchanged: 0,
      }),
    );
    await settle();
    expect(dialog.step()).toBe('review');
    expect(text()).toContain('2 selected users');
    expect(bulk.readTargetsPage).toHaveBeenCalledWith(
      previewId,
      'eligible',
      null,
    );
    expect(button('Back')).toBeTruthy();
    const confirm = button('Set attributes on 2 users') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it('keeps a Conflict edit-list preview from Confirm (acceptance 5)', async () => {
    build(
      preview({
        source: 'edit-list',
        changes: null,
        attributeChanges: 1,
        selected: 2,
        eligible: 1,
        unchanged: 0,
        conflicts: 1,
      }),
    );
    await settle();
    const confirm = button('Set attributes on 1 user') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(text()).toContain('A value changed in Google');
  });

  it('follows the accepted job to the result counts, band, and rows, then pages by cursor (state 10)', async () => {
    build();
    dialog.chooseField('programs');
    fixture.detectChanges();
    dialog.addChip({
      value: 'ESL',
      chipInput: { clear: () => undefined },
    } as unknown as MatChipInputEvent);
    fixture.detectChanges();
    (button('Review') as HTMLButtonElement).click();
    await settle();
    (button('Set attributes on 18 users') as HTMLButtonElement).click();
    await settle();

    expect(edit.confirm).toHaveBeenCalledWith(previewId, 'a'.repeat(64));
    expect(edit.waitForJob).toHaveBeenCalledWith(
      'UAT-014',
      120,
      1000,
      expect.any(Function),
    );
    expect(text()).toContain('UAT-014');
    expect(text()).toContain('Completed with errors');
    expect(text()).toContain('17');
    expect(text()).toContain('Succeeded');
    expect(text()).toContain('Failed');
    expect(text()).toContain('Executed by Review administrator');
    expect(text()).toContain('Finished');
    expect(text()).toContain('1–10 of 18 changes');
    expect(bulk.readRowsPage).toHaveBeenCalledWith('UAT-014', 'all', null);

    (button('Next results page') as HTMLButtonElement).click();
    await settle();
    expect(bulk.readRowsPage).toHaveBeenLastCalledWith('UAT-014', 'all', 'r2');

    (button('Failed') as HTMLButtonElement).click();
    await settle();
    expect(bulk.readRowsPage).toHaveBeenLastCalledWith(
      'UAT-014',
      'failed',
      null,
    );
  });

  it('names a failed category read and asks the page to retry (UI-08)', () => {
    build(null, [], 'You do not have permission to read custom attributes.');
    let retried = 0;
    fixture.componentInstance.categoriesRetry.subscribe(() => (retried += 1));
    expect(text()).toContain(
      'You do not have permission to read custom attributes.',
    );
    (button('Retry') as HTMLButtonElement).click();
    expect(retried).toBe(1);
  });

  it('names a failed result read and retries the same page', async () => {
    bulk.readRowsPage.mockResolvedValue({
      ok: false,
      message: 'Campus Commander could not read the results. Retry.',
    });
    build();
    dialog.chooseField('programs');
    fixture.detectChanges();
    dialog.addChip({
      value: 'ESL',
      chipInput: { clear: () => undefined },
    } as unknown as MatChipInputEvent);
    fixture.detectChanges();
    (button('Review') as HTMLButtonElement).click();
    await settle();
    (button('Set attributes on 18 users') as HTMLButtonElement).click();
    await settle();

    expect(text()).toContain(
      'Campus Commander could not read the results. Retry.',
    );
    (button('Retry') as HTMLButtonElement).click();
    await settle();
    expect(bulk.readRowsPage).toHaveBeenCalledTimes(2);
  });
});
