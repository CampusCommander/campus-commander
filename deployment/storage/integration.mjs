import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrate, provision } from '../postgres/index.mjs';
import { createArtifactStore } from './index.mjs';

const qualification = JSON.parse(
  await readFile(
    new URL('../postgres/qualification.json', import.meta.url),
    'utf8',
  ),
);
const name = `cc-storage-${randomUUID()}`;
const root = await mkdtemp(join(tmpdir(), 'cc-storage-'));
const backend = process.env.CC_STORAGE_BACKEND ?? 'local';
const password = randomUUID();
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = (bytes, extra = {}) => ({
  artifactId: randomUUID(),
  attemptId: randomUUID(),
  schemaVersion: 1,
  expectedSizeBytes: bytes.length,
  expectedSha256: hash(bytes),
  ...extra,
});
const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};
const results = [];
let admin;
let pool;
let store;
let shared;
try {
  await writeFile(
    join(root, 'postgres.env'),
    `POSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  docker('volume', 'create', name);
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'campus-commander.test=storage',
    '--env-file',
    join(root, 'postgres.env'),
    '-p',
    '127.0.0.1::5432',
    '-v',
    `${name}:/var/lib/postgresql`,
    qualification.image,
  );
  const port = Number(docker('port', name, '5432/tcp').split(':').at(-1));
  const connection = {
    host: '127.0.0.1',
    port,
    password,
    user: 'storage-app',
    database: 'storage-app',
    max: 12,
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    admin = new pg.Client({
      ...connection,
      user: 'postgres',
      database: 'postgres',
    });
    try {
      await admin.connect();
      break;
    } catch {
      await admin.end();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await provision(admin, {
    application: {
      database: 'storage-app',
      role: 'storage-app',
      password,
      migrationRole: 'storage-migrator',
      migrationPassword: password,
    },
    kestra: { database: 'storage-kestra', role: 'storage-kestra', password },
  });
  const migrator = new pg.Client({ ...connection, user: 'storage-migrator' });
  await migrator.connect();
  await migrate(migrator, { runtimeRole: 'storage-app' });
  await migrator.end();
  pool = new pg.Pool(connection);
  store = await createArtifactStore({ pool, root, backend });
  assert.equal(await store.checkHealth(), true);
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from('Synthetic École 学校'),
    Buffer.alloc(8 * 1024 * 1024, 42),
  ]) {
    const staged = await store.stage(
      manifest(bytes),
      (async function* () {
        for (let i = 0; i < bytes.length; i += 16384)
          yield bytes.subarray(i, i + 16384);
      })(),
    );
    await assert.rejects(store.openRead(staged.artifactId));
    assert.equal((await store.inspect(staged)).publicationState, 'staging');
    await store.publish(staged);
    assert.deepEqual(
      await collect(await store.openRead(staged.artifactId)),
      bytes,
    );
  }
  results.push(
    'empty, Unicode, and 8 MiB streaming publication and verified reads: pass',
  );
  const bytes = Buffer.from('complete synthetic artifact');
  for (const content of [
    bytes.subarray(0, 4),
    Buffer.alloc(bytes.length, 1),
    Buffer.concat([bytes, bytes]),
  ]) {
    const expected = manifest(bytes);
    await assert.rejects(store.stage(expected, [content]));
    await assert.rejects(store.inspect(expected));
    await assert.rejects(store.openRead(expected.artifactId));
  }
  results.push(
    'truncated, checksum-mismatched, and oversized streams remain unpublished: pass',
  );
  const first = await store.stage(manifest(bytes), [bytes]);
  const second = await store.stage(
    manifest(bytes, { artifactId: first.artifactId }),
    [bytes],
  );
  await assert.rejects(store.publish(first));
  await assert.rejects(store.remove(first));
  await Promise.all(Array.from({ length: 6 }, () => store.publish(second)));
  await assert.rejects(
    store.stage(manifest(bytes, { artifactId: second.artifactId }), [bytes]),
  );
  results.push(
    'six publishers preserve one identity; stale publication, stale cleanup, and ready replacement fail: pass',
  );
  const rollback = await store.stage(manifest(bytes), [bytes]);
  let failCommit = true;
  const faultPool = {
    async connect() {
      const client = await pool.connect();
      return {
        release: () => client.release(),
        async query(sql, values) {
          const result = await client.query(sql, values);
          if (
            failCommit &&
            typeof sql === 'string' &&
            sql.includes("SET publication_state='ready'")
          ) {
            failCommit = false;
            throw new Error('Synthetic metadata failure.');
          }
          return result;
        },
      };
    },
  };
  const faultStore = await createArtifactStore({
    pool: faultPool,
    root,
    backend,
  });
  await assert.rejects(faultStore.publish(rollback));
  await faultStore.close();
  await assert.rejects(store.openRead(rollback.artifactId));
  assert.equal((await store.inspect(rollback)).publicationState, 'staging');
  await store.publish(rollback);
  assert.deepEqual(
    await collect(await store.openRead(rollback.artifactId)),
    bytes,
  );
  results.push(
    'metadata rollback leaves complete bytes unpublished; verification recovers publication: pass',
  );
  for (const prefix of [4, bytes.length]) {
    const expected = manifest(bytes);
    const child = spawnSync(
      process.execPath,
      ['deployment/storage/process-fixture.mjs'],
      {
        env: {
          ...process.env,
          CC_STORAGE_FIXTURE: JSON.stringify({
            connection,
            root,
            backend,
            manifest: expected,
            bytes: bytes.toString('base64'),
            prefix,
          }),
        },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(child.status, 73, child.stderr);
    const token = {
      artifactId: expected.artifactId,
      attemptId: expected.attemptId,
      schemaVersion: 1,
      sizeBytes: bytes.length,
      sha256: hash(bytes),
    };
    if (prefix === bytes.length) {
      await store.publish(token);
      assert.deepEqual(
        await collect(await store.openRead(token.artifactId)),
        bytes,
      );
    } else {
      await assert.rejects(store.publish(token));
      assert.equal(await store.remove(token), false);
    }
  }
  results.push(
    'writer process exit preserves partial invisibility and permits complete-byte recovery: pass',
  );
  const interruptedPublication = await store.stage(manifest(bytes), [bytes]);
  const publisher = spawnSync(
    process.execPath,
    ['deployment/storage/process-fixture.mjs'],
    {
      env: {
        ...process.env,
        CC_STORAGE_FIXTURE: JSON.stringify({
          connection,
          root,
          backend,
          action: 'publish',
          descriptor: interruptedPublication,
        }),
      },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(publisher.status, 73, publisher.stderr);
  await assert.rejects(store.openRead(interruptedPublication.artifactId));
  await store.publish(interruptedPublication);
  assert.deepEqual(
    await collect(await store.openRead(interruptedPublication.artifactId)),
    bytes,
  );
  results.push(
    'publisher process exit after metadata UPDATE rolls back readiness and permits verified recovery: pass',
  );
  const referenced = await store.stage(manifest(bytes), [bytes]);
  await pool.query('UPDATE cc.artifacts SET reference_count=1 WHERE id=$1', [
    referenced.artifactId,
  ]);
  const race = await Promise.all([
    store.publish(referenced),
    store.remove(referenced),
  ]);
  assert.equal(race[1], false);
  assert.deepEqual(
    await collect(await store.openRead(referenced.artifactId)),
    bytes,
  );
  let releaseSource;
  let notifySource;
  const sourceStarted = new Promise((resolve) => {
    notifySource = resolve;
  });
  const sourceReleased = new Promise((resolve) => {
    releaseSource = resolve;
  });
  const active = manifest(bytes);
  const staging = store.stage(
    active,
    (async function* () {
      notifySource();
      await sourceReleased;
      yield bytes;
    })(),
  );
  await sourceStarted;
  assert.equal(await store.remove(active), false);
  releaseSource();
  await staging;
  results.push(
    'cleanup preserves referenced artifacts and active writers during concurrent publication: pass',
  );
  const corrupt = await store.stage(manifest(bytes), [bytes]);
  await store.publish(corrupt);
  const corruptPath = join(root, `${corrupt.artifactId}.${corrupt.attemptId}`);
  await chmod(corruptPath, 0o600);
  await writeFile(corruptPath, Buffer.alloc(bytes.length, 0));
  await assert.rejects(store.openRead(corrupt.artifactId));
  const linked = await store.stage(manifest(bytes), [bytes]);
  const linkedPath = join(root, `${linked.artifactId}.${linked.attemptId}`);
  await unlink(linkedPath);
  await symlink('/etc/passwd', linkedPath);
  await assert.rejects(store.publish(linked));
  await pool.query("UPDATE cc.artifacts SET locator='../escape' WHERE id=$1", [
    linked.artifactId,
  ]);
  await assert.rejects(store.inspect(linked));
  await assert.rejects(store.openRead('../escape'));
  results.push(
    'corruption, symbolic links, invalid locators, and traversal fail closed: pass',
  );
  await chmod(root, 0o500);
  assert.equal(await store.checkHealth(), false);
  await assert.rejects(store.stage(manifest(bytes), [bytes]));
  await chmod(root, 0o700);
  await assert.rejects(
    createArtifactStore({ pool, root: join(root, 'unavailable') }),
  );
  results.push('denied and unavailable storage fail without publication: pass');
  await store.close();
  store = await createArtifactStore({ pool, root, backend });
  assert.deepEqual(
    await collect(await store.openRead(rollback.artifactId)),
    bytes,
  );
  docker(
    'run',
    '-d',
    '--name',
    `${name}-consumer`,
    '--label',
    'campus-commander.test=storage',
    '-v',
    `${root}:/artifacts:ro`,
    '--entrypoint',
    '/bin/sh',
    qualification.image,
    '-c',
    'sleep 300',
  );
  const containerPath = `/artifacts/${rollback.artifactId}.${rollback.attemptId}`;
  assert.equal(
    docker('exec', `${name}-consumer`, 'sha256sum', containerPath).split(
      ' ',
    )[0],
    hash(bytes),
  );
  docker('restart', `${name}-consumer`);
  assert.equal(
    docker('exec', `${name}-consumer`, 'sha256sum', containerPath).split(
      ' ',
    )[0],
    hash(bytes),
  );
  results.push(
    'adapter reopen and consumer-container restart preserve ready artifact bytes: pass',
  );
  const sharedRoot = await mkdtemp(join(tmpdir(), 'cc-storage-shared-'));
  try {
    shared = await createArtifactStore({
      pool,
      root: sharedRoot,
      backend: 'shared-filesystem',
    });
    const sharedArtifact = await shared.stage(manifest(bytes), [bytes]);
    await shared.publish(sharedArtifact);
    assert.deepEqual(
      await collect(await shared.openRead(sharedArtifact.artifactId)),
      bytes,
    );
    await shared.close();
    shared = undefined;
  } finally {
    await rm(sharedRoot, { recursive: true, force: true });
  }
  results.push(
    'shared adapter uses the same identity and integrity contract on one host: pass',
  );
  assert.equal(await store.remove(rollback), true);
  await assert.rejects(store.openRead(rollback.artifactId));
  const removal = await store.stage(manifest(bytes), [bytes]);
  await store.publish(removal);
  let failRemoval = true;
  const removalPool = {
    async connect() {
      const client = await pool.connect();
      return {
        release: () => client.release(),
        async query(sql, values) {
          const result = await client.query(sql, values);
          if (
            failRemoval &&
            typeof sql === 'string' &&
            sql.startsWith('DELETE FROM cc.artifacts')
          ) {
            failRemoval = false;
            throw new Error('Synthetic removal failure.');
          }
          return result;
        },
      };
    },
  };
  const removalStore = await createArtifactStore({
    pool: removalPool,
    root,
    backend,
  });
  await assert.rejects(removalStore.remove(removal));
  await removalStore.close();
  assert.equal(
    (
      await pool.query(
        'SELECT publication_state FROM cc.artifacts WHERE id=$1',
        [removal.artifactId],
      )
    ).rows[0].publication_state,
    'deleting',
  );
  await assert.rejects(
    pool.query('UPDATE cc.artifacts SET reference_count=1 WHERE id=$1', [
      removal.artifactId,
    ]),
  );
  await assert.rejects(store.openRead(removal.artifactId));
  assert.equal(await store.remove(removal), true);
  results.push(
    'cleanup rollback preserves a hidden tombstone; retry completes deletion; new references fail: pass',
  );
  console.log(
    JSON.stringify(
      {
        backend,
        results,
        crossHost: 'not-run: no two district hosts or shared mount supplied',
      },
      null,
      2,
    ),
  );
} finally {
  await shared?.close();
  await store?.close();
  await pool?.end();
  await admin?.end();
  for (const container of [`${name}-consumer`, name]) {
    try {
      docker('rm', '-f', container);
    } catch {
      /* The container was not created. */
    }
  }
  try {
    docker('volume', 'rm', name);
  } catch {
    /* The volume was not created. */
  }
  await chmod(root, 0o700);
  await rm(root, { recursive: true, force: true });
}
