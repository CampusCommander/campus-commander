/**
 * Cut a long Organization unit path at a `/` boundary and keep whole trailing segments
 * (`docs/superpowers/specs/2026-10-28-device-export-import-design.md`, section 9, ruling 3).
 *
 * A page never leaves an empty slot, so a report cell holds one line and ends in an ellipsis. A
 * path cuts at its start instead, so its last units stay in view: `/Chrome Devices/Lowell
 * Academy/Grade 9` reads `…/Lowell Academy/Grade 9` in a narrow cell. The tooltip holds the whole
 * path. A path that fits the budget comes back unchanged, so no value shows an ellipsis that fits.
 */
export function cutDevicePath(path: string, maxLength: number): string {
  if (path.length <= maxLength) return path;
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return path;
  // A cut needs room for the ellipsis, a slash, and one whole segment.
  const kept = [segments[segments.length - 1]];
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const next = [segments[index], ...kept];
    if (`…/${next.join('/')}`.length > maxLength) break;
    kept.unshift(segments[index]);
  }
  return `…/${kept.join('/')}`;
}
