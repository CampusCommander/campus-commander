import { describe, expect, it, vi } from 'vitest';
import type { UserSelectionSpec } from '@campus/application-contracts';
import {
  UserSelectionProvider,
  selectionScope,
  userSelectionTab,
} from './user-selection';
import type { UserAttributeColumn } from './user-fields';

const takeHome: UserAttributeColumn = {
  id: 'attr:Device.take_home',
  schemaName: 'Device',
  fieldName: 'take_home',
  schemaDisplayName: 'Device information',
  label: 'Take-home approved',
  field: {
    fieldId: 'Device.take_home',
    fieldName: 'take_home',
    displayName: 'Take-home approved',
    fieldType: 'BOOL',
    multiValued: false,
    indexed: true,
    readAccessType: 'ALL_DOMAIN_USERS',
    numericIndexingSpec: null,
    holders: 4,
  },
};
const attributes = [takeHome];

const spec = (extra: Partial<UserSelectionSpec> = {}): UserSelectionSpec => ({
  terms: [{ type: 'all', predicates: [] }],
  added: 0,
  excluded: 0,
  selectedCount: 0,
  expiredAt: null,
  ...extra,
});

const tabId = crypto.randomUUID();
const selection = (body: UserSelectionSpec) =>
  Response.json({ selection: body });

/** A response that the test releases. */
function held<T>() {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A response whose body decodes when the test releases it. */
function decoding(body: () => Promise<unknown>): Response {
  return { ok: true, json: body } as unknown as Response;
}

describe('the selection tab', () => {
  it('reuses the saved tab and creates one when none is valid', () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    };
    const first = userSelectionTab(storage);
    expect(userSelectionTab(storage)).toBe(first);
    saved.set('cc.users.selection-tab', 'not-a-uuid');
    expect(userSelectionTab(storage)).not.toBe('not-a-uuid');
  });
});

