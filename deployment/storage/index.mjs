import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY_MS = 86_400_000;
const MAX_RETENTION_DAYS = 3660;

/** The retention of an export file, an import upload, a report, and a plan (design section 4). */
export const ARTIFACT_RETENTION_DAYS = 30;

function identity(value) {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new Error('Invalid artifact identity.');
  return value;
}
function descriptor(row) {
  return {
    artifactId: row.id,
    attemptId: row.attempt_id,
    schemaVersion: row.schema_version,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
  };
}
function match(row, expected) {
  if (
    !row ||
    row.attempt_id !== expected.attemptId ||
    row.schema_version !== expected.schemaVersion ||
    row.sha256 !== expected.sha256 ||
    Number(row.size_bytes) !== expected.sizeBytes
  ) {
    throw new Error(
      'Artifact publication identity or integrity metadata differs.',
    );
  }
}

/**
 * Resolve the stored retention. The caller passes a day count to keep the artifact that many
 * days, or an explicit deadline. No retention leaves the column null.
 */
function retention({ retentionDays = null, retentionUntil = null }) {
  if (retentionDays !== null) {
    if (
      retentionUntil !== null ||
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > MAX_RETENTION_DAYS
    )
      throw new Error('Invalid artifact retention.');
    return new Date(Date.now() + retentionDays * DAY_MS).toISOString();
  }
  if (retentionUntil === null) return null;
  if (
    typeof retentionUntil !== 'string' ||
    Number.isNaN(Date.parse(retentionUntil))
  )
    throw new Error('Invalid artifact retention.');
  return new Date(retentionUntil).toISOString();
}

/**
 * Remove each expired artifact that the store accepts. A referenced artifact, a current writer,
 * and a failed removal wait for the next sweep. Returns the number of removed artifacts.
 */
export async function purgeRows(rows, remove) {
  let removed = 0;
  for (const row of rows) {
    try {
      if (await remove({ artifactId: row.id, attemptId: row.attempt_id }))
        removed += 1;
    } catch {
      // A racing writer or a failed removal leaves the artifact for the next sweep.
    }
  }
  return removed;
}

/**
 * Write one attempt file. The size and the SHA-256 are computed while the chunks arrive.
 * The cap check runs before the excess chunk reaches the disk.
 * Any failure closes the file and removes it, so no partial file survives.
 */
export async function writeArtifact(path, source, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error('Invalid artifact size limit.');
  let file;
  try {
    file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw new Error('Artifact exceeds its size limit.');
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(
          bytes,
          offset,
          bytes.length - offset,
        );
        if (!bytesWritten) throw new Error('Artifact write made no progress.');
        offset += bytesWritten;
      }
    }
    const sha256 = hash.digest('hex');
    await file.chmod(0o400);
    await file.sync();
    await file.close();
    file = undefined;
    return { sizeBytes: size, sha256 };
  } catch (error) {
    if (file) {
      await file.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
    }
    throw error;
  }
}

