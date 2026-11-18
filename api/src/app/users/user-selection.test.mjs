import assert from 'node:assert/strict';
import test from 'node:test';
import { userQuerySchema } from '@campus/application-contracts';
import {
  USER_SELECTION_SECONDS,
  UserSelectionBusyError,
  UserSelectionTooLargeError,
  applyUserSelectionOps,
  changeUserSelection,
  emptyUserSelection,
  hasUserSelection,
  parseUserSelection,
  userSelectionSpec,
  userSelectionStorageKey,
} from './user-selection.ts';

const at = Date.parse('2026-11-17T12:00:00.000Z');
const hoursAgo = (hours) => new Date(at - hours * 3_600_000).toISOString();
const active = [{ field: 'status', operator: 'is', values: ['active'] }];

test('a selection read after twelve hours is empty and names its expiry', () => {
  const raw = JSON.stringify({
    terms: [active],
    additions: ['u1'],
    exceptions: [],
    changedAt: hoursAgo(13),
  });
  const parsed = parseUserSelection(raw, at);
  assert.deepEqual(parsed.state, emptyUserSelection());
  assert.equal(
    parsed.expiredAt,
    new Date(at - 13 * 3_600_000 + USER_SELECTION_SECONDS * 1000).toISOString(),
  );
  assert.equal(parsed.state.terms.length, 0);
  assert.equal(hasUserSelection(parsed.state), false);
});

test('a selection just short of twelve hours still counts', () => {
  const raw = JSON.stringify({
    terms: [active],
    additions: ['u1'],
    exceptions: [],
    changedAt: hoursAgo(11.9),
  });
  const parsed = parseUserSelection(raw, at);
  assert.equal(parsed.expiredAt, null);
  assert.equal(parsed.state.terms.length, 1);
  assert.deepEqual(parsed.state.additions, ['u1']);
  assert.equal(hasUserSelection(parsed.state), true);
});

test('a missing or unreadable selection is empty and current', () => {
  assert.deepEqual(parseUserSelection(null, at).state, emptyUserSelection());
  assert.equal(parseUserSelection(null, at).expiredAt, null);
  assert.deepEqual(parseUserSelection('{oops', at).state, emptyUserSelection());
  assert.deepEqual(
    parseUserSelection('{"terms":"no"}', at).state,
    emptyUserSelection(),
  );
});

test('select all adds one term and a repeat adds nothing', async () => {
  const once = await applyUserSelectionOps(emptyUserSelection(), [
    { op: 'selectAll', predicates: active },
  ]);
  assert.equal(once.terms.length, 1);
  const twice = await applyUserSelectionOps(once, [
    { op: 'selectAll', predicates: active },
  ]);
  assert.equal(twice.terms.length, 1);
  const other = await applyUserSelectionOps(twice, [
    {
      op: 'selectAll',
      predicates: [
        {
          field: 'attribute',
          schemaName: 'StudentInfo',
          fieldName: 'Homeroom',
          operator: 'equals',
          value: 'B12',
        },
      ],
    },
  ]);
  assert.equal(other.terms.length, 2);
});

test('select removes an exception that the same ID held', async () => {
  const state = await applyUserSelectionOps(
    { terms: [active], additions: [], exceptions: ['u1'] },
    [{ op: 'select', ids: ['u1', 'u2'] }],
  );
  assert.deepEqual(state.additions, ['u1', 'u2']);
  assert.deepEqual(state.exceptions, []);
});

test('deselect records an exception only when a filter term can still match', async () => {
  const withTerm = await applyUserSelectionOps(
    { terms: [active], additions: ['u1', 'u2'], exceptions: [] },
    [{ op: 'deselect', ids: ['u1'] }],
  );
  assert.deepEqual(withTerm.additions, ['u2']);
  assert.deepEqual(withTerm.exceptions, ['u1']);
  const withoutTerm = await applyUserSelectionOps(
    { terms: [], additions: ['u1', 'u2'], exceptions: [] },
    [{ op: 'deselect', ids: ['u1'] }],
  );
  assert.deepEqual(withoutTerm.additions, ['u2']);
  assert.deepEqual(withoutTerm.exceptions, []);
});

test('deselect all empties the selection', async () => {
  const state = await applyUserSelectionOps(
    { terms: [active], additions: ['u1'], exceptions: ['u2'] },
    [{ op: 'deselectAll' }],
  );
  assert.deepEqual(state, emptyUserSelection());
});

