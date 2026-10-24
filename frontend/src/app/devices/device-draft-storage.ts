/**
 * The tab-local device draft document (record line 66, addendum section 5).
 *
 * One sessionStorage entry per person and tab holds three separate parts: the sheet draft,
 * the grid draft, and the single-device draft. Each part validates and reads only its own
 * value. This module only merges a written part into the document so one part never clears
 * another.
 */

export const DEVICE_DRAFT_STORAGE_PREFIX = 'cc.device-update-draft.';

export type DeviceDraftPart = 'sheet' | 'grid' | 'single';

export function draftStorageKey(principal: string): string {
  return `${DEVICE_DRAFT_STORAGE_PREFIX}${principal}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one part. A missing document or part answers null, so a part that was never written
 * reads as empty. A malformed document throws; the caller reports the storage error.
 */
export function readDraftPart(
  principal: string,
  part: DeviceDraftPart,
): unknown | null {
  const raw = sessionStorage.getItem(draftStorageKey(principal));
  if (!raw) return null;
  const document: unknown = JSON.parse(raw);
  if (!isRecord(document)) return null;
  return part in document ? document[part] : null;
}

/**
 * Replace one part and keep every other part. A null or undefined part removes it. The
 * document is removed once no part remains.
 */
export function writeDraftPart(
  principal: string,
  part: DeviceDraftPart,
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
