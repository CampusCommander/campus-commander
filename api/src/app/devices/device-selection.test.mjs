import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SelectionBusyError,
  SelectionTooLargeError,
  applySelectionOps,
  changeSelection,
  emptySelection,
  parseSelection,
  selectionSpec,
  selectionStorageKey,
} from './device-selection.ts';

const hs04 = [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }];
const lenovo = [{ field: 'model', operator: 'contains', value: 'Lenovo' }];
const none = async () => [];

test('select and deselect move devices between additions and exceptions', async () => {
  let state = await applySelectionOps(
    emptySelection(),
    [{ op: 'select', ids: ['d1', 'd2'] }],
    none,
  );
  assert.deepEqual(state, {
    terms: [],
    groups: [],
    additions: ['d1', 'd2'],
    exceptions: [],
  });
  state = await applySelectionOps(
    state,
    [{ op: 'deselect', ids: ['d1'] }],
    none,
  );
  assert.deepEqual(state, {
    terms: [],
    groups: [],
    additions: ['d2'],
    exceptions: [],
  });
});

test('Select All keeps earlier terms and clears only the exceptions in its scope', async () => {
  const calls = [];
  const matching = async (predicates, ids) => {
    calls.push([predicates, ids]);
    return ids.filter((id) => id === 'd1');
  };
  const state = await applySelectionOps(
    { terms: [lenovo], additions: [], exceptions: ['d1', 'd7'] },
    [
      { op: 'selectAll', predicates: hs04 },
      { op: 'selectAll', predicates: hs04 },
    ],
    matching,
  );
  assert.deepEqual(calls[0], [hs04, ['d1', 'd7']]);
  assert.deepEqual(state.terms, [lenovo, hs04]);
  assert.deepEqual(state.exceptions, ['d7']);
});

test('deselecting under a filter term records an exception', async () => {
  const state = await applySelectionOps(
    { terms: [hs04], additions: [], exceptions: [] },
    [
      { op: 'deselect', ids: ['d1'] },
      { op: 'select', ids: ['d2'] },
    ],
    none,
  );
  assert.deepEqual(state, {
    terms: [hs04],
    groups: [],
    additions: ['d2'],
    exceptions: ['d1'],
  });
  assert.deepEqual(
    await applySelectionOps(state, [{ op: 'deselectAll' }], none),
    emptySelection(),
  );
});

test('a selection beyond its bounds is refused', async () => {
  const terms = Array.from({ length: 50 }, (_, index) => [
    { field: 'model', operator: 'equals', value: `m${index}` },
  ]);
  await assert.rejects(
    applySelectionOps(
      { terms, additions: [], exceptions: [] },
      [{ op: 'selectAll', predicates: hs04 }],
      none,
    ),
    SelectionTooLargeError,
  );
});

test('selections belong to one person, grid, and tab', () => {
  assert.equal(
    selectionStorageKey('person-1', { gridId: 'devices', tabId: 't1' }),
    'cc:device-selection:person-1:devices:t1',
  );
});

test('a missing or unreadable stored selection reads as empty', () => {
  assert.deepEqual(parseSelection(null), {
    state: emptySelection(),
    expiredAt: null,
  });
  assert.deepEqual(parseSelection('{bad'), {
    state: emptySelection(),
    expiredAt: null,
  });
  assert.deepEqual(parseSelection(JSON.stringify({ terms: 'x' })), {
    state: emptySelection(),
    expiredAt: null,
  });
});

test('a selection last changed 13 hours ago reads as expired', () => {
  const changedAt = '2026-10-18T00:00:00.000Z';
  const now = Date.parse(changedAt) + 13 * 60 * 60 * 1000;
  const parsed = parseSelection(
    JSON.stringify({
      terms: [[]],
      groups: [],
      additions: ['d1'],
      exceptions: [],
      changedAt,
    }),
    now,
  );
  assert.deepEqual(parsed.state, emptySelection());
  assert.equal(parsed.expiredAt, '2026-10-18T12:00:00.000Z');
});

test('a selection changed 11 hours ago stays current', () => {
  const changedAt = '2026-10-18T00:00:00.000Z';
  const parsed = parseSelection(
    JSON.stringify({
      terms: [[]],
      groups: [],
      additions: ['d1'],
      exceptions: [],
      changedAt,
    }),
    Date.parse(changedAt) + 11 * 60 * 60 * 1000,
  );
  assert.deepEqual(parsed.state.additions, ['d1']);
  assert.equal(parsed.expiredAt, null);
});

