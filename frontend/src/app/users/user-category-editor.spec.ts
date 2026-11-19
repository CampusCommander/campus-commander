import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  UserAttributeCategory,
  UserAttributeLimits,
} from '@campus/application-contracts';
import { UserCategoryEditor } from './user-category-editor';
import { UserCategoryFlow } from './user-category-flow';

const limits: UserAttributeLimits = {
  categories: 1,
  categoryLimit: 100,
  attributes: 2,
  attributeLimit: 100,
};

const fullLimits: UserAttributeLimits = {
  ...limits,
  attributes: 100,
};

const category: UserAttributeCategory = {
  schemaId: 'Student',
  schemaName: 'Student',
  displayName: 'Student information',
  etag: '"student-etag"',
  fields: [
    {
      fieldId: 'Student.GradeLevel',
      fieldName: 'GradeLevel',
      displayName: 'Grade level',
      fieldType: 'INT64',
      multiValued: false,
      indexed: true,
      readAccessType: 'ALL_DOMAIN_USERS',
      numericIndexingSpec: null,
      holders: 4,
    },
    {
      fieldId: 'Student.Homeroom',
      fieldName: 'Homeroom',
      displayName: 'Homeroom',
      fieldType: 'STRING',
      multiValued: true,
      indexed: false,
      readAccessType: 'ADMINS_AND_SELF',
      numericIndexingSpec: null,
      holders: 4,
    },
  ],
  holders: 4,
  readAt: '2026-11-16T12:00:00.000Z',
};

const categories = [category];

const deletePlan = {
  planId: '33333333-3333-4333-8333-333333333333',
  kind: 'delete-category' as const,
  method: 'delete' as const,
  schemaId: 'Student',
  schemaName: 'Student',
  displayName: 'Student information',
  baseEtag: '"student-etag"',
  changes: [
    {
      change: 'removed' as const,
      fieldId: 'Student.Homeroom',
      fieldName: 'Homeroom',
      displayName: 'Homeroom',
      properties: [],
      holders: 4,
    },
  ],
  phrase: 'Student information',
  limits,
  preparedAt: '2026-11-16T12:00:00.000Z',
  expiresAt: '2026-11-16T12:10:00.000Z',
  digest: 'b'.repeat(64),
};

/** The delete plan that follows an expired one in the replay regression (R8). */
const replacementDeletePlan = {
  ...deletePlan,
  planId: '66666666-6666-4666-8666-666666666666',
  digest: 'e'.repeat(64),
};

const oneFieldCategory: UserAttributeCategory = {
  ...category,
  fields: [category.fields[1]],
};

const threeFieldCategory: UserAttributeCategory = {
  ...category,
  fields: [
    category.fields[0],
    category.fields[1],
    {
      fieldId: 'Student.Notes',
      fieldName: 'Notes',
      displayName: 'Notes',
      fieldType: 'STRING',
      multiValued: false,
      indexed: true,
      readAccessType: 'ADMINS_AND_SELF',
      numericIndexingSpec: null,
      holders: 2,
    },
  ],
};

/** The two number attributes of states 13 and 14. */
const rangeCategory: UserAttributeCategory = {
  ...category,
  fields: [
    category.fields[0],
    {
      fieldId: 'Student.GraduationYear',
      fieldName: 'GraduationYear',
      displayName: 'Graduation year',
      fieldType: 'INT64',
      multiValued: false,
      indexed: true,
      readAccessType: 'ADMINS_AND_SELF',
      numericIndexingSpec: null,
      holders: 3,
    },
  ],
};

/** A category whose Grade level already holds the range 0 to 12. */
const rangedCategory: UserAttributeCategory = {
  ...category,
  fields: [
    {
      ...category.fields[0],
      numericIndexingSpec: { minValue: 0, maxValue: 12 },
    },
    category.fields[1],
  ],
};

const plan = {
  planId: '11111111-1111-4111-8111-111111111111',
  kind: 'edit-category' as const,
  method: 'update' as const,
  schemaId: 'Student',
  schemaName: 'Student',
  displayName: 'Student information',
  baseEtag: '"student-etag"',
  changes: [
    {
      change: 'added' as const,
      fieldId: null,
      fieldName: 'Counselor',
      displayName: 'Counselor',
      properties: [],
      holders: null,
    },
    {
      change: 'removed' as const,
      fieldId: 'Student.Homeroom',
      fieldName: 'Homeroom',
      displayName: 'Homeroom',
      properties: [],
      holders: 4,
    },
  ],
  phrase: 'Homeroom',
  limits,
  preparedAt: '2026-11-16T12:00:00.000Z',
  expiresAt: '2026-11-16T12:10:00.000Z',
  digest: 'a'.repeat(64),
};

/** A plan that changes only the number range of Grade level (K19, state 15). */
const rangePlan = {
  ...plan,
  planId: '77777777-7777-4777-8777-777777777777',
  changes: [
    {
      change: 'changed' as const,
      fieldId: 'Student.GradeLevel',
      fieldName: 'GradeLevel',
      displayName: 'Grade level',
      properties: ['numericIndexingSpec'],
      holders: null,
    },
  ],
  phrase: null,
  digest: 'f'.repeat(64),
};

