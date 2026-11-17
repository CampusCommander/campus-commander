import { z } from 'zod';
import {
  userPredicateSchema,
  type UserPredicate,
  type UserSelectionKey,
  type UserSelectionOp,
  type UserSelectionSpec,
} from '@campus/application-contracts';

/** A selection expires 12 hours after its last change (document A section 8). */
export const USER_SELECTION_SECONDS = 12 * 60 * 60;
/** Redis keeps an expired selection for one more day, so its expiry time can be reported. */
export const USER_SELECTION_MARKER_SECONDS = 24 * 60 * 60;
export const USER_SELECTION_STORAGE_SECONDS =
  USER_SELECTION_SECONDS + USER_SELECTION_MARKER_SECONDS;
const maxTerms = 50;
const maxIds = 200_000;
const userIds = z.array(z.string().min(1).max(128)).max(maxIds);
const timestamp = z.iso.datetime({ offset: true });

const selectionStateSchema = z.strictObject({
  terms: z.array(z.array(userPredicateSchema).max(20)).max(maxTerms),
  additions: userIds,
  exceptions: userIds,
  /** The time of the last selection change. Absent state never expires. */
  changedAt: timestamp.nullable().optional(),
});
export type UserSelectionState = z.infer<typeof selectionStateSchema>;

export class UserSelectionTooLargeError extends Error {}
export class UserSelectionBusyError extends Error {}

export function emptyUserSelection(): UserSelectionState {
  return { terms: [], additions: [], exceptions: [] };
}

/** Whether the state holds any starting selection: a filter term or an addition. */
export function hasUserSelection(state: UserSelectionState): boolean {
  return state.terms.length > 0 || state.additions.length > 0;
}

export function userSelectionStorageKey(
  identityId: string,
  key: UserSelectionKey,
): string {
  // The application Redis user may only touch cc:* keys.
  return `cc:user-selection:${identityId}:${key.gridId}:${key.tabId}`;
}

export interface ParsedUserSelection {
  state: UserSelectionState;
  /** The expiry time of the last change, or null while the selection is current. */
  expiredAt: string | null;
}

/** A missing or unreadable selection is empty. A selection older than 12 hours reads as empty. */
export function parseUserSelection(
  raw: string | null,
  now = Date.now(),
): ParsedUserSelection {
  if (!raw) return { state: emptyUserSelection(), expiredAt: null };
  let parsed: UserSelectionState;
  try {
    const result = selectionStateSchema.safeParse(JSON.parse(raw));
    if (!result.success)
      return { state: emptyUserSelection(), expiredAt: null };
    parsed = result.data;
  } catch {
    return { state: emptyUserSelection(), expiredAt: null };
  }
  if (parsed.changedAt) {
    const changed = Date.parse(parsed.changedAt);
    const expires = changed + USER_SELECTION_SECONDS * 1000;
    if (Number.isFinite(changed) && now >= expires)
      return {
        state: emptyUserSelection(),
        expiredAt: new Date(expires).toISOString(),
      };
  }
  return { state: parsed, expiredAt: null };
}

const union = (current: readonly string[], ids: readonly string[]) => [
  ...new Set([...current, ...ids]),
];
const sameTerm = (a: readonly UserPredicate[], b: readonly UserPredicate[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply one batch of grid selection operations.
 * `matching` returns which of the given users match a filter.
 */
export async function applyUserSelectionOps(
  state: UserSelectionState,
  ops: readonly UserSelectionOp[],
  matching: (
    predicates: UserPredicate[],
    ids: string[],
  ) => Promise<string[]> = async () => [],
): Promise<UserSelectionState> {
  const { changedAt } = state;
  let { terms, additions, exceptions } = state;
  const clearInScope = async (predicates: UserPredicate[]) => {
    if (!exceptions.length) return;
    const inScope = new Set(await matching(predicates, exceptions));
    exceptions = exceptions.filter((id) => !inScope.has(id));
  };
  for (const op of ops) {
    if (op.op === 'deselectAll') {
      terms = [];
      additions = [];
      exceptions = [];
    } else if (op.op === 'selectAll') {
      await clearInScope(op.predicates);
      if (!terms.some((term) => sameTerm(term, op.predicates)))
        terms = [...terms, op.predicates];
    } else if (op.op === 'select') {
      const ids = new Set(op.ids);
      exceptions = exceptions.filter((id) => !ids.has(id));
      additions = union(additions, op.ids);
    } else {
      const ids = new Set(op.ids);
      additions = additions.filter((id) => !ids.has(id));
      // Only a filter term can still hold a deselected user.
      if (terms.length) exceptions = union(exceptions, op.ids);
    }
  }
  if (
    terms.length > maxTerms ||
    additions.length > maxIds ||
    exceptions.length > maxIds
  )
    throw new UserSelectionTooLargeError();
  const next: UserSelectionState = { terms, additions, exceptions };
  if (changedAt) next.changedAt = changedAt;
  return next;
}

export interface UserSelectionCache {
  get(key: string): Promise<string | null>;
  swap(
    key: string,
    expected: string | null,
    value: string,
    seconds: number,
  ): Promise<boolean>;
}

/**
 * Read, change, and write a selection. A concurrent write makes the change retry from the newer value.
 * The first change after expiry starts from empty, and every change records `changedAt`.
 */
export async function changeUserSelection(
  cache: UserSelectionCache,
  key: string,
  change: (state: UserSelectionState) => Promise<UserSelectionState>,
): Promise<UserSelectionState> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await cache.get(key);
    const next = await change(parseUserSelection(raw).state);
    const stored: UserSelectionState = {
      ...next,
      changedAt: new Date().toISOString(),
    };
    if (
      await cache.swap(
        key,
        raw,
        JSON.stringify(stored),
        USER_SELECTION_STORAGE_SECONDS,
      )
    )
      return stored;
  }
  throw new UserSelectionBusyError();
}

export function userSelectionSpec(
  state: UserSelectionState,
  selectedCount: number,
  expiredAt: string | null = null,
): UserSelectionSpec {
  return {
    terms: state.terms.map((predicates) => ({ type: 'all', predicates })),
    added: state.additions.length,
    excluded: state.exceptions.length,
    selectedCount,
    expiredAt,
  };
}
