import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = async (path) => JSON.parse(await readFile(path));

async function tree(root, relative = '') {
  const rows = [];
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) rows.push(...(await tree(root, path)));
    else {
      assert.ok(entry.isFile());
      rows.push({ path, sha256: hash(await readFile(join(root, path))) });
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

/** Compare durable records before any restored application service starts. */
export function assertHybridRestoreSnapshot(before, after) {
  assert.equal(before.principals.length, 2);
  assert.ok(before.events.length > 0);
  assert.ok(before.artifacts.length > 0);
  assert.ok(before.executionRows > 0);
  assert.deepEqual(after.principals, before.principals);
  assert.deepEqual(after.artifacts, before.artifacts);
  const originalIds = new Set(before.events.map((row) => row.value.id));
  assert.deepEqual(
    after.events.filter((row) => originalIds.has(row.value.id)),
    before.events,
  );
  assert.ok(after.events.length > before.events.length);
  assert.deepEqual(after.ledger, before.ledger);
  assert.equal(after.executionRows, before.executionRows);
  assert.equal(after.executionSha256, before.executionSha256);
  assert.deepEqual(after.kestraFiles, before.kestraFiles);
  assert.equal(before.invitations.length, 3);
  assert.deepEqual(before.invitations.map((row) => row.value.status).sort(), [
    'issued',
    'pending',
    'redeeming',
  ]);
  const expectedInvitations = before.invitations.map(({ value }) => ({
    value: {
      ...value,
      status: 'revoked',
      token_hash: null,
      browser_hash: null,
      version: value.version + 1,
    },
  }));
  assert.deepEqual(after.invitations, expectedInvitations);
}

/** Inspect private fixture state inside the native operator container. */
export async function inspectHybridRestoreState(mode, inputPath) {
  assert.ok(['seed', 'verify', 'bootstrap'].includes(mode));
  const input = await json(inputPath);
  const config = await json(input.configurationPath);
  const { connectDatabase, connectionOptions } = await import(
    '/release/deployment/postgres/index.mjs'
  );
  const { createArtifactStore } = await import(
    '/release/deployment/storage/index.mjs'
  );
  const { seedPhase3State, verifyPhase3State } = await import(
    '/release/deployment/operations/phase3-state-fixture.mjs'
  );
  const { createRequire } = await import('node:module');
  const pg = createRequire('/release/package.json')('pg');
  const secret = (ref) => readFile(ref.path);
  let migration, runtime, kestra, store;
  let result;
  const failures = [];
  try {
    result = await (async () => {
      migration = await connectDatabase(
        {
          ...config.services.applicationDatabase,
          ...input.applicationCredentials,
        },
        secret,
      );
      runtime = new pg.Pool(
        await connectionOptions(config.services.applicationDatabase, secret),
      );
      kestra = await connectDatabase(config.services.kestraDatabase, secret);
      store = await createArtifactStore({
        pool: runtime,
        root: config.artifacts.location,
      });
      if (mode === 'bootstrap') {
        const { bootstrap: original } = await json(input.proofPath);
        const rows = (
          await migration.query(
            'SELECT generation,credential_hash,revoked_at FROM cc.bootstrap_access',
          )
        ).rows;
        assert.equal(rows.length, 1);
        const row = rows[0];
        assert.equal(
          String(row.generation),
          String(BigInt(original.generation) + 1n),
        );
        assert.equal(row.revoked_at, null);
        assert.notEqual(row.credential_hash, original.credentialHash);
        const { verifyBootstrap } = await import(
          '/release/deployment/bootstrap/access.mjs'
        );
        assert.equal(
          await verifyBootstrap(
            migration,
            (await secret(config.services.edge.bootstrapSecretRef)).toString(
              'utf8',
            ),
          ),
          true,
        );
        return {
          status: 'passed',
          sourceBootstrapRejected: true,
          replacementBootstrapAccepted: true,
          bootstrapGeneration: String(row.generation),
        };
      }
      const snapshot = async () => {
        const executionRows = (
          await kestra.query(
            "SELECT to_jsonb(e)-'fulltext' AS value,strip(fulltext)::text AS lexemes FROM public.executions e ORDER BY e.key",
          )
        ).rows;
        assert.ok(executionRows.length > 0);
        const records = async (table) =>
          (
            await migration.query(
              `SELECT to_jsonb(t) AS value FROM cc.${table} t ORDER BY id`,
            )
          ).rows;
        return {
          principals: await records('application_principals'),
          events: await records('security_events'),
          artifacts: await records('artifacts'),
          invitations: (
            await migration.query(
              'SELECT to_jsonb(t) AS value FROM cc.application_invitations t WHERE id=ANY($1::uuid[]) ORDER BY id',
              [input.invitationIds],
            )
          ).rows,
          ledger: (
            await migration.query(
              'SELECT id,checksum FROM cc.schema_migrations ORDER BY id',
            )
          ).rows,
          executionRows: executionRows.length,
          executionSha256: hash(JSON.stringify(executionRows)),
          kestraFiles: await tree(
            config.services.kestra.internalStorage.location,
          ),
        };
      };
      if (mode === 'seed') {
        const principal = (
          await migration.query(
            'SELECT id,permission_version,preferences FROM cc.application_principals WHERE id=$1',
            [input.principalId],
          )
        ).rows[0];
        assert.equal(principal.preferences.theme, 'dark');
        const { key, ...source } = await seedPhase3State(
          migration,
          principal.id,
          principal.permission_version,
          {
            key: await secret(config.googleConnection.encryptionKeySecretRef),
            keyId: config.googleConnection.keyId,
          },
        );
        key.fill(0);
        const bytes = Buffer.from('Phase 3 hybrid restore École 学校');
        const artifact = await store.stage(
          {
            schemaVersion: 1,
            expectedSizeBytes: bytes.length,
            expectedSha256: hash(bytes),
          },
          [bytes],
        );
        await store.publish(artifact);
        const before = await snapshot();
        assert.equal(before.principals.length, 2);
        assert.equal(before.invitations.length, 3);
        assert.deepEqual(
          before.invitations.map((row) => row.value.status).sort(),
          ['issued', 'pending', 'redeeming'],
        );
        const bootstrapRow = (
          await migration.query(
            'SELECT generation,credential_hash FROM cc.bootstrap_access WHERE id=1',
          )
        ).rows[0];
        const bootstrap = {
          generation: String(bootstrapRow.generation),
          credentialHash: bootstrapRow.credential_hash,
        };
        await writeFile(
          input.proofPath,
          JSON.stringify({ source, before, artifact, bootstrap }),
          { mode: 0o600, flag: 'wx' },
        );
        return {
          status: 'seeded',
          bootstrapGeneration: bootstrap.generation,
          customerId: source.customerId,
          schoolId: source.schoolId,
          principals: before.principals.length,
          securityEvents: before.events.length,
        };
      }
      const { source, before, artifact } = await json(input.proofPath);
      const restoration = await json(
        join(input.targetDirectory, 'restore-report.json'),
      );
      const state = await verifyPhase3State(
        migration,
        runtime,
        source,
        restoration.accessRecovery,
        undefined,
        { deferRevalidation: true },
      );
      const after = await snapshot();
      assertHybridRestoreSnapshot(before, after);
      const digest = createHash('sha256');
      for await (const bytes of await store.openRead(artifact.artifactId))
        digest.update(bytes);
      assert.equal(digest.digest('hex'), artifact.sha256);
      const revokedEvents = (
        await migration.query(
          "SELECT count(*)::int AS count FROM cc.security_events WHERE target_id=ANY($1::uuid[]) AND event='invitation-revoked' AND detail='restore-invalidated' AND correlation_id=$2",
          [
            input.invitationIds,
            restoration.accessRecovery.googleConnection.recoveryId,
          ],
        )
      ).rows[0].count;
      assert.equal(revokedEvents, 3);
      assert.equal(
        (
          await migration.query(
            'SELECT count(*)::int AS count FROM cc.bootstrap_access WHERE revoked_at IS NULL',
          )
        ).rows[0].count,
        0,
      );
      return {
        ...state,
        customerId: source.customerId,
        schoolId: source.schoolId,
        principals: before.principals.length,
        originalSecurityEvents: before.events.length,
        originalSecurityEventsPreserved: true,
        migrationChecksumsPreserved: true,
        artifactMetadataPreserved: true,
        artifact: { id: artifact.artifactId, sha256: artifact.sha256 },
        executionRows: before.executionRows,
        executionSha256: before.executionSha256,
        kestraFiles: before.kestraFiles,
        bootstrapRevoked: true,
        invitations: {
          revoked: 3,
          recoveryAuditEvents: revokedEvents,
          sourceSha256: hash(JSON.stringify(before.invitations)),
          restoredSha256: hash(JSON.stringify(after.invitations)),
        },
      };
    })();
  } catch (error) {
    failures.push(error);
  } finally {
    const closed = await Promise.allSettled([
      store?.close(),
      runtime?.end(),
      migration?.end(),
      kestra?.end(),
    ]);
    failures.push(
      ...closed
        .filter((item) => item.status === 'rejected')
        .map((item) => item.reason),
    );
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Hybrid restore state verification or cleanup failed.',
    );
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(
      JSON.stringify(
        await inspectHybridRestoreState(process.argv[2], process.argv[3]),
      ),
    );
  } catch {
    console.error(
      'Hybrid restore state verification failed. Inspect the private fixture.',
    );
    process.exitCode = 1;
  }
}
