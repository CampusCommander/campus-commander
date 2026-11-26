import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  UserAttributeEdit,
  UserAttributePreview,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import {
  USER_ATTRIBUTE_CONFIRMATION_PREFIX,
  UserAttributeConfirmationStore,
} from './user-attribute-confirmation';

const principal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherPrincipal = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const previewId = '11111111-1111-4111-8111-111111111111';
const secondPreviewId = '33333333-3333-4333-8333-333333333333';

interface TestSession {
  identity: { id: string };
}

let session: ReturnType<typeof signal<TestSession | null>>;

function preview(id = previewId): UserAttributePreview {
  return {
    previewId: id,
    source: 'edit-list',
    changes: null,
    attributeChanges: 2,
    selected: 2,
    eligible: 2,
    unchanged: 0,
    conflicts: 0,
    oldestObservedAt: '2026-11-16T12:00:00.000Z',
    stale: false,
    preparedAt: '2026-11-16T12:00:00.000Z',
    expiresAt: '2026-11-16T12:10:00.000Z',
    manifestDigest: 'a'.repeat(64),
  };
}

function edit(userId: string, value: number): UserAttributeEdit {
  return {
    userId,
    attribute: 'attr:Student.grade_level',
    mode: 'set',
    values: [value],
    baselineValue: 9,
  };
}

function keyOf(scope: string, person = principal): string {
  return `${USER_ATTRIBUTE_CONFIRMATION_PREFIX}${person}.${scope}`;
}

/** The store of one page load: a reload constructs it again over the same tab storage. */
function pageStore(): UserAttributeConfirmationStore {
  return TestBed.runInInjectionContext(
    () => new UserAttributeConfirmationStore(),
  );
}

