import { describe, expect, it } from 'vitest';
import type {
  UserAttributeEdit,
  UserAttributePreview,
} from '@campus/application-contracts';
import { UserAttributeConfirmationStore } from './user-attribute-confirmation';

const previewId = '11111111-1111-4111-8111-111111111111';
const secondPreviewId = '33333333-3333-4333-8333-333333333333';

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

describe('the attribute confirmation store', () => {
  it('hands the retained edit list to the confirmation and releases the handoff (R3-B)', () => {
    const store = new UserAttributeConfirmationStore();
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
    const store = new UserAttributeConfirmationStore();
    const edits = [edit('1100000000000000001', 11)];
    store.retainEdits(previewId, edits);
    store.begin('grid:tab', preview(), ['Grade level']);
    store.uncertain(
      'grid:tab',
      preview(),
      ['Grade level'],
      'The answer is unknown.',
    );
    expect(store.pending('grid:tab')?.edits).toEqual(edits);
    store.accept('grid:tab', preview(), ['Grade level'], 'UAT-014');
    expect(store.pending('grid:tab')?.edits).toEqual(edits);
    // A definite refusal rewrites the same frozen list.
    store.refuse(
      'grid:tab',
      preview(),
      ['Grade level'],
      'The preview changed.',
    );
    expect(store.pending('grid:tab')?.edits).toEqual(edits);
  });

  it('does not truncate a save when its handoff list is released (R3-B)', () => {
    const store = new UserAttributeConfirmationStore();
    const edits = [edit('1100000000000000001', 11)];
    store.retainEdits(previewId, edits);
    store.begin('grid:tab', preview(), ['Grade level']);
    store.discardEdits(previewId);
    store.accept('grid:tab', preview(), ['Grade level'], 'UAT-014');
    expect(store.pending('grid:tab')?.edits).toEqual(edits);
  });

  it('drops the entry and the handoff when a receipt resolves (R3-B)', () => {
    const store = new UserAttributeConfirmationStore();
    store.retainEdits(previewId, [edit('1100000000000000001', 11)]);
    store.begin('grid:tab', preview(), ['Grade level']);
    store.accept('grid:tab', preview(), ['Grade level'], 'UAT-014');
    store.resolveReceipt('UAT-014');
    expect(store.pending('grid:tab')).toBeNull();
    expect(store.editsFor(previewId)).toEqual([]);
  });

  it('releases the handoff of a dismissed or replaced preview (R3-B)', () => {
    const store = new UserAttributeConfirmationStore();
    store.retainEdits(previewId, [edit('1100000000000000001', 11)]);
    store.retainEdits(secondPreviewId, [edit('1100000000000000001', 12)]);
    store.discardEdits(previewId);
    expect(store.editsFor(previewId)).toEqual([]);
    // The other prepared preview still holds its own list.
    expect(store.editsFor(secondPreviewId)).toHaveLength(1);
    store.discardEdits(secondPreviewId);
    expect(store.editsFor(secondPreviewId)).toEqual([]);
  });
});