/** The operator must supply an existing, private directory on the selected persistent filesystem. */
async function initializeStore({ pool, root, backend = 'local' }) {
  if (!['local', 'shared-filesystem'].includes(backend))
    throw new Error('Unsupported artifact backend.');
  if (
    typeof root !== 'string' ||
    resolve(root) !== root ||
    (await realpath(root)) !== root
  )
    throw new Error(
      'Artifact storage requires an absolute directory without symbolic links.',
    );
  const directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const stat = await directory.stat();
  if (!stat.isDirectory() || stat.mode & 0o022) {
    await directory.close();
    throw new Error('Artifact storage must prohibit group and public writes.');
  }
  let closed = false;
  const location = (row) => {
    identity(row.id);
    identity(row.attempt_id);
    if (
      row.backend !== backend ||
      row.locator !== `${row.id}.${row.attempt_id}`
    )
      throw new Error('Invalid artifact locator.');
    if (closed) throw new Error('Artifact storage is closed.');
    return `/proc/self/fd/${directory.fd}/${row.locator}`;
  };
  const lock = async (client, artifactId, session = false) => {
    identity(artifactId);
    await client.query(
      `SELECT ${session ? 'pg_advisory_lock' : 'pg_advisory_xact_lock'}(hashtextextended($1, 0))`,
      [artifactId],
    );
  };
  async function transaction(artifactId, operation, tryLock = false) {
    identity(artifactId);
    const client = await pool.connect();
    let result;
    let failure;
    try {
      await client.query('BEGIN');
      if (tryLock) {
        identity(artifactId);
        const result = await client.query(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
          [artifactId],
        );
        if (!result.rows[0].acquired) {
          await client.query('COMMIT');
          return false;
        }
      } else await lock(client, artifactId);
      const {
        rows: [row],
      } = await client.query(
        'SELECT * FROM cc.artifacts WHERE id=$1 FOR UPDATE',
        [artifactId],
      );
      result = await operation(client, row);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      failure = error;
      result?.destroy?.();
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release(failure);
    }
  }
  async function verifiedFile(row, durable = false) {
    const file = await open(
      location(row),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const details = await file.stat();
      if (
        !details.isFile() ||
        details.nlink !== 1 ||
        details.size !== Number(row.size_bytes)
      )
        throw new Error('Artifact size or file type differs.');
      const hash = createHash('sha256');
      let position = 0;
      const buffer = Buffer.alloc(64 * 1024);
      while (true) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (
        position !== Number(row.size_bytes) ||
        hash.digest('hex') !== row.sha256
      )
        throw new Error('Artifact checksum differs.');
      if (durable) {
        await file.chmod(0o400);
        await file.sync();
        await directory.sync();
      }
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async function remove({ artifactId, attemptId }) {
    identity(attemptId);
    const permitted = await transaction(
      artifactId,
      async (client, row) => {
        if (!row) return false;
        if (row.attempt_id !== attemptId)
          throw new Error('Artifact removal attempt is stale.');
        if (row.active || row.reference_count > 0) return false;
        await client.query(
          "UPDATE cc.artifacts SET publication_state='deleting' WHERE id=$1",
          [artifactId],
        );
        return true;
      },
      true,
    );
    if (!permitted) return false;
    return transaction(artifactId, async (client, row) => {
      if (!row) return false;
      if (
        row.attempt_id !== attemptId ||
        row.publication_state !== 'deleting' ||
        row.active ||
        row.reference_count > 0
      )
        return false;
      const details = await lstat(location(row)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (details && (!details.isFile() || details.nlink !== 1))
        throw new Error('Artifact removal requires a regular file.');
      await unlink(location(row)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await directory.sync();
      await client.query('DELETE FROM cc.artifacts WHERE id=$1', [artifactId]);
      return true;
    });
  }
  async function purgeExpired() {
    if (closed) return 0;
    const { rows } = await pool.query(
      `SELECT id, attempt_id FROM cc.artifacts
        WHERE retention_until <= now() ORDER BY retention_until`,
    );
    return purgeRows(rows, remove);
  }

  return {
    async checkHealth() {
      if (closed) return false;
      const path = `/proc/self/fd/${directory.fd}/.health-${randomUUID()}`;
      let file;
      let created = false;
      try {
        file = await open(
          path,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        created = true;
        const bytes = Buffer.from(randomUUID());
        await file.writeFile(bytes);
        await file.sync();
        const actual = Buffer.alloc(bytes.length);
        const { bytesRead } = await file.read(actual, 0, actual.length, 0);
        if (bytesRead !== bytes.length || !actual.equals(bytes)) return false;
        await file.close();
        file = undefined;
        await unlink(path);
        created = false;
        await directory.sync();
        return true;
      } catch {
        return false;
      } finally {
        await file?.close().catch(() => undefined);
        if (created) await unlink(path).catch(() => undefined);
      }
    },
    async stage(
      {
        artifactId = randomUUID(),
        attemptId = randomUUID(),
        schemaVersion,
        expectedSizeBytes,
        expectedSha256,
        retentionUntil = null,
        retentionDays = null,
      },
      source,
    ) {
      identity(artifactId);
      identity(attemptId);
      if (
        !Number.isSafeInteger(expectedSizeBytes) ||
        expectedSizeBytes < 0 ||
        !Number.isInteger(schemaVersion) ||
        schemaVersion < 1 ||
        !/^[a-f0-9]{64}$/.test(expectedSha256)
      )
        throw new Error('Invalid artifact integrity metadata.');
      const expires = retention({ retentionDays, retentionUntil });
      const row = {
        id: artifactId,
        attempt_id: attemptId,
        backend,
        locator: `${artifactId}.${attemptId}`,
        schema_version: schemaVersion,
        size_bytes: expectedSizeBytes,
        sha256: expectedSha256,
      };
      const client = await pool.connect();
      let reserved = false;
      let file;
      let failure;
      try {
        await lock(client, artifactId, true);
        await client.query('BEGIN');
        const {
          rows: [existing],
        } = await client.query(
          'SELECT * FROM cc.artifacts WHERE id=$1 FOR UPDATE',
          [artifactId],
        );
        if (
          existing &&
          (existing.publication_state !== 'staging' ||
            existing.active ||
            existing.reference_count > 0 ||
            existing.attempt_id === attemptId)
        ) {
          throw new Error(
            'Artifact already has an active or authoritative attempt.',
          );
        }
        await client.query(
          `INSERT INTO cc.artifacts(id,attempt_id,backend,locator,schema_version,size_bytes,sha256,retention_until,active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
          ON CONFLICT (id) DO UPDATE SET attempt_id=EXCLUDED.attempt_id, backend=EXCLUDED.backend, locator=EXCLUDED.locator,
            schema_version=EXCLUDED.schema_version,size_bytes=EXCLUDED.size_bytes,sha256=EXCLUDED.sha256,
            retention_until=EXCLUDED.retention_until, active=true`,
          [
            artifactId,
            attemptId,
            backend,
            row.locator,
            schemaVersion,
            expectedSizeBytes,
            expectedSha256,
            expires,
          ],
        );
        await client.query('COMMIT');
        reserved = true;
        file = await open(
          location(row),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of source) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > expectedSizeBytes)
            throw new Error('Artifact exceeds its declared size.');
          hash.update(bytes);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await file.write(
              bytes,
              offset,
              bytes.length - offset,
            );
            if (!bytesWritten)
              throw new Error('Artifact write made no progress.');
            offset += bytesWritten;
          }
        }
        if (size !== expectedSizeBytes || hash.digest('hex') !== expectedSha256)
          throw new Error(
            'Artifact bytes differ from the declared integrity metadata.',
          );
        await file.chmod(0o400);
        await file.sync();
        await file.close();
        file = undefined;
        await directory.sync();
        await client.query(
          'UPDATE cc.artifacts SET active=false WHERE id=$1 AND attempt_id=$2',
          [artifactId, attemptId],
        );
        return descriptor(row);
      } catch (error) {
        failure = error;
        await client.query('ROLLBACK').catch(() => undefined);
        if (reserved)
          await client
            .query(
              'UPDATE cc.artifacts SET active=false WHERE id=$1 AND attempt_id=$2',
              [artifactId, attemptId],
            )
            .catch(() => undefined);
        throw error;
      } finally {
        await file?.close().catch(() => undefined);
        await client
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
            artifactId,
          ])
          .catch((error) => {
            failure = error;
          });
        client.release(failure);
      }
    },
    /**
     * Stage a stream whose size and SHA-256 are unknown until the last chunk arrives.
     * The reservation holds null integrity metadata, so no reader can publish it early.
     * A file past `maxBytes`, a failed write, or a failed metadata update leaves no file.
     */
    async stageStream(
      {
        artifactId = randomUUID(),
        attemptId = randomUUID(),
        schemaVersion,
        maxBytes,
        retentionUntil = null,
        retentionDays = null,
      },
      source,
    ) {
      identity(artifactId);
      identity(attemptId);
      if (
        !Number.isInteger(schemaVersion) ||
        schemaVersion < 1 ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0
      )
        throw new Error('Invalid artifact stream metadata.');
      const expires = retention({ retentionDays, retentionUntil });
      const row = {
        id: artifactId,
        attempt_id: attemptId,
        backend,
        locator: `${artifactId}.${attemptId}`,
        schema_version: schemaVersion,
      };
      const client = await pool.connect();
      let reserved = false;
      let written = false;
      let failure;
      try {
        await lock(client, artifactId, true);
        await client.query('BEGIN');
        const {
          rows: [existing],
        } = await client.query(
          'SELECT * FROM cc.artifacts WHERE id=$1 FOR UPDATE',
          [artifactId],
        );
        if (
          existing &&
          (existing.publication_state !== 'staging' ||
            existing.active ||
            existing.reference_count > 0 ||
            existing.attempt_id === attemptId)
        ) {
          throw new Error(
            'Artifact already has an active or authoritative attempt.',
          );
        }
        await client.query(
          `INSERT INTO cc.artifacts(id,attempt_id,backend,locator,schema_version,size_bytes,sha256,retention_until,active)
          VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6,true)
          ON CONFLICT (id) DO UPDATE SET attempt_id=EXCLUDED.attempt_id, backend=EXCLUDED.backend, locator=EXCLUDED.locator,
            schema_version=EXCLUDED.schema_version,size_bytes=NULL,sha256=NULL,
            retention_until=EXCLUDED.retention_until, active=true`,
          [artifactId, attemptId, backend, row.locator, schemaVersion, expires],
        );
        await client.query('COMMIT');
        reserved = true;
        const size = await writeArtifact(location(row), source, maxBytes);
        written = true;
        await directory.sync();
        const updated = await client.query(
          'UPDATE cc.artifacts SET size_bytes=$3, sha256=$4 WHERE id=$1 AND attempt_id=$2',
          [artifactId, attemptId, size.sizeBytes, size.sha256],
        );
        if (updated.rowCount !== 1)
          throw new Error('Artifact staging metadata changed.');
        await client.query(
          'UPDATE cc.artifacts SET active=false WHERE id=$1 AND attempt_id=$2',
          [artifactId, attemptId],
        );
        return {
          artifactId,
          attemptId,
          schemaVersion,
          sizeBytes: size.sizeBytes,
          sha256: size.sha256,
        };
      } catch (error) {
        failure = error;
        await client.query('ROLLBACK').catch(() => undefined);
        if (written) await unlink(location(row)).catch(() => undefined);
        if (reserved)
          await client
            .query(
              'UPDATE cc.artifacts SET active=false WHERE id=$1 AND attempt_id=$2',
              [artifactId, attemptId],
            )
            .catch(() => undefined);
        throw error;
      } finally {
        await client
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
            artifactId,
          ])
          .catch((error) => {
            failure = error;
          });
        client.release(failure);
      }
    },
    async inspect({ artifactId, attemptId }) {
      identity(attemptId);
      return transaction(artifactId, async (_client, row) => {
        if (
          !row ||
          row.attempt_id !== attemptId ||
          row.publication_state === 'deleting'
        )
          throw new Error('Artifact attempt is unavailable.');
        const file = await verifiedFile(row);
        await file.close();
        return { ...descriptor(row), publicationState: row.publication_state };
      });
    },
    async publish(expected) {
      identity(expected.attemptId);
      return transaction(expected.artifactId, async (client, row) => {
        match(row, expected);
        if (!['staging', 'ready'].includes(row.publication_state))
          throw new Error('Artifact cannot be published.');
        const file = await verifiedFile(row, true);
        await file.close();
        await client.query(
          "UPDATE cc.artifacts SET publication_state='ready', active=false WHERE id=$1 AND attempt_id=$2",
          [row.id, row.attempt_id],
        );
        return descriptor(row);
      });
    },
    async openRead(artifactId) {
      return transaction(artifactId, async (_client, row) => {
        if (!row || row.publication_state !== 'ready')
          throw new Error('Artifact is not ready.');
        const file = await verifiedFile(row);
        return file.createReadStream({ start: 0, autoClose: true });
      });
    },
    remove,
    purgeExpired,
    async close() {
      if (!closed) {
        closed = true;
        await directory.close();
      }
    },
  };
}

export async function createArtifactStore(options) {
  try {
    const store = await initializeStore(options);
    return Object.fromEntries(
      Object.entries(store).map(([name, operation]) => [
        name,
        async (...args) => {
          try {
            return await operation(...args);
          } catch {
            throw new Error(`Artifact ${name} failed.`);
          }
        },
      ]),
    );
  } catch {
    throw new Error('Artifact storage initialization failed.');
  }
}