test('select all drops an exception that the new term matches', async () => {
  const asked = [];
  const state = await applyUserSelectionOps(
    { terms: [], additions: [], exceptions: ['u1', 'u9'] },
    [{ op: 'selectAll', predicates: active }],
    async (predicates, ids) => {
      asked.push([predicates, ids]);
      return ['u1'];
    },
  );
  assert.deepEqual(state.exceptions, ['u9']);
  assert.deepEqual(asked, [[active, ['u1', 'u9']]]);
});

test('a selection over the term bound is refused', async () => {
  const terms = Array.from({ length: 50 }, (_, index) => [
    { field: 'title', operator: 'equals', value: `T${index}` },
  ]);
  await assert.doesNotReject(
    applyUserSelectionOps(emptyUserSelection(), [
      { op: 'selectAll', predicates: terms[0] },
    ]),
  );
  let refused;
  try {
    await applyUserSelectionOps({ terms, additions: [], exceptions: [] }, [
      { op: 'selectAll', predicates: active },
    ]);
  } catch (error) {
    refused = error;
  }
  assert.equal(refused instanceof UserSelectionTooLargeError, true);
});

test('a change retries a lost swap and stores the change time', async () => {
  let attempts = 0;
  const stored = new Map();
  const cache = {
    async get(key) {
      return stored.get(key) ?? null;
    },
    async swap(key, expected, value) {
      attempts += 1;
      if (attempts === 1) return false;
      if ((stored.get(key) ?? null) !== expected) return false;
      stored.set(key, value);
      return true;
    },
  };
  const state = await changeUserSelection(
    cache,
    userSelectionStorageKey('p1', { gridId: 'users', tabId: 't1' }),
    async (current) =>
      applyUserSelectionOps(current, [{ op: 'select', ids: ['u1'] }]),
  );
  assert.equal(attempts, 2);
  assert.deepEqual(state.additions, ['u1']);
  assert.equal(typeof state.changedAt, 'string');
});

test('a change that never wins the swap reports a busy selection', async () => {
  const cache = {
    async get() {
      return null;
    },
    async swap() {
      return false;
    },
  };
  await assert.rejects(
    changeUserSelection(cache, 'cc:user-selection:p1:users:t1', async (s) => s),
    (error) => error instanceof UserSelectionBusyError,
  );
});

test('the first change after expiry starts from empty', async () => {
  const key = 'cc:user-selection:p1:users:t1';
  const stored = new Map([
    [
      key,
      JSON.stringify({
        terms: [active],
        additions: ['old'],
        exceptions: [],
        changedAt: hoursAgo(30),
      }),
    ],
  ]);
  const cache = {
    async get(k) {
      return stored.get(k) ?? null;
    },
    async swap(k, expected, value) {
      if ((stored.get(k) ?? null) !== expected) return false;
      stored.set(k, value);
      return true;
    },
  };
  const state = await changeUserSelection(cache, key, async (current) =>
    applyUserSelectionOps(current, [{ op: 'select', ids: ['u1'] }]),
  );
  assert.deepEqual(state.additions, ['u1']);
  assert.equal(state.terms.length, 0);
});

test('the storage key keeps one grid of one person apart', () => {
  assert.equal(
    userSelectionStorageKey('p1', { gridId: 'users', tabId: 't1' }),
    'cc:user-selection:p1:users:t1',
  );
});

test('the answer names the term count and the stored counts', () => {
  const spec = userSelectionSpec(
    { terms: [active, active], additions: ['u1', 'u2'], exceptions: ['u3'] },
    7,
    '2026-11-17T00:00:00.000Z',
  );
  assert.equal(spec.terms.length, 2);
  assert.equal(spec.terms[0].type, 'all');
  assert.equal(spec.added, 2);
  assert.equal(spec.excluded, 1);
  assert.equal(spec.selectedCount, 7);
  assert.equal(spec.expiredAt, '2026-11-17T00:00:00.000Z');
});

test('the selection predicates satisfy the query contract', () => {
  const parsed = userQuerySchema.parse({
    predicates: active,
    selection: {
      gridId: 'users',
      tabId: '0b8b0c1e-2f3a-4c5d-8e9f-0a1b2c3d4e5f',
    },
  });
  assert.equal(parsed.selection.gridId, 'users');
  assert.equal(parsed.limit, 100);
});
