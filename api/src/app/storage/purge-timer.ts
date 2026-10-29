/** The retention sweep runs every hour (design section 4). */
export const ARTIFACT_PURGE_MS = 60 * 60 * 1000;

/**
 * Run one sweep every hour. A failed sweep is dropped, so the next hour retries it.
 * The timer does not hold the process open. The returned function stops the timer.
 */
export function startArtifactPurge(
  purge: () => Promise<unknown>,
  intervalMs = ARTIFACT_PURGE_MS,
): () => void {
  const timer = setInterval(() => {
    void purge().catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