/** A plan that removes two attributes, in the order of the cached category. */
const twoRemovalPlan = {
  ...plan,
  planId: '44444444-4444-4444-8444-444444444444',
  changes: [
    {
      change: 'removed' as const,
      fieldId: 'Student.GradeLevel',
      fieldName: 'GradeLevel',
      displayName: 'Grade level',
      properties: [],
      holders: 4,
    },
    {
      change: 'removed' as const,
      fieldId: 'Student.Homeroom',
      fieldName: 'Homeroom',
      displayName: 'Homeroom',
      properties: [],
      holders: 4,
    },
  ],
  phrase: 'GradeLevel',
  digest: 'c'.repeat(64),
};

/** A create plan for one Text attribute. */
const addedPlan = {
  ...plan,
  planId: '55555555-5555-4555-8555-555555555555',
  kind: 'create-category' as const,
  method: 'insert' as const,
  schemaId: null,
  schemaName: 'Transportation',
  displayName: 'Transportation',
  baseEtag: null,
  changes: [
    {
      change: 'added' as const,
      fieldId: null,
      fieldName: 'Counselor',
      displayName: 'Counselor',
      properties: [],
      holders: null,
    },
  ],
  phrase: null,
  digest: 'd'.repeat(64),
};

const receipt = {
  jobId: '22222222-2222-4222-8222-222222222222',
  displayId: 'CAT-003',
  status: 'accepted' as const,
  action: 'edit-category' as const,
  changeCount: 2,
};

const runningJob = {
  displayId: 'CAT-003',
  status: 'running' as const,
  failure: null,
  finishedAt: null,
};

const completedJob = {
  displayId: 'CAT-003',
  status: 'completed' as const,
  failure: null,
  finishedAt: '2026-11-16T12:04:00.000Z',
};

function setup(
  jobAnswers: readonly (typeof runningJob | typeof completedJob)[] = [
    completedJob,
  ],
) {
  const flow = {
    prepare: vi.fn().mockResolvedValue({ ok: true, plan }),
    confirm: vi.fn().mockResolvedValue({ ok: true, receipt }),
    readJob: vi.fn(),
  };
  let reads = 0;
  flow.readJob.mockImplementation(() => {
    const answer =
      jobAnswers[Math.min(reads, jobAnswers.length - 1)] ?? completedJob;
    reads += 1;
    return Promise.resolve({ ok: true, job: answer });
  });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: UserCategoryFlow, useValue: flow },
    ],
  });
  return flow;
}

function render(
  mode: 'create' | 'edit',
  options: {
    category?: UserAttributeCategory | null;
    limits?: UserAttributeLimits;
  } = {},
) {
  const fixture = TestBed.createComponent(UserCategoryEditor);
  fixture.componentRef.setInput('mode', mode);
  fixture.componentRef.setInput('category', options.category ?? null);
  fixture.componentRef.setInput('limits', options.limits ?? limits);
  fixture.componentRef.setInput('categories', categories);
  fixture.detectChanges();
  return fixture;
}

type Fixture = ReturnType<typeof render>;
const element = (fixture: Fixture) => fixture.nativeElement as HTMLElement;
const text = (fixture: Fixture) =>
  element(fixture).textContent?.replace(/\s+/g, ' ').trim() ?? '';
const buttons = (fixture: Fixture) =>
  [...element(fixture).querySelectorAll('button')] as HTMLButtonElement[];
const button = (fixture: Fixture, name: string) =>
  buttons(fixture).find((item) => {
    const label = (item.getAttribute('aria-label') ?? '').trim();
    const content = (item.textContent ?? '').replace(/\s+/g, ' ').trim();
    return label === name || content === name || content.endsWith(name);
  });
const field = (fixture: Fixture, label: string) =>
  element(fixture).querySelector(
    `[aria-label="${label}"]`,
  ) as HTMLInputElement | null;
const mustField = (fixture: Fixture, label: string): HTMLInputElement => {
  const input = field(fixture, label);
  if (!input) throw new Error(`the dialog has no field ${label}`);
  return input;
};
const nameField = (fixture: Fixture) =>
  element(fixture).querySelector(
    'input.mat-mdc-input-element:not(.identifier)',
  ) as HTMLInputElement;
/** The derived category name of a create, before the attribute name fields. */
const categoryNameInput = (fixture: Fixture) =>
  element(fixture).querySelector(
    'input.mat-mdc-input-element.identifier',
  ) as HTMLInputElement;
const type = (fixture: Fixture, input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
};