describe('the user selection provider', () => {
  it('reads the saved selection and shows its terms as filters', async () => {
    const call = vi.fn().mockResolvedValue(
      selection(
        spec({
          terms: [
            {
              type: 'all',
              predicates: [
                { field: 'status', operator: 'is', values: ['active'] },
              ],
            },
          ],
          selectedCount: 12,
        }),
      ),
    );
    const provider = new UserSelectionProvider(call);
    const answer = await provider.getSpec({ gridId: 'users', tabId });
    expect(call).toHaveBeenCalledWith(
      '/api/users/selection',
      {
        gridId: 'users',
        tabId,
      },
      expect.any(Function),
    );
    expect(answer).toEqual({
      terms: [
        {
          type: 'all',
          filter: { status: { filterType: 'set', values: ['active'] } },
        },
      ],
      selectedCount: 12,
    });
    expect(provider.spec()?.selectedCount).toBe(12);
  });

  it('captures the filters of Select All as predicates', async () => {
    const call = vi.fn().mockResolvedValue(selection(spec()));
    const provider = new UserSelectionProvider(call);
    await provider.applyOps({
      gridId: 'users',
      tabId,
      ops: [
        {
          op: 'selectAll',
          filter: {
            fullName: { filterType: 'text', type: 'contains', filter: 'A' },
          },
        },
      ],
    });
    expect(call).toHaveBeenCalledWith(
      '/api/users/selection/ops',
      {
        gridId: 'users',
        tabId,
        ops: [
          {
            op: 'selectAll',
            predicates: [
              { field: 'fullName', operator: 'contains', value: 'A' },
            ],
          },
        ],
      },
      expect.any(Function),
    );
    expect(provider.revision()).toBe(1);
  });

  it('keeps an alias filter in the Select All predicates (R4)', async () => {
    const call = vi.fn().mockResolvedValue(selection(spec()));
    const provider = new UserSelectionProvider(call, () => ({
      predicates: [
        { field: 'aliases', operator: 'contains', value: 'a.brooks' },
        { field: 'status', operator: 'is', values: ['active'] },
      ],
      attributes: [],
    }));
    await provider.applyOps({
      gridId: 'users',
      tabId,
      ops: [
        {
          op: 'selectAll',
          filter: { status: { filterType: 'set', values: ['active'] } },
        },
      ],
    });
    const body = call.mock.calls[0][1] as {
      ops: { predicates: unknown[] }[];
    };
    expect(body.ops[0].predicates).toEqual([
      { field: 'status', operator: 'is', values: ['active'] },
      { field: 'aliases', operator: 'contains', value: 'a.brooks' },
    ]);
  });

  it('splits a long ID list into batches the endpoint accepts', async () => {
    const call = vi.fn().mockResolvedValue(selection(spec()));
    const provider = new UserSelectionProvider(call);
    const ids = Array.from({ length: 2001 }, (_, index) => `1${index}`);
    await provider.applyOps({
      gridId: 'users',
      tabId,
      ops: [{ op: 'select', ids }],
    });
    expect(call).toHaveBeenCalledTimes(1);
    const bodies = call.mock.calls.map(
      ([, body]) => body as { ops: { ids: string[] }[] },
    );
    expect(bodies[0].ops.map((op) => op.ids.length)).toEqual([2000, 1]);
  });

  it('sends nothing for a set filter with no values (R6)', async () => {
    const call = vi.fn().mockResolvedValue(selection(spec()));
    const provider = new UserSelectionProvider(call, () => ({
      predicates: [],
      attributes,
    }));
    await provider.applyOps({
      gridId: 'users',
      tabId,
      ops: [
        {
          op: 'selectAll',
          filter: {
            [takeHome.id]: { filterType: 'set', values: [] },
          },
        },
      ],
    });
    expect(call).not.toHaveBeenCalled();
    expect(provider.revision()).toBe(0);
  });

  it('stops the later batches of a selection that another person replaced (R1)', async () => {
    const first = held<Response>();
    const call = vi
      .fn()
      .mockResolvedValueOnce(first.promise)
      .mockResolvedValue(selection(spec({ selectedCount: 3 })));
    const provider = new UserSelectionProvider(call);
    // Twenty-character IDs split the list into two request bodies.
    const ids = Array.from(
      { length: 1800 },
      (_, index) => `1100000000000000${String(index).padStart(4, '0')}`,
    );
    const applying = provider.applyOps({
      gridId: 'users',
      tabId,
      ops: [{ op: 'select', ids }],
    });
    provider.reset();
    first.release(selection(spec({ selectedCount: ids.length })));
    await applying;
    expect(call).toHaveBeenCalledTimes(1);
    expect(provider.spec()).toBeNull();
  });

  it('does not let an old read replace a newer selection (R9)', async () => {
    const old = held<Response>();
    const call = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(selection(spec({ selectedCount: 1 })));
    const provider = new UserSelectionProvider(call);
    const reading = provider.getSpec({ gridId: 'users', tabId });
    await provider.applyOps({
      gridId: 'users',
      tabId,
      ops: [{ op: 'select', ids: ['110000000000000000001'] }],
    });
    old.release(selection(spec({ selectedCount: 0 })));
    await reading;
    expect(provider.spec()?.selectedCount).toBe(1);
  });

  it('keeps the newer count when an older read answers last (R9)', async () => {
    const old = held<unknown>();
    const call = vi
      .fn()
      .mockResolvedValueOnce(decoding(() => old.promise))
      .mockResolvedValueOnce(selection(spec({ selectedCount: 0 })));
    const provider = new UserSelectionProvider(call);
    const reading = provider.getSpec({ gridId: 'users', tabId });
    // A newer, expired read replaces the older count before the older read answers.
    const newer = await provider.getSpec({ gridId: 'users', tabId });
    expect(newer.selectedCount).toBe(0);
    old.release({ selection: spec({ selectedCount: 41 }) });
    const last = await reading;
    expect(last.selectedCount).toBe(0);
    expect(provider.spec()?.selectedCount).toBe(0);
  });

  it('drops a read that a reset reached while the body decoded (R1)', async () => {
    const body = held<unknown>();
    const call = vi.fn().mockResolvedValue(decoding(() => body.promise));
    const provider = new UserSelectionProvider(call);
    const reading = provider.getSpec({ gridId: 'users', tabId });
    // The request answered; only the body is still decoding.
    await vi.waitFor(() => expect(call).toHaveBeenCalled());
    provider.reset();
    body.release({ selection: spec({ selectedCount: 41 }) });
    const answer = await reading;
    expect(answer.selectedCount).toBe(0);
    expect(answer.terms).toEqual([]);
    expect(provider.spec()).toBeNull();
  });

  it('drops membership that a reset reached while a batch decoded (R1)', async () => {
    const second = held<unknown>();
    const call = vi
      .fn()
      .mockResolvedValueOnce(
        decoding(async () => ({
          selected: { '110000000000000000001': true },
        })),
      )
      .mockResolvedValueOnce(decoding(() => second.promise));
    const provider = new UserSelectionProvider(call);
    // Twenty-character IDs split the list into two request bodies.
    const ids = Array.from(
      { length: 1800 },
      (_, index) => `1100000000000000${String(index).padStart(4, '0')}`,
    );
    const resolving = provider.resolveSelected({
      gridId: 'users',
      tabId,
      rowIds: ids,
      groupRoutes: [],
    });
    // The first batch accumulated one row before the second batch answered.
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    provider.reset();
    second.release({ selected: { '110000000000000000002': true } });
    // The rows read under the earlier person are not membership of the next one.
    await expect(resolving).resolves.toEqual({});
  });

  it('shows the selection as empty after the API ended it (R10)', () => {
    const provider = new UserSelectionProvider(vi.fn());
    provider.spec.set(spec({ selectedCount: 41 }));
    provider.clear();
    expect(provider.spec()?.selectedCount).toBe(0);
    expect(provider.spec()?.terms).toEqual([]);
  });

  it('resolves the selected rows of the filters on screen', async () => {
    const call = vi
      .fn()
      .mockResolvedValue(
        Response.json({ selected: { '110000000000000000001': true } }),
      );
    const provider = new UserSelectionProvider(call, () => ({
      predicates: [{ field: 'twoStep', operator: 'is', values: ['enrolled'] }],
      attributes: [],
    }));
    const selected = await provider.resolveSelected({
      gridId: 'users',
      tabId,
      rowIds: ['110000000000000000001'],
      groupRoutes: [],
    });
    expect(selected).toEqual({ '110000000000000000001': true });
    expect(call).toHaveBeenCalledWith(
      '/api/users/selection/resolve',
      {
        gridId: 'users',
        tabId,
        rowIds: ['110000000000000000001'],
        predicates: [
          { field: 'twoStep', operator: 'is', values: ['enrolled'] },
        ],
      },
      expect.any(Function),
    );
  });
});

describe('the selection scope line', () => {
  it('names the filter, the added rows, and the excluded rows', () => {
    expect(
      selectionScope(
        spec({
          terms: [
            {
              type: 'all',
              predicates: [
                { field: 'status', operator: 'is', values: ['active'] },
              ],
            },
          ],
          added: 2,
          excluded: 1,
        }),
      ),
    ).toBe('Selected by filter: Status · Active · 2 added · 1 excluded');
  });

  it('names a selection without a filter', () => {
    expect(selectionScope(spec())).toBe('Selected by filter: All users');
  });
});