beforeEach(() => {
  sessionStorage.clear();
  session = signal<TestSession | null>({ identity: { id: principal } });
  TestBed.configureTestingModule({
    providers: [{ provide: AuthStore, useValue: { session } }],
  });
});

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('the attribute confirmation store', () => {
  it('hands the retained edit list to the confirmation and releases the handoff (R3-B)', () => {
    const store = pageStore();
    const edits = [
      edit('1100000000000000001', 11),
      edit('1100000000000000002', 10),
    ];
    store.retainEdits(previewId, edits);
    store.begin('grid:tab', preview(), ['Grade level']);
    // The entry owns the frozen list.
    expect(store.pending('grid:tab')?.edits).toEqual(edits);
    // The handoff copy has no other reader.
    expect(store.editsFor(previewId)).toEqual([]);
  });

  it('keeps the frozen list through uncertain, accept, and refuse (R3-B)', () => {
    const store = pageStore();
    const edits = [edit('1100000000000000001', 11)];
    store.retainEdits(previewId, edits);
    const submittedBy = store.begin('grid:tab', preview(), ['Grade level']);
    store.uncertain(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'The answer is unknown.',
    );
    expect(store.pending('grid:tab')?.edits).toEqual(edits);
    store.accept(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'UAT-014',
    );
    expect(store.pending('grid:tab')?.edits).toEqual(edits);
    // A definite refusal rewrites the same frozen list.
    store.refuse(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'The preview changed.',
    );
    expect(store.pending('grid:tab')?.edits).toEqual(edits);
  });

  it('does not truncate a save when its handoff list is released (R3-B)', () => {
    const store = pageStore();
    const edits = [edit('1100000000000000001', 11)];
    store.retainEdits(previewId, edits);
    const submittedBy = store.begin('grid:tab', preview(), ['Grade level']);
    store.discardEdits(previewId);
    store.accept(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'UAT-014',
    );
    expect(store.pending('grid:tab')?.edits).toEqual(edits);
  });

  it('drops the entry and the handoff when a receipt resolves (R3-B)', () => {
    const store = pageStore();
    store.retainEdits(previewId, [edit('1100000000000000001', 11)]);
    const submittedBy = store.begin('grid:tab', preview(), ['Grade level']);
    store.accept(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'UAT-014',
    );
    store.resolveReceipt('UAT-014');
    expect(store.pending('grid:tab')).toBeNull();
    expect(store.editsFor(previewId)).toEqual([]);
  });

  it('releases the handoff of a dismissed or replaced preview (R3-B)', () => {
    const store = pageStore();
    store.retainEdits(previewId, [edit('1100000000000000001', 11)]);
    store.retainEdits(secondPreviewId, [edit('1100000000000000001', 12)]);
    store.discardEdits(previewId);
    expect(store.editsFor(previewId)).toEqual([]);
    // The other prepared preview still holds its own list.
    expect(store.editsFor(secondPreviewId)).toHaveLength(1);
    store.discardEdits(secondPreviewId);
    expect(store.editsFor(secondPreviewId)).toEqual([]);
  });

  it('stores a confirmation before its first send and replays it after a reload (K25)', () => {
    const store = pageStore();
    const edits = [edit('1100000000000000001', 11)];
    store.retainEdits(previewId, edits);
    const submittedBy = store.begin('grid:tab', preview(), ['Grade level']);
    store.uncertain(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'Cannot reach Campus Commander.',
    );

    // The tab keeps the frozen identity, and a reload constructs a new store over it.
    const reloaded = pageStore();
    const entry = reloaded.pending('grid:tab');
    expect(entry?.preview.previewId).toBe(previewId);
    expect(entry?.preview.manifestDigest).toBe('a'.repeat(64));
    expect(entry?.phase).toBe('uncertain');
    expect(entry?.attributeNames).toEqual(['Grade level']);
    expect(entry?.edits).toEqual(edits);
    expect(reloaded.restored('grid:tab')).toBe(true);
    expect(reloaded.isPending(previewId)).toBe(true);
  });

  it('stores an accepted receipt until its job answers (K27)', () => {
    const store = pageStore();
    const submittedBy = store.begin('bulk-selection:users:tab', preview(), [
      'Homeroom',
    ]);
    store.accept(
      submittedBy,
      'bulk-selection:users:tab',
      preview(),
      ['Homeroom'],
      'UAT-014',
    );

    const reloaded = pageStore();
    expect(reloaded.pending('bulk-selection:users:tab')).toMatchObject({
      phase: 'accepted',
      displayId: 'UAT-014',
    });

    reloaded.resolveReceipt('UAT-014');
    expect(reloaded.pending('bulk-selection:users:tab')).toBeNull();
    // A settled job removes the stored record too.
    expect(pageStore().pending('bulk-selection:users:tab')).toBeNull();
  });

  it('keeps a confirmation in memory that this page wrote, not a restored one', () => {
    const store = pageStore();
    store.begin('grid:tab', preview(), ['Grade level']);
    expect(store.pending('grid:tab')?.phase).toBe('confirming');
    expect(store.restored('grid:tab')).toBe(false);
  });

  it('clears a malformed record instead of loading it', () => {
    sessionStorage.setItem(keyOf('grid:tab'), '{');
    const store = pageStore();
    expect(store.pending('grid:tab')).toBeNull();
    expect(sessionStorage.getItem(keyOf('grid:tab'))).toBeNull();
  });

  it('clears a record that has valid JSON and an invalid contract field', () => {
    const store = pageStore();
    store.begin('grid:tab', preview(), ['Grade level']);
    const key = keyOf('grid:tab');
    // Valid JSON that the contract refuses: a preview ID that is not a UUID.
    const record = JSON.parse(sessionStorage.getItem(key)!) as {
      preview: { previewId: string };
    };
    record.preview.previewId = 'not-a-uuid';
    sessionStorage.setItem(key, JSON.stringify(record));

    const reloaded = pageStore();
    expect(reloaded.pending('grid:tab')).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('never loads a record whose scope is another user', () => {
    const store = pageStore();
    store.begin('user-a', preview(), ['Grade level']);
    // The same record sits under another user's key.
    sessionStorage.setItem(
      keyOf('user-b'),
      sessionStorage.getItem(keyOf('user-a'))!,
    );

    const reloaded = pageStore();
    expect(reloaded.pending('user-b')).toBeNull();
    expect(sessionStorage.getItem(keyOf('user-b'))).toBeNull();
    expect(reloaded.pending('user-a')?.preview.previewId).toBe(previewId);
  });

  it('never loads another person record from this tab', () => {
    const store = pageStore();
    store.begin('grid:tab', preview(), ['Grade level']);

    session.set({ identity: { id: otherPrincipal } });
    const other = pageStore();
    expect(other.pending('grid:tab')).toBeNull();

    // The same store follows the person who signed in, and drops the earlier entries.
    store.restore();
    expect(store.pending('grid:tab')).toBeNull();

    session.set({ identity: { id: principal } });
    store.restore();
    expect(store.pending('grid:tab')?.preview.previewId).toBe(previewId);
  });

  it('clears a record that another person submitted under this person prefix', () => {
    const store = pageStore();
    store.begin('grid:tab', preview(), ['Grade level']);
    // The first person's record sits under the second person's prefix.
    sessionStorage.setItem(
      keyOf('grid:tab', otherPrincipal),
      sessionStorage.getItem(keyOf('grid:tab'))!,
    );
    session.set({ identity: { id: otherPrincipal } });

    const other = pageStore();
    expect(other.pending('grid:tab')).toBeNull();
    expect(
      sessionStorage.getItem(keyOf('grid:tab', otherPrincipal)),
    ).toBeNull();
  });

  it('keeps a late answer of the same person after ordinary navigation', () => {
    const store = pageStore();
    const submittedBy = store.begin('grid:tab', preview(), ['Grade level']);
    store.uncertain(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'Cannot reach Campus Commander.',
    );

    // The same person reloads or reopens the form: the retained identity answers.
    const reloaded = pageStore();
    expect(reloaded.pending('grid:tab')).toMatchObject({
      submittedBy: principal,
      phase: 'uncertain',
      message: 'Cannot reach Campus Commander.',
    });
  });

  it('never writes an answer of another person under the person who signed in', () => {
    const store = pageStore();
    const submittedBy = store.begin('grid:tab', preview(), ['Grade level']);
    // Another person signs in before the answer arrives.
    session.set({ identity: { id: otherPrincipal } });
    store.restore();
    store.uncertain(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'Cannot reach Campus Commander.',
    );

    expect(store.pending('grid:tab')).toBeNull();
    expect(
      sessionStorage.getItem(keyOf('grid:tab', otherPrincipal)),
    ).toBeNull();
    // The first person's own frozen record waits under that person's prefix.
    expect(sessionStorage.getItem(keyOf('grid:tab'))).not.toBeNull();
    expect(pageStore().pending('grid:tab')).toBeNull();
  });

  it('never replaces the signed-in person confirmation with a late answer of another person', () => {
    const store = pageStore();
    const submittedBy = store.begin('grid:tab', preview(), ['Grade level']);
    session.set({ identity: { id: otherPrincipal } });
    store.restore();
    // The second person starts a confirmation of the same scope.
    store.begin('grid:tab', preview(secondPreviewId), ['Homeroom']);
    store.accept(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'UAT-014',
    );

    expect(store.pending('grid:tab')).toMatchObject({
      userId: 'grid:tab',
      preview: { previewId: secondPreviewId },
      phase: 'confirming',
    });
    expect(pageStore().pending('grid:tab')?.preview.previewId).toBe(
      secondPreviewId,
    );
  });

  it('releases its own person record when a definite answer arrives after a sign-in', () => {
    const store = pageStore();
    const submittedBy = store.begin('grid:tab', preview(), ['Grade level']);
    session.set({ identity: { id: otherPrincipal } });
    store.restore();
    store.refuse(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'The preview changed.',
    );

    // The definite answer removes the first person's record and enters no other one.
    expect(sessionStorage.getItem(keyOf('grid:tab'))).toBeNull();
    expect(store.pending('grid:tab')).toBeNull();
    expect(
      sessionStorage.getItem(keyOf('grid:tab', otherPrincipal)),
    ).toBeNull();
  });

  it('removes the stored record on a definite refusal', () => {
    const store = pageStore();
    const submittedBy = store.begin('grid:tab', preview(), ['Grade level']);
    store.refuse(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'The preview changed.',
    );
    // The refusal keeps its sentence in memory for the next form.
    expect(store.pending('grid:tab')?.phase).toBe('refused');
    expect(sessionStorage.getItem(keyOf('grid:tab'))).toBeNull();
    // A reload starts without the definite answer.
    expect(pageStore().pending('grid:tab')).toBeNull();
  });

  it('removes the stored record when a receipt answers the confirmation', () => {
    const store = pageStore();
    const submittedBy = store.begin('grid:tab', preview(), ['Grade level']);
    store.uncertain(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'Cannot reach Campus Commander.',
    );
    store.resolve(previewId);
    expect(sessionStorage.getItem(keyOf('grid:tab'))).toBeNull();
    expect(pageStore().pending('grid:tab')).toBeNull();
  });

  it('keeps the memory behavior when a blocked storage area refuses writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const store = pageStore();
    const submittedBy = store.begin('grid:tab', preview(), ['Grade level']);
    expect(store.pending('grid:tab')?.phase).toBe('confirming');
    store.uncertain(
      submittedBy,
      'grid:tab',
      preview(),
      ['Grade level'],
      'Cannot reach Campus Commander.',
    );
    expect(store.pending('grid:tab')).toMatchObject({
      phase: 'uncertain',
      message: 'Cannot reach Campus Commander.',
    });
    // A reload has nothing to read, so it starts without a record.
    expect(pageStore().pending('grid:tab')).toBeNull();
  });

  it('keeps the memory behavior when a blocked storage area refuses reads', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const store = pageStore();
    store.begin('grid:tab', preview(), ['Grade level']);
    expect(store.pending('grid:tab')?.phase).toBe('confirming');
    expect(store.restored('grid:tab')).toBe(false);
  });
});
