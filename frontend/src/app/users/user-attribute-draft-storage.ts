/**
 * The tab-local user attribute draft document (DRAFT-01: drafts live outside the grid row
 * cache, and a reload restores them).
 *
 * One sessionStorage entry per person and tab holds one `grid` part. This module reads and
 * writes that part alone, so a document that holds another part keeps it.
 */

export const USER_ATTRIBUTE_DRAFT_STORAGE_PREFIX = 'cc.user-attribute-draft.';

export type UserAttributeDraftPart = 'grid';

function draftStorageKey(principal: string): string {
  return `${USER_ATTRIBUTE_DRAFT_STORAGE_PREFIX}${principal}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the grid part. A missing document or part answers null. A malformed one throws. */
export function readUserDraftPart(
  principal: string,
  part: UserAttributeDraftPart,
): unknown | null {
  const raw = sessionStorage.getItem(draftStorageKey(principal));
  if (!raw) return null;
  const document: unknown = JSON.parse(raw);
  if (!isRecord(document)) return null;
  return part in document ? document[part] : null;
}

/** Replace the grid part. A null part removes it, and an empty document leaves no entry. */
export function writeUserDraftPart(
  principal: string,
  part: UserAttributeDraftPart,
  value: unknown,
): void {
  const key = draftStorageKey(principal);
  const raw = sessionStorage.getItem(key);
  let document: Record<string, unknown> = {};
  if (raw) {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) document = parsed;
  }
  if (value === null || value === undefined) delete document[part];
  else document[part] = value;
  if (Object.keys(document).length === 0) sessionStorage.removeItem(key);
  else sessionStorage.setItem(key, JSON.stringify(document));
}
