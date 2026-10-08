import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareHybrid } from '../deployment/profiles/hybrid/prepare.mjs';
import { renderFiles } from '../deployment/profiles/hybrid/render.mjs';

const execute = promisify(execFile);
async function docker(...args) {
  return (
    await execute('docker', args, {
      timeout: 240000,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout.trim();
}

async function fileChecksums(root, relative = '') {
  const files = [];
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await fileChecksums(root, path)));
    else {
      assert.ok(entry.isFile(), 'The storage fixture requires regular files.');
      files.push({
        path,
        sha256: createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Upgrade the rendered hybrid installation while preserving its external state. */
export async function qualifyHybridUpgrade({
  root,
  source,
  configPath,
  releasePath,
  controllerFile,
  workerFiles,
  projects,
  externalNetwork,
  artifactPath,
  artifactChecksum,
  storageRoot,
  readExecution,
  images,
  baseline,
  auth,
  password,
  caFile,
}) {
  const startedAt = Date.now();
  const compose = (...args) =>
    docker('compose', '-f', controllerFile, '-p', projects.controller, ...args);
  const workerCompose = (index, ...args) =>
    docker(
      'compose',
      '-f',
      workerFiles[index],
      '-p',
      projects.workers[index],
      ...args,
    );
  const probe = async (script) =>
    JSON.parse(
      await docker(
        'exec',
        await compose('ps', '-q', 'api'),
        'node',
        '--input-type=module',
        '-e',
        script,
      ),
    );
  const common = `import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));
const store=await createArtifactStore({pool,root:c.artifacts.location});`;
  const beforeImages = {};
  for (const service of ['frontend', 'api']) {
    const actual = JSON.parse(
      await docker('inspect', await compose('ps', '-q', service)),
    )[0].Image;
    const expected = JSON.parse(
      await docker('image', 'inspect', baseline.images[service]),
    )[0].Id;
    assert.equal(actual, expected);
    beforeImages[service] = baseline.images[service];
  }
  for (let index = 0; index < workerFiles.length; index++) {
    const actual = JSON.parse(
      await docker(
        'inspect',
        await workerCompose(index, 'ps', '-q', 'workers'),
      ),
    )[0].Image;
    const expected = JSON.parse(
      await docker('image', 'inspect', baseline.images.workers),
    )[0].Id;
    assert.equal(actual, expected);
  }
  beforeImages.workers = baseline.images.workers;
  const seeded = await probe(
    common +
      `
const bytes=Buffer.from('Phase 1 hybrid upgrade fixture École 学校');
const artifact=await store.stage({schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes]);
await store.publish(artifact);await store.close();await pool.end();process.stdout.write(JSON.stringify(artifact));`,
  );
  const inspectState = () =>
    probe(
      common +
        `
const id=${JSON.stringify(seeded.artifactId)},hash=crypto.createHash('sha256');
for await(const bytes of await store.openRead(id))hash.update(bytes);
const ledger=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const metadata=(await pool.query('SELECT to_jsonb(a) AS value FROM cc.artifacts a WHERE id=$1',[id])).rows;
const authTable=(await pool.query("SELECT to_regclass('cc.application_principals')::text AS name")).rows[0].name;
await store.close();await pool.end();
process.stdout.write(JSON.stringify({ledger,metadata,authTable,sha256:hash.digest('hex')}));`,
    );
  const before = await inspectState();
  assert.equal(
    before.authTable,
    null,
    'The baseline must precede the authentication migration.',
  );
  const executionBefore = await readExecution();
  assert.equal(executionBefore.state.current, 'SUCCESS');
  const filesBefore = await fileChecksums(storageRoot);
  assert.ok(filesBefore.length > 0);
  const oldController = JSON.parse(await readFile(controllerFile, 'utf8'));
  await compose('stop');
  for (let index = 0; index < workerFiles.length; index++)
    await workerCompose(index, 'stop');
  source.phase = 2;
  source.images = images;
  source.applicationAuth = auth;
  source.services.edge.access = 'application';
  source.services.edge.endpoint.url = auth.publicOrigin;
  await writeFile(join(root, 'private', 'oidc-client'), password, {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(configPath, JSON.stringify(source, null, 2));
  await writeFile(
    releasePath,
    JSON.stringify({
      schemaVersion: 1,
      architectures: ['linux/amd64'],
      images,
    }),
  );
  await prepareHybrid(configPath, root);
  await renderFiles(configPath, releasePath, controllerFile, {
    workerBindAddresses: ['10.20.30.41', '10.20.30.42'],
  });
  const controller = JSON.parse(await readFile(controllerFile, 'utf8'));
  controller.networks.egress = { external: true, name: externalNetwork };
  for (const service of ['edge', 'api', 'kestra'])
    controller.services[service].ports = oldController.services[service].ports;
  controller.services.api.environment.NODE_EXTRA_CA_CERTS =
    '/run/qualification/provider-ca';
  controller.services.api.extra_hosts = ['host.docker.internal:host-gateway'];
  controller.services.api.volumes.push({
    type: 'bind',
    source: caFile,
    target: '/run/qualification/provider-ca',
    read_only: true,
  });
  await writeFile(controllerFile, JSON.stringify(controller, null, 2));
  for (const file of workerFiles) {
    const worker = JSON.parse(await readFile(file, 'utf8'));
    worker.networks.egress = { external: true, name: externalNetwork };
    delete worker.services.workers.ports;
    await writeFile(file, JSON.stringify(worker, null, 2));
  }
  await compose('config', '--quiet');
  await compose('run', '--rm', '--no-deps', 'runtime-files');
  await compose('run', '--rm', '--no-deps', 'database-migrate');
  for (let index = 0; index < workerFiles.length; index++)
    await workerCompose(index, 'up', '-d', '--wait', '--wait-timeout', '120');
  await compose('up', '-d', '--wait', '--wait-timeout', '180');
  for (const service of ['frontend', 'api']) {
    const actual = JSON.parse(
      await docker('inspect', await compose('ps', '-q', service)),
    )[0].Image;
    const expected = JSON.parse(
      await docker('image', 'inspect', images[service]),
    )[0].Id;
    assert.equal(actual, expected);
  }
  for (let index = 0; index < workerFiles.length; index++) {
    const actual = JSON.parse(
      await docker(
        'inspect',
        await workerCompose(index, 'ps', '-q', 'workers'),
      ),
    )[0].Image;
    const expected = JSON.parse(
      await docker('image', 'inspect', images.workers),
    )[0].Id;
    assert.equal(actual, expected);
  }
  const after = await inspectState();
  assert.equal(after.authTable, 'cc.application_principals');
  assert.deepEqual(after.metadata, before.metadata);
  assert.equal(after.sha256, before.sha256);
  assert.deepEqual(after.ledger.slice(0, before.ledger.length), before.ledger);
  assert.equal(after.ledger.length, before.ledger.length + 1);
  assert.deepEqual(await readExecution(), executionBefore);
  assert.deepEqual(await fileChecksums(storageRoot), filesBefore);
  for (let index = 0; index < workerFiles.length; index++) {
    const checksum = await docker(
      'exec',
      await workerCompose(index, 'ps', '-q', 'workers'),
      'node',
      '-e',
      `const fs=require('node:fs'),c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(${JSON.stringify(artifactPath)})).digest('hex'));`,
    );
    assert.equal(checksum, artifactChecksum);
  }
  return {
    status: 'passed',
    recordedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    baselineImages: beforeImages,
    images,
    runtimeImageContentVerified: true,
    baselineMigrations: before.ledger,
    upgradedMigrations: after.ledger,
    preserved: {
      artifactId: seeded.artifactId,
      artifactSha256: before.sha256,
      artifactMetadata: true,
      sharedMarkerSha256: artifactChecksum,
      workerReaders: workerFiles.length,
      executionId: executionBefore.id,
      executionState: 'SUCCESS',
      kestraFiles: filesBefore.length,
    },
    limits: [
      'The fixture upgrades rendered Compose projects through the documented preparation and migration commands.',
      'The fixture uses one Docker host with external TLS PostgreSQL and Redis containers.',
      'The fixture uses a synthetic identity provider and two worker Compose projects.',
      'This report does not establish installer CLI, release signatures, or district infrastructure acceptance.',
    ],
  };
}
