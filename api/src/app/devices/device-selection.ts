import { z } from 'zod';
import {
  deviceGroupScopeSchema,
  devicePredicateSchema,
  type DeviceGroupScope,
  type DeviceGrouping,
  type DevicePredicate,
  type DeviceSelectionKey,
  type DeviceSelectionOp,
  type DeviceSelectionSpec,
} from '@campus/application-contracts';

/** A selection expires 12 hours after its last change. */
export const SELECTION_SECONDS = 12 * 60 * 60;
const maxTerms = 50;
const maxIds = 200_000;
const deviceIds = z.array(z.string().min(1).max(128)).max(maxIds);

const selectionStateSchema = z.strictObject({
  terms: z.array(z.array(devicePredicateSchema).max(20)).max(maxTerms),
  groups: z.array(deviceGroupScopeSchema).max(maxTerms).default([]),
  additions: deviceIds,
  exceptions: deviceIds,
});
export type SelectionState = z.infer<typeof selectionStateSchema>;

export class SelectionTooLargeError extends Error {}
export class SelectionBusyError extends Error {}

export function emptySelection(): SelectionState {
  return { terms: [], groups: [], additions: [], exceptions: [] };
}

export function selectionStorageKey(
  identityId: string,
  key: DeviceSelectionKey,
): string {
  // The application Redis user may only touch cc:* keys.
  return `cc:device-selection:${identityId}:${key.gridId}:${key.tabId}`;
}

/** A missing, expired, or unreadable selection is empty. */
export function parseSelection(raw: string | null): SelectionState {
  if (!raw) return emptySelection();
  try {
    const parsed = selectionStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptySelection();
  } catch {
    return emptySelection();
  }
}

const union = (current: readonly string[], ids: readonly string[]) => [
  ...new Set([...current, ...ids]),
];
const sameTerm = (
  a: readonly DevicePredicate[],
  b: readonly DevicePredicate[],
) => JSON.stringify(a) === JSON.stringify(b);

const sameGroup = (a: DeviceGroupScope, b: DeviceGroupScope) =>
  JSON.stringify(a) === JSON.stringify(b);
const openGroup = (scope: DeviceGroupScope): DeviceGrouping => ({
  by: scope.by,
  keys: scope.route,
});

/**
 * Apply one batch of grid selection operations.
 * `matching` returns which of the given devices match a filter, inside a group when one is given.
 * `selectedIn` returns the selected devices inside a filtered group.
 */
export async function applySelectionOps(
  state: SelectionState,
  ops: readonly DeviceSelectionOp[],
  matching: (
    predicates: DevicePredicate[],
    ids: string[],
    group?: DeviceGrouping,
  ) => Promise<string[]>,
  selectedIn: (
    state: SelectionState,
    predicates: DevicePredicate[],
    group: DeviceGrouping,
  ) => Promise<string[]> = async () => [],
): Promise<SelectionState> {
  let { terms, groups = [], additions, exceptions } = state;
  const clearInScope = async (
    predicates: DevicePredicate[],
    group?: DeviceGrouping,
  ) => {
    if (!exceptions.length) return;
    const inScope = new Set(
      await (group
        ? matching(predicates, exceptions, group)
        : matching(predicates, exceptions)),
    );
    exceptions = exceptions.filter((id) => !inScope.has(id));
  };
  for (const op of ops) {
    if (op.op === 'deselectAll') {
      terms = [];
      groups = [];
      additions = [];
      exceptions = [];
    } else if (op.op === 'selectAll') {
      await clearInScope(op.predicates);
      if (!terms.some((term) => sameTerm(term, op.predicates)))
        terms = [...terms, op.predicates];
    } else if (op.op === 'selectGroup' || op.op === 'deselectGroup') {
      const scope: DeviceGroupScope = {
        predicates: op.predicates,
        by: op.by,
        route: op.route,
      };
      if (op.op === 'selectGroup') {
        await clearInScope(scope.predicates, openGroup(scope));
        if (!groups.some((group) => sameGroup(group, scope)))
          groups = [...groups, scope];
      } else {
        groups = groups.filter((group) => !sameGroup(group, scope));
        const ids = await selectedIn(
          { terms, groups, additions, exceptions },
          scope.predicates,
          openGroup(scope),
        );
        const chosen = new Set(ids);
        additions = additions.filter((id) => !chosen.has(id));
        if (terms.length || groups.length) exceptions = union(exceptions, ids);
      }
    } else if (op.op === 'select') {
      const ids = new Set(op.ids);
      exceptions = exceptions.filter((id) => !ids.has(id));
      additions = union(additions, op.ids);
    } else {
      const ids = new Set(op.ids);
      additions = additions.filter((id) => !ids.has(id));
      // Only a filter or group term can still hold a deselected device.
      if (terms.length || groups.length) exceptions = union(exceptions, op.ids);
    }
  }
  if (
    terms.length > maxTerms ||
    groups.length > maxTerms ||
    additions.length > maxIds ||
    exceptions.length > maxIds
  )
    throw new SelectionTooLargeError();
  return { terms, groups, additions, exceptions };
}

export interface SelectionCache {
  get(key: string): Promise<string | null>;
  swap(
    key: string,
    expected: string | null,
    value: string,
    seconds: number,
  ): Promise<boolean>;
}

/** Read, change, and write a selection. A concurrent write makes the change retry from the newer value. */
export async function changeSelection(
  cache: SelectionCache,
  key: string,
  change: (state: SelectionState) => Promise<SelectionState>,
): Promise<SelectionState> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await cache.get(key);
    const next = await change(parseSelection(raw));
    if (await cache.swap(key, raw, JSON.stringify(next), SELECTION_SECONDS))
      return next;
  }
  throw new SelectionBusyError();
}

export function selectionSpec(
  state: SelectionState,
  selectedCount: number,
): DeviceSelectionSpec {
  return {
    terms: state.terms.map((predicates) => ({ type: 'all', predicates })),
    groups: state.groups,
    added: state.additions.length,
    excluded: state.exceptions.length,
    selectedCount,
  };
}
