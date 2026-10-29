/** The retention sweep runs every hour (design section 4). */
export const ARTIFACT_PURGE_MS = 60 * 60 * 1000;

interface ArtifactRow {
  id: string;
  attempt_id: string;
}

interface ArtifactDatabase {
  query(text: string): Promise<{ rows: ArtifactRow[] }>;
}

interface ArtifactRemoval {
  remove(manifest: { artifactId: string; attemptId: string }): Promise<boolean>;
}

/**
 * Remove each artifact whose retention passed, where the store accepts the removal.
 * A referenced artifact, a current writer, and a failed removal wait for the next sweep.
 */
export async function purgeExpiredArtifacts(
  database: ArtifactDatabase,
  store: ArtifactRemoval,
): Promise<number> {
  const { rows } = await database.query(
    `SELECT id, attempt_id FROM cc.artifacts
      WHERE retention_until <= now() ORDER BY retention_until`,
  );
  let removed = 0;
  for (const row of rows) {
    try {
      if (await store.remove({ artifactId: row.id, attemptId: row.attempt_id }))
        removed += 1;
    } catch {
      // A racing writer or a failed removal leaves the artifact for the next sweep.
    }
  }
  return removed;
}

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