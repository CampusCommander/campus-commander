import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { connectionOptions } from '/app/deployment/postgres/index.mjs';
import { createArtifactStore } from '/app/deployment/storage/index.mjs';
import { secretPath } from '/app/deployment/redis/runtime.mjs';

// The fault harness executes this probe inside its dedicated API container.
const config = JSON.parse(await readFile(process.env.CC_CONFIG_FILE, 'utf8'));
const resolveSecret = (reference) => readFile(secretPath(reference));
const pool = new pg.Pool({
  ...(await connectionOptions(
    config.services.applicationDatabase,
    resolveSecret,
  )),
  max: 1,
});
let store;
try {
  const migrations = (
    await pool.query(
      'SELECT id, checksum FROM cc.schema_migrations ORDER BY id',
    )
  ).rows;
  const bootstrap = (
    await pool.query(
      'SELECT id, generation, expires_at, revoked_at FROM cc.bootstrap_access ORDER BY id',
    )
  ).rows;
  if (migrations.length !== 1 || bootstrap.length !== 1)
    throw new Error('Synthetic database fixtures are absent.');
  const descriptor = JSON.parse(
    await readFile(`${config.artifacts.location}/.cc13-fixture.json`, 'utf8'),
  );
  store = await createArtifactStore({
    pool,
    root: config.artifacts.location,
    backend: 'local',
  });
  const digest = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of await store.openRead(descriptor.artifactId)) {
    digest.update(chunk);
    sizeBytes += chunk.length;
  }
  const sha256 = digest.digest('hex');
  if (sha256 !== descriptor.sha256 || sizeBytes !== descriptor.sizeBytes)
    throw new Error('Synthetic artifact integrity differs.');
  const auth = JSON.parse(
    (await resolveSecret(config.services.kestra.authSecretRef)).toString(
      'utf8',
    ),
  );
  const request = async (path) => {
    const response = await fetch(
      new URL(path, config.services.kestra.endpoint.url),
      {
        signal: AbortSignal.timeout(5000),
        headers: {
          authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
        },
      },
    );
    if (!response.ok)
      throw new Error('Synthetic Kestra fixture is unavailable.');
    return response;
  };
  const flow = await (
    await request('/api/v1/main/flows/campus.validation/cc11_external_worker')
  ).json();
  const marker = Buffer.from(
    await (
      await request(
        '/api/v1/main/namespaces/campus.validation/files?path=/cc13-marker.txt',
      )
    ).arrayBuffer(),
  );
  if (flow.id !== 'cc11_external_worker' || !marker.length)
    throw new Error('Synthetic Kestra state differs.');
  process.stdout.write(
    JSON.stringify({
      migrations,
      bootstrap,
      artifact: { artifactId: descriptor.artifactId, sizeBytes, sha256 },
      kestra: {
        id: flow.id,
        namespace: flow.namespace,
        revision: flow.revision,
        markerSha256: createHash('sha256').update(marker).digest('hex'),
      },
    }),
  );
} finally {
  await store?.close();
  await pool.end();
}
