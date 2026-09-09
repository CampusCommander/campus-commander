import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import pg from 'pg';
import { parseDeploymentConfig } from '../../dist/deployment/index.js';
import { checkReadiness, connectionOptions } from '../postgres/index.mjs';
import { createArtifactStore } from './index.mjs';

let pool;
let store;
try {
  const [command, configPath, evidencePath] = process.argv.slice(2);
  if (!['write', 'read', 'remove', 'health'].includes(command) || !configPath)
    throw new Error('Invalid qualification command.');
  const config = parseDeploymentConfig(
    JSON.parse(await readFile(configPath, 'utf8')),
  );
  if (config.artifacts.kind !== 'shared-filesystem')
    throw new Error(
      'Cross-host qualification requires a shared filesystem configuration.',
    );
  const resolveSecret = async (reference) => {
    const path =
      reference.provider === 'file'
        ? reference.path
        : `/run/secrets/${reference.name}/${reference.key}`;
    return (await readFile(path, 'utf8')).replace(/\r?\n$/, '');
  };
  pool = new pg.Pool(
    await connectionOptions(config.services.applicationDatabase, resolveSecret),
  );
  if (!(await checkReadiness(pool)))
    throw new Error('Application database is not ready.');
  store = await createArtifactStore({
    pool,
    root: config.artifacts.location,
    backend: 'shared-filesystem',
  });
  if (command === 'health') {
    if (!(await store.checkHealth()))
      throw new Error('Shared storage probe failed.');
    console.log(
      JSON.stringify({
        host: hostname(),
        health: 'pass',
        timestamp: new Date().toISOString(),
      }),
    );
  } else if (command === 'write') {
    const chunk = Buffer.alloc(65536, 42);
    const checksum = createHash('sha256');
    for (let i = 0; i < 128; i++) checksum.update(chunk);
    const staged = await store.stage(
      {
        schemaVersion: 1,
        expectedSizeBytes: chunk.length * 128,
        expectedSha256: checksum.digest('hex'),
      },
      (async function* () {
        for (let i = 0; i < 128; i++) yield chunk;
      })(),
    );
    await store.publish(staged);
    const evidence = {
      ...staged,
      writerHost: hostname(),
      writtenAt: new Date().toISOString(),
      operatorTwoHostAttestationRequired: true,
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify(evidence));
  } else {
    const expected = JSON.parse(await readFile(evidencePath, 'utf8'));
    if (command === 'remove') {
      console.log(
        JSON.stringify({
          removed: await store.remove(expected),
          artifactId: expected.artifactId,
        }),
      );
    } else {
      const inspected = await store.inspect(expected);
      if (
        inspected.schemaVersion !== expected.schemaVersion ||
        inspected.publicationState !== 'ready'
      )
        throw new Error('Cross-host artifact metadata differs.');
      const checksum = createHash('sha256');
      let sizeBytes = 0;
      for await (const chunk of await store.openRead(expected.artifactId)) {
        sizeBytes += chunk.length;
        checksum.update(chunk);
      }
      const sha256 = checksum.digest('hex');
      if (sizeBytes !== expected.sizeBytes || sha256 !== expected.sha256)
        throw new Error('Cross-host artifact integrity differs.');
      console.log(
        JSON.stringify({
          ...expected,
          readerHost: hostname(),
          readAt: new Date().toISOString(),
          sizeBytes,
          sha256,
          integrity: 'pass',
        }),
      );
    }
  }
} catch {
  console.error(
    'Shared storage qualification failed. Check configuration, credentials, mount access, and artifact integrity.',
  );
  process.exitCode = 1;
} finally {
  await store?.close();
  await pool?.end();
}