describe('the category editor dialog (CA states 02 to 08, 10, and 12)', () => {
  it('opens the create editor with one empty attribute (CA state 02)', () => {
    setup();
    const fixture = render('create');
    expect(
      element(fixture)
        .querySelector('#category-editor-title')
        ?.textContent?.trim(),
    ).toBe('Create category');
    expect(field(fixture, 'Display name for attribute 1')).not.toBeNull();
    expect(button(fixture, 'Add attribute')?.disabled).toBe(false);
    // The category name follows the display name until a person edits it.
    type(fixture, nameField(fixture), 'Transportation');
    const categoryName = element(fixture).querySelectorAll(
      'input.mat-mdc-input-element',
    )[1] as HTMLInputElement;
    expect(categoryName.value).toBe('Transportation');
  });

  it('shows the C2 repeated display name and the name rule (CA state 03)', () => {
    setup();
    const fixture = render('create');
    type(fixture, nameField(fixture), 'Transportation');
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 1'),
      'Bus route',
    );
    button(fixture, 'Add attribute')?.click();
    fixture.detectChanges();
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 2'),
      'Bus route',
    );
    type(
      fixture,
      mustField(fixture, 'Attribute name for attribute 2'),
      'Stop #',
    );
    button(fixture, 'Review changes')?.click();
    fixture.detectChanges();
    const messages = [...element(fixture).querySelectorAll('.field-error')].map(
      (error) => error.textContent?.trim(),
    );
    expect(messages).toContain('Each attribute needs a unique display name.');
    expect(messages).toContain('Use letters, digits, _ and - only.');
    // One repeated name marks the later row only.
    expect(
      messages.filter(
        (message) => message === 'Each attribute needs a unique display name.',
      ),
    ).toHaveLength(1);
    expect(button(fixture, 'Review changes')?.disabled).toBe(true);
    expect(text(fixture)).toContain('fields have errors');
  });

  it('locks the name and the info type and keeps the removal mark (CA state 04)', () => {
    setup();
    const fixture = render('edit', { category });
    expect(field(fixture, 'Attribute name for attribute 1')).toBeNull();
    expect(field(fixture, 'Info type for attribute 1')).toBeNull();
    const multiple = element(fixture).querySelector(
      '[aria-label="Multiple values for Homeroom"]',
    ) as HTMLInputElement;
    expect(multiple.disabled).toBe(true);
    expect(text(fixture)).toContain('Cannot return to one value');
    button(fixture, 'Remove attribute Homeroom')?.click();
    fixture.detectChanges();
    expect(text(fixture)).toContain('Removes values from 4 users');
    expect(button(fixture, 'Keep attribute Homeroom')).not.toBeUndefined();
    button(fixture, 'Keep attribute Homeroom')?.click();
    fixture.detectChanges();
    expect(text(fixture)).not.toContain('Removes values from 4 users');
  });

  it('disables Add attribute at the account limit (CA state 10)', () => {
    setup();
    const fixture = render('edit', { category, limits: fullLimits });
    expect(button(fixture, 'Add attribute')?.disabled).toBe(true);
    expect(text(fixture)).toContain(
      '100 of 100 attributes used. Remove an attribute before you add one.',
    );
  });

  it('names the 24-hour delay after a visibility change (CA state 12)', () => {
    setup();
    const fixture = render('edit', { category });
    const editor = fixture.componentInstance as unknown as {
      setVisibility(row: unknown, value: string): void;
      visibleRows(): unknown[];
    };
    editor.setVisibility(editor.visibleRows()[0], 'ADMINS_AND_SELF');
    fixture.detectChanges();
    expect(text(fixture)).toContain(
      'Google can take up to 24 hours to apply a visibility change.',
    );
    expect(element(fixture).querySelectorAll('.is-changed')).toHaveLength(1);
  });

  it('reviews the change, saves it, and draws the result (CA states 05 to 07)', async () => {
    const flow = setup([runningJob, completedJob]);
    const fixture = render('edit', { category });
    button(fixture, 'Remove attribute Homeroom')?.click();
    button(fixture, 'Add attribute')?.click();
    fixture.detectChanges();
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 2'),
      'Counselor',
    );
    button(fixture, 'Review changes')?.click();
    await vi.waitFor(() =>
      expect(text(fixture)).toContain('2 changes to Student information'),
    );
    fixture.detectChanges();
    expect(text(fixture)).toContain(
      'The changes apply to every user in the domain.',
    );
    expect(text(fixture)).toContain(
      'Removing Homeroom deletes its values on 4 users. Nothing restores them.',
    );
    // The save waits for the plan phrase.
    expect(button(fixture, 'Save 2 changes')?.disabled).toBe(true);
    const phrase = element(fixture).querySelector(
      'input.removal-phrase',
    ) as HTMLInputElement;
    type(fixture, phrase, 'Homeroom');
    expect(button(fixture, 'Save 2 changes')?.disabled).toBe(false);
    button(fixture, 'Save 2 changes')?.click();
    await vi.waitFor(() => expect(flow.confirm).toHaveBeenCalledTimes(1));
    expect(flow.confirm).toHaveBeenCalledWith(
      plan.planId,
      plan.digest,
      'Homeroom',
    );
    fixture.detectChanges();
    expect(text(fixture)).toContain('Save changes in Google');
    expect(text(fixture)).toContain(
      'Closing this dialog keeps the save running.',
    );
    // The second job read settles the save (state 07).
    await vi.waitFor(() => expect(text(fixture)).toContain('Succeeded'), {
      timeout: 4000,
    });
    fixture.detectChanges();
    expect(text(fixture)).toContain('Succeeded');
    expect(text(fixture)).toContain('Finished');
    expect(text(fixture)).toContain('All changes');
  });

  it('asks the category name before a delete and returns to the editor (CA state 08)', () => {
    setup();
    const fixture = render('edit', { category });
    button(fixture, 'Delete category')?.click();
    fixture.detectChanges();
    expect(
      element(fixture)
        .querySelector('#category-editor-title')
        ?.textContent?.trim(),
    ).toBe('Delete category');
    expect(text(fixture)).toContain(
      'The change applies to every user in the domain.',
    );
    expect(button(fixture, 'Delete category')?.disabled).toBe(true);
    const phrase = element(fixture).querySelector(
      'input#category-delete-phrase',
    ) as HTMLInputElement;
    type(fixture, phrase, 'Student');
    expect(text(fixture)).toContain(
      'The phrase does not match. Type Student information.',
    );
    button(fixture, 'Cancel')?.click();
    fixture.detectChanges();
    expect(
      element(fixture)
        .querySelector('#category-editor-title')
        ?.textContent?.trim(),
    ).toBe('Edit category');
    expect(field(fixture, 'Display name for attribute 1')).not.toBeNull();
  });

  it('clears a corrected field error and re-enables Review changes (R1)', () => {
    setup();
    const fixture = render('create');
    type(fixture, nameField(fixture), 'Transportation');
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 1'),
      'Bus route',
    );
    type(
      fixture,
      mustField(fixture, 'Attribute name for attribute 1'),
      'Stop #',
    );
    button(fixture, 'Review changes')?.click();
    fixture.detectChanges();
    expect(text(fixture)).toContain('Use letters, digits, _ and - only.');
    expect(button(fixture, 'Review changes')?.disabled).toBe(true);
    type(
      fixture,
      mustField(fixture, 'Attribute name for attribute 1'),
      'BusRoute',
    );
    expect(text(fixture)).not.toContain('Use letters, digits, _ and - only.');
    expect(button(fixture, 'Review changes')?.disabled).toBe(false);
  });

  it('clears the error count when an invalid duplicate leaves the draft (R1)', () => {
    setup();
    const fixture = render('create');
    type(fixture, nameField(fixture), 'Transportation');
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 1'),
      'Bus route',
    );
    button(fixture, 'Add attribute')?.click();
    fixture.detectChanges();
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 2'),
      'Bus route',
    );
    button(fixture, 'Review changes')?.click();
    fixture.detectChanges();
    expect(text(fixture)).toContain(
      'Each attribute needs a unique display name.',
    );
    expect(button(fixture, 'Review changes')?.disabled).toBe(true);
    const remove = buttons(fixture).filter(
      (item) =>
        item.getAttribute('aria-label') === 'Remove attribute Bus route',
    );
    expect(remove).toHaveLength(2);
    remove[1].click();
    fixture.detectChanges();
    expect(text(fixture)).not.toContain(
      'Each attribute needs a unique display name.',
    );
    expect(button(fixture, 'Review changes')?.disabled).toBe(false);
    expect(text(fixture)).not.toContain('field has errors');
    expect(text(fixture)).not.toContain('fields have errors');
  });

  it('marks the changed row of a C2 collision and clears it on correction (R2)', () => {
    setup();
    const fixture = render('edit', { category });
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 1'),
      ' HOMEROOM ',
    );
    button(fixture, 'Review changes')?.click();
    fixture.detectChanges();
    const messages = [...element(fixture).querySelectorAll('.field-error')].map(
      (error) => error.textContent?.trim(),
    );
    expect(messages).toEqual(['Each attribute needs a unique display name.']);
    expect(
      mustField(fixture, 'Display name for attribute 1').getAttribute(
        'aria-invalid',
      ),
    ).toBe('true');
    expect(
      mustField(fixture, 'Display name for attribute 2').getAttribute(
        'aria-invalid',
      ),
    ).not.toBe('true');
    expect(button(fixture, 'Review changes')?.disabled).toBe(true);
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 1'),
      'Grade level',
    );
    expect(text(fixture)).not.toContain(
      'Each attribute needs a unique display name.',
    );
  });

  it('maps a refused display name onto the conflicting row (R2)', async () => {
    const flow = setup();
    flow.prepare.mockResolvedValueOnce({
      ok: false,
      status: 422,
      reason: 'display-name-in-use',
    });
    const fixture = render('edit', { category });
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 1'),
      'Homeroom',
    );
    button(fixture, 'Review changes')?.click();
    await vi.waitFor(() =>
      expect(text(fixture)).toContain(
        'Each attribute needs a unique display name.',
      ),
    );
    fixture.detectChanges();
    expect(
      mustField(fixture, 'Display name for attribute 1').getAttribute(
        'aria-invalid',
      ),
    ).toBe('true');
    expect(button(fixture, 'Review changes')?.disabled).toBe(true);
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 1'),
      'Grade level',
    );
    expect(text(fixture)).not.toContain(
      'Each attribute needs a unique display name.',
    );
  });

  it('clears a server category-name refusal when the derived name changes (R1)', async () => {
    const flow = setup();
    flow.prepare.mockResolvedValueOnce({
      ok: false,
      status: 422,
      reason: 'name-in-use',
    });
    const fixture = render('create');
    type(fixture, nameField(fixture), 'Transportation');
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 1'),
      'Bus route',
    );
    button(fixture, 'Review changes')?.click();
    await vi.waitFor(() =>
      expect(text(fixture)).toContain('A category with this name exists.'),
    );
    fixture.detectChanges();
    expect(button(fixture, 'Review changes')?.disabled).toBe(true);
    // The category name stays untouched, and the display name derives a new candidate.
    type(fixture, nameField(fixture), 'New transportation');
    expect(categoryNameInput(fixture).value).toBe('NewTransportation');
    expect(text(fixture)).not.toContain('A category with this name exists.');
    expect(button(fixture, 'Review changes')?.disabled).toBe(false);
    expect(flow.prepare).toHaveBeenCalledTimes(1);
    expect(flow.prepare.mock.calls[0][0]).toMatchObject({
      kind: 'create-category',
      draft: { schemaName: 'Transportation' },
    });
  });

  it('keeps a server category-name refusal when the derived name stays the same (R1)', async () => {
    const flow = setup();
    flow.prepare.mockResolvedValueOnce({
      ok: false,
      status: 422,
      reason: 'name-in-use',
    });
    const fixture = render('create');
    type(fixture, nameField(fixture), 'Bus route');
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 1'),
      'Stop name',
    );
    button(fixture, 'Review changes')?.click();
    await vi.waitFor(() =>
      expect(text(fixture)).toContain('A category with this name exists.'),
    );
    fixture.detectChanges();
    // Different words with the same derived name keep the refusal for that name.
    type(fixture, nameField(fixture), 'Bus-route');
    expect(categoryNameInput(fixture).value).toBe('BusRoute');
    expect(text(fixture)).toContain('A category with this name exists.');
    expect(button(fixture, 'Review changes')?.disabled).toBe(true);
  });

  it('keeps a staged multiple-values change reversible (R3)', () => {
    setup();
    const fixture = render('edit', { category });
    const multi = () =>
      element(fixture).querySelector(
        '[aria-label="Multiple values for Grade level"]',
      ) as HTMLInputElement;
    expect(multi().disabled).toBe(false);
    multi().click();
    fixture.detectChanges();
    expect(multi().disabled).toBe(false);
    expect(multi().checked).toBe(true);
    multi().click();
    fixture.detectChanges();
    expect(multi().disabled).toBe(false);
    expect(multi().checked).toBe(false);
    // A cached multi-value attribute never returns to one value.
    expect(
      (
        element(fixture).querySelector(
          '[aria-label="Multiple values for Homeroom"]',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });

  it('refuses to remove the last attribute and names the alternative (R4)', () => {
    setup();
    const fixture = render('edit', { category: oneFieldCategory });
    expect(button(fixture, 'Remove attribute Homeroom')?.disabled).toBe(true);
    expect(text(fixture)).toContain(
      'A category needs one attribute. Delete the category instead.',
    );
    const editor = fixture.componentInstance as unknown as {
      removeAttribute(row: unknown): void;
      visibleRows(): unknown[];
    };
    editor.removeAttribute(editor.visibleRows()[0]);
    fixture.detectChanges();
    expect(editor.visibleRows()).toHaveLength(1);
    expect(button(fixture, 'Review changes')?.disabled).toBe(true);
  });

  it('asks the cached category name after a draft rename (R5)', async () => {
    const flow = setup();
    flow.prepare.mockResolvedValue({ ok: true, plan: deletePlan });
    const fixture = render('edit', { category });
    type(fixture, nameField(fixture), 'Transportation');
    button(fixture, 'Delete category')?.click();
    fixture.detectChanges();
    expect(text(fixture)).toContain('Type Student information to confirm');
    const phrase = element(fixture).querySelector(
      'input#category-delete-phrase',
    ) as HTMLInputElement;
    type(fixture, phrase, 'Transportation');
    expect(button(fixture, 'Delete category')?.disabled).toBe(true);
    expect(text(fixture)).toContain(
      'The phrase does not match. Type Student information.',
    );
    type(fixture, phrase, 'Student information');
    expect(button(fixture, 'Delete category')?.disabled).toBe(false);
    button(fixture, 'Delete category')?.click();
    await vi.waitFor(() => expect(flow.confirm).toHaveBeenCalledTimes(1));
    expect(flow.confirm).toHaveBeenCalledWith(
      deletePlan.planId,
      deletePlan.digest,
      'Student information',
    );
    expect(flow.prepare).toHaveBeenCalledWith({
      kind: 'delete-category',
      schemaId: 'Student',
      baseEtag: '"student-etag"',
    });
  });

  it('keeps the draft rename after the delete question is cancelled (R5)', () => {
    setup();
    const fixture = render('edit', { category });
    type(fixture, nameField(fixture), 'Transportation');
    button(fixture, 'Delete category')?.click();
    fixture.detectChanges();
    button(fixture, 'Cancel')?.click();
    fixture.detectChanges();
    expect(
      element(fixture)
        .querySelector('#category-editor-title')
        ?.textContent?.trim(),
    ).toBe('Edit category');
    expect(nameField(fixture).value).toBe('Transportation');
  });

  it('asks each removed name before two removals (R6)', async () => {
    const flow = setup();
    flow.prepare.mockResolvedValueOnce({ ok: true, plan: twoRemovalPlan });
    const fixture = render('edit', { category: threeFieldCategory });
    button(fixture, 'Remove attribute Grade level')?.click();
    button(fixture, 'Remove attribute Homeroom')?.click();
    fixture.detectChanges();
    button(fixture, 'Review changes')?.click();
    await vi.waitFor(() =>
      expect(text(fixture)).toContain('2 changes to Student information'),
    );
    fixture.detectChanges();
    const phrases = [
      ...element(fixture).querySelectorAll('input.removal-phrase'),
    ] as HTMLInputElement[];
    expect(phrases.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Type GradeLevel to confirm',
      'Type Homeroom to confirm',
    ]);
    const save = () => button(fixture, 'Save 2 changes');
    expect(save()?.disabled).toBe(true);
    type(fixture, phrases[0], 'GradeLevel');
    expect(save()?.disabled).toBe(true);
    type(fixture, phrases[1], 'Homeroom');
    expect(save()?.disabled).toBe(false);
    save()?.click();
    await vi.waitFor(() => expect(flow.confirm).toHaveBeenCalledTimes(1));
    expect(flow.confirm).toHaveBeenCalledWith(
      twoRemovalPlan.planId,
      twoRemovalPlan.digest,
      'GradeLevel',
    );
  });

  it('replays the same delete plan after an uncertain confirmation (R8)', async () => {
    const flow = setup();
    flow.prepare.mockResolvedValue({ ok: true, plan: deletePlan });
    flow.confirm.mockResolvedValueOnce({
      ok: false,
      status: 0,
      reason: null,
      uncertain: true,
    });
    const fixture = render('edit', { category });
    button(fixture, 'Delete category')?.click();
    fixture.detectChanges();
    type(
      fixture,
      element(fixture).querySelector(
        'input#category-delete-phrase',
      ) as HTMLInputElement,
      'Student information',
    );
    button(fixture, 'Delete category')?.click();
    await vi.waitFor(() => expect(flow.confirm).toHaveBeenCalledTimes(1));
    fixture.detectChanges();
    expect(text(fixture)).toContain(
      'Campus Commander did not answer the confirmation, or the answer was not readable. The save may have started.',
    );
    expect(text(fixture)).not.toContain('The save did not start.');
    expect(button(fixture, 'Delete category')?.disabled).toBe(false);
    button(fixture, 'Delete category')?.click();
    await vi.waitFor(() => expect(flow.confirm).toHaveBeenCalledTimes(2));
    expect(flow.prepare).toHaveBeenCalledTimes(1);
    expect(flow.confirm.mock.calls[0][0]).toBe(deletePlan.planId);
    expect(flow.confirm.mock.calls[1][0]).toBe(deletePlan.planId);
    expect(flow.confirm.mock.calls[1][2]).toBe('Student information');
  });

  it('replays the replacement delete plan after an earlier expiry (R8)', async () => {
    const flow = setup();
    flow.prepare
      .mockResolvedValueOnce({ ok: true, plan: deletePlan })
      .mockResolvedValueOnce({ ok: true, plan: replacementDeletePlan });
    flow.confirm
      .mockResolvedValueOnce({
        ok: false,
        status: 410,
        reason: 'plan-expired',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 0,
        reason: null,
        uncertain: true,
      });
    const fixture = render('edit', { category });
    button(fixture, 'Delete category')?.click();
    fixture.detectChanges();
    type(
      fixture,
      element(fixture).querySelector(
        'input#category-delete-phrase',
      ) as HTMLInputElement,
      'Student information',
    );
    const confirmDelete = async (calls: number) => {
      button(fixture, 'Delete category')?.click();
      await vi.waitFor(() => expect(flow.confirm).toHaveBeenCalledTimes(calls));
      fixture.detectChanges();
    };
    await confirmDelete(1);
    expect(text(fixture)).toContain(
      'The plan expired. Review the change again.',
    );
    await confirmDelete(2);
    expect(flow.prepare).toHaveBeenCalledTimes(2);
    expect(text(fixture)).toContain(
      'Campus Commander did not answer the confirmation, or the answer was not readable. The save may have started.',
    );
    await confirmDelete(3);
    expect(flow.prepare).toHaveBeenCalledTimes(2);
    expect(flow.confirm.mock.calls[1][0]).toBe(replacementDeletePlan.planId);
    expect(flow.confirm.mock.calls[2][0]).toBe(replacementDeletePlan.planId);
    expect(flow.confirm.mock.calls[2][2]).toBe('Student information');
  });

  it('names an unreadable job and keeps its display ID (R9)', async () => {
    const flow = setup();
    flow.readJob.mockResolvedValue({ ok: false, status: 503, reason: null });
    const fixture = render('edit', { category });
    button(fixture, 'Remove attribute Homeroom')?.click();
    button(fixture, 'Add attribute')?.click();
    fixture.detectChanges();
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 2'),
      'Counselor',
    );
    button(fixture, 'Review changes')?.click();
    await vi.waitFor(() =>
      expect(text(fixture)).toContain('2 changes to Student information'),
    );
    fixture.detectChanges();
    type(
      fixture,
      element(fixture).querySelector(
        'input.removal-phrase',
      ) as HTMLInputElement,
      'Homeroom',
    );
    button(fixture, 'Save 2 changes')?.click();
    await vi.waitFor(() => expect(flow.readJob).toHaveBeenCalled(), {
      timeout: 4000,
    });
    await vi.waitFor(() =>
      expect(text(fixture)).toContain(
        'The save continues. This dialog cannot read the result. Close the dialog and open the job.',
      ),
    );
    fixture.detectChanges();
    expect(text(fixture)).toContain('CAT-003');
  });

  it('keeps the submitted info type on the review after a later edit (R10)', async () => {
    const flow = setup();
    let release!: (value: { ok: true; plan: typeof addedPlan }) => void;
    const held = new Promise<{ ok: true; plan: typeof addedPlan }>(
      (resolve) => {
        release = resolve;
      },
    );
    flow.prepare.mockReturnValueOnce(held);
    const fixture = render('create');
    type(fixture, nameField(fixture), 'Transportation');
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 1'),
      'Counselor',
    );
    button(fixture, 'Review changes')?.click();
    fixture.detectChanges();
    const editor = fixture.componentInstance as unknown as {
      setType(row: unknown, value: string): void;
      visibleRows(): unknown[];
    };
    editor.setType(editor.visibleRows()[0], 'EMAIL');
    fixture.detectChanges();
    release({ ok: true, plan: addedPlan });
    await vi.waitFor(() => expect(text(fixture)).toContain('Counselor'));
    fixture.detectChanges();
    expect(text(fixture)).toContain('Counselor (Text)');
    expect(text(fixture)).not.toContain('Counselor (Email)');
    expect(flow.prepare.mock.calls[0][0].draft.fields[0].fieldType).toBe(
      'STRING',
    );
  });

  it('draws each error below its control and names the edit subtitle (R11, R12)', () => {
    setup();
    const fixture = render('create');
    type(fixture, nameField(fixture), 'Transportation');
    type(
      fixture,
      mustField(fixture, 'Display name for attribute 1'),
      'Bus route',
    );
    type(
      fixture,
      mustField(fixture, 'Attribute name for attribute 1'),
      'Stop #',
    );
    button(fixture, 'Review changes')?.click();
    fixture.detectChanges();
    const nameError = [
      ...element(fixture).querySelectorAll('.field-error'),
    ].find(
      (item) =>
        item.textContent?.trim() === 'Use letters, digits, _ and - only.',
    );
    expect(nameError).toBeDefined();
    const nameFieldElement = mustField(
      fixture,
      'Attribute name for attribute 1',
    ).closest('mat-form-field');
    expect(nameFieldElement?.classList.contains('field-invalid')).toBe(true);
    expect(nameFieldElement?.querySelector('.field-error')).toBeNull();
    expect(nameError?.closest('mat-form-field')).toBeNull();
    // The category field draws the same boundary.
    type(
      fixture,
      mustField(fixture, 'Attribute name for attribute 1'),
      'BusRoute',
    );
    expect(nameFieldElement?.classList.contains('field-invalid')).toBe(false);
  });

  it('draws the category display name under the edit title (R12)', () => {
    setup();
    const fixture = render('edit', { category });
    expect(
      element(fixture)
        .querySelector('#category-editor-sub')
        ?.textContent?.trim(),
    ).toBe('Student information');
    expect(
      element(fixture)
        .querySelector('#category-editor-title')
        ?.textContent?.trim(),
    ).toBe('Edit category');
  });

  it('strikes every removed value and keeps its counts (R11, CA state 04)', () => {
    setup();
    const fixture = render('edit', { category });
    button(fixture, 'Remove attribute Homeroom')?.click();
    fixture.detectChanges();
    const struck = [
      ...element(fixture).querySelectorAll('tr.is-removed .is-struck'),
    ].map((item) => item.textContent?.trim());
    expect(struck).toEqual(['Homeroom', 'Text', 'Admins and the user']);
    expect(text(fixture)).toContain('Removes values from 4 users');
  });

  it('draws the range line under a number row and sends two bounds (states 13 and 15)', async () => {
    const flow = setup();
    flow.prepare.mockResolvedValue({ ok: true, plan: rangePlan });
    const fixture = render('edit', { category });
    expect(field(fixture, 'Grade level minimum')).not.toBeNull();
    expect(field(fixture, 'Grade level maximum')).not.toBeNull();
    // A Text row carries no range line (composition choice 1).
    expect(field(fixture, 'Homeroom minimum')).toBeNull();
    type(fixture, mustField(fixture, 'Grade level minimum'), '0');
    type(fixture, mustField(fixture, 'Grade level maximum'), '12');
    // Both changed bounds take the pending surface of state 12.
    expect(element(fixture).querySelectorAll('.is-changed')).toHaveLength(2);

    button(fixture, 'Review changes')?.click();
    await vi.waitFor(() =>
      expect(text(fixture)).toContain('1 change to Student information'),
    );
    fixture.detectChanges();
    const request = flow.prepare.mock.calls[0][0] as {
      draft: {
        fields: {
          fieldId: string | null;
          numericIndexingSpec: unknown;
        }[];
      };
    };
    const grade = request.draft.fields.find(
      (item) => item.fieldId === 'Student.GradeLevel',
    );
    expect(grade?.numericIndexingSpec).toEqual({
      minValue: 0,
      maxValue: 12,
    });
    // State 15: the Set range row, its phrase, and the effect.
    expect(text(fixture)).toContain('Set range');
    expect(text(fixture)).toContain('Grade level 0 to 12');
    expect(text(fixture)).toContain('No user values change');
    // Composition choice 9: a range change has no typed phrase gate.
    expect(
      element(fixture).querySelectorAll('input.removal-phrase'),
    ).toHaveLength(0);
    expect(button(fixture, 'Save 1 change')?.disabled).toBe(false);
  });

  it('marks both range errors and counts the fields (state 14)', () => {
    const flow = setup();
    const fixture = render('edit', { category: rangeCategory });
    type(fixture, mustField(fixture, 'Grade level minimum'), '12');
    type(fixture, mustField(fixture, 'Grade level maximum'), '0');
    type(fixture, mustField(fixture, 'Graduation year minimum'), '2026.5');
    button(fixture, 'Review changes')?.click();
    fixture.detectChanges();
    expect(text(fixture)).toContain('Enter 12 or more.');
    expect(text(fixture)).toContain('Enter a whole number.');
    expect(text(fixture)).toContain('2 fields have errors');
    expect(
      mustField(fixture, 'Grade level maximum').getAttribute('aria-invalid'),
    ).toBe('true');
    expect(
      mustField(fixture, 'Grade level minimum').getAttribute('aria-invalid'),
    ).not.toBe('true');
    expect(
      mustField(fixture, 'Graduation year minimum').getAttribute(
        'aria-invalid',
      ),
    ).toBe('true');
    expect(button(fixture, 'Review changes')?.disabled).toBe(true);
    expect(flow.prepare).not.toHaveBeenCalled();
  });

  it('sends one bound and reviews it (R2)', async () => {
    const flow = setup();
    flow.prepare.mockResolvedValue({ ok: true, plan: rangePlan });
    const fixture = render('edit', { category });
    type(fixture, mustField(fixture, 'Grade level minimum'), '12');
    button(fixture, 'Review changes')?.click();
    await vi.waitFor(() =>
      expect(text(fixture)).toContain('1 change to Student information'),
    );
    fixture.detectChanges();
    const request = flow.prepare.mock.calls[0][0] as {
      draft: {
        fields: {
          fieldId: string | null;
          numericIndexingSpec: unknown;
        }[];
      };
    };
    expect(
      request.draft.fields.find((item) => item.fieldId === 'Student.GradeLevel')
        ?.numericIndexingSpec,
    ).toEqual({ minValue: 12, maxValue: null });
    expect(text(fixture)).toContain('Grade level 12 or more');
  });

  it('clears a saved range and reviews no bound (C3)', async () => {
    const flow = setup();
    flow.prepare.mockResolvedValue({ ok: true, plan: rangePlan });
    const fixture = render('edit', { category: rangedCategory });
    // A range stays editable after the first save (composition choice 2).
    const min = mustField(fixture, 'Grade level minimum');
    expect(min.tagName).toBe('INPUT');
    expect(min.value).toBe('0');
    expect(mustField(fixture, 'Grade level maximum').value).toBe('12');
    type(fixture, min, '');
    type(fixture, mustField(fixture, 'Grade level maximum'), '');

    button(fixture, 'Review changes')?.click();
    await vi.waitFor(() =>
      expect(text(fixture)).toContain('1 change to Student information'),
    );
    fixture.detectChanges();
    const request = flow.prepare.mock.calls[0][0] as {
      draft: {
        fields: {
          fieldId: string | null;
          numericIndexingSpec: unknown;
        }[];
      };
    };
    // A cleared range sends no bound. The named range replaces the cached one.
    expect(
      request.draft.fields.find((item) => item.fieldId === 'Student.GradeLevel')
        ?.numericIndexingSpec,
    ).toEqual({ minValue: null, maxValue: null });
    expect(text(fixture)).toContain('Grade level with no range');
  });

  it('adds the range line when a new row becomes a number (composition choice 1)', () => {
    setup();
    const fixture = render('create');
    expect(field(fixture, 'Attribute 1 minimum')).toBeNull();
    const editor = fixture.componentInstance as unknown as {
      setType(row: unknown, value: string): void;
      visibleRows(): unknown[];
    };
    editor.setType(editor.visibleRows()[0], 'INT64');
    fixture.detectChanges();
    expect(field(fixture, 'Attribute 1 minimum')).not.toBeNull();
    editor.setType(editor.visibleRows()[0], 'DOUBLE');
    fixture.detectChanges();
    expect(field(fixture, 'Attribute 1 maximum')).not.toBeNull();
    editor.setType(editor.visibleRows()[0], 'STRING');
    fixture.detectChanges();
    expect(field(fixture, 'Attribute 1 minimum')).toBeNull();
  });
});