test('the first change after expiry starts from empty and clears the marker', async () => {
  const changedAt = '2026-10-18T00:00:00.000Z';
  const expired = JSON.stringify({
    terms: [[]],
    groups: [],
    additions: ['d1'],
    exceptions: [],
    changedAt,
  });
  const writes = [];
  const cache = {
    get: async () => expired,
    swap: async (key, expected, value, seconds) => {
      writes.push({ key, expected, value, seconds });
      return true;
    },
  };
  const state = await changeSelection(cache, 'k', (current) =>
    applySelectionOps(current, [{ op: 'select', ids: ['d9'] }], none),
  );
  assert.deepEqual(state.additions, ['d9']);
  assert.match(state.changedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(writes[0].expected, expired);
  assert.equal(writes[0].seconds, 129_600);
});

test('the selection spec carries the expiry time', () => {
  assert.equal(
    selectionSpec(emptySelection(), 0, '2026-10-18T12:00:00.000Z')
      .expiredAt,
    '2026-10-18T12:00:00.000Z',
  );
  assert.equal(selectionSpec(emptySelection(), 0).expiredAt, null);
});

test('a concurrent change makes the write retry from the newer value', async () => {
  const stored = [
    JSON.stringify({ terms: [], additions: ['d1'], exceptions: [] }),
    JSON.stringify({ terms: [], additions: ['d1', 'd5'], exceptions: [] }),
  ];
  let reads = 0;
  const writes = [];
  const cache = {
    get: async () => stored[Math.min(reads++, 1)],
    swap: async (key, expected, value, seconds) => {
      writes.push({ key, expected, value, seconds });
      return writes.length === 2;
    },
  };
  const state = await changeSelection(cache, 'k', (current) =>
    applySelectionOps(current, [{ op: 'select', ids: ['d2'] }], none),
  );
  assert.deepEqual(state.additions, ['d1', 'd5', 'd2']);
  assert.equal(writes[1].expected, stored[1]);
  assert.equal(writes[1].seconds, 129_600);
});

test('a selection that keeps changing underneath reports busy', async () => {
  const cache = { get: async () => null, swap: async () => false };
  await assert.rejects(
    changeSelection(cache, 'k', async (state) => state),
    SelectionBusyError,
  );
});

test('the spec reports terms and counts without device IDs', () => {
  assert.deepEqual(
    selectionSpec(
      {
        terms: [hs04],
        groups: [],
        additions: ['d2'],
        exceptions: ['d1', 'd3'],
      },
      95,
    ),
    {
      terms: [{ type: 'all', predicates: hs04 }],
      groups: [],
      added: 1,
      excluded: 2,
      selectedCount: 95,
    },
  );
});

const replaceSoon = {
  predicates: hs04,
  by: ['battery'],
  route: ['replace-soon'],
};

test('selecting a group clears the exceptions inside it and keeps its filters', async () => {
  const calls = [];
  const matching = async (predicates, ids, group) => {
    calls.push([predicates, ids, group]);
    return ['d1'];
  };
  const state = await applySelectionOps(
    { terms: [lenovo], groups: [], additions: [], exceptions: ['d1', 'd7'] },
    [
      { op: 'selectGroup', ...replaceSoon },
      { op: 'selectGroup', ...replaceSoon },
    ],
    matching,
  );
  assert.deepEqual(calls[0], [
    hs04,
    ['d1', 'd7'],
    { by: ['battery'], keys: ['replace-soon'] },
  ]);
  assert.deepEqual(state.groups, [replaceSoon]);
  assert.deepEqual(state.exceptions, ['d7']);
});

test('deselecting a group inside Select All excepts only that group', async () => {
  const asked = [];
  const selectedIn = async (state, predicates, group) => {
    asked.push([state.groups.length, predicates, group]);
    return ['d2', 'd3'];
  };
  const state = await applySelectionOps(
    {
      terms: [[]],
      groups: [replaceSoon],
      additions: ['d3', 'd8'],
      exceptions: [],
    },
    [{ op: 'deselectGroup', ...replaceSoon }],
    none,
    selectedIn,
  );
  // The exact group term goes first, then its remaining devices become exceptions.
  assert.deepEqual(asked, [
    [0, hs04, { by: ['battery'], keys: ['replace-soon'] }],
  ]);
  assert.deepEqual(state, {
    terms: [[]],
    groups: [],
    additions: ['d8'],
    exceptions: ['d2', 'd3'],
  });
});

test('a deselected group without any term leaves no exceptions', async () => {
  const state = await applySelectionOps(
    { terms: [], groups: [replaceSoon], additions: [], exceptions: [] },
    [{ op: 'deselectGroup', ...replaceSoon }],
    none,
    async () => ['d2'],
  );
  assert.deepEqual(state, emptySelection());
});

test('the spec reports selected groups', () => {
  assert.deepEqual(
    selectionSpec(
      { terms: [], groups: [replaceSoon], additions: [], exceptions: [] },
      29,
    ).groups,
    [replaceSoon],
  );
});
