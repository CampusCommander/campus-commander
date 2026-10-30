import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerContainer } from './kestra-fixture.mjs';

/**
 * The review harness starts its worker from the built worker file and without a
 * worker image. That worker loads `deployment/storage/index.mjs` from its
 * working directory and writes the artifacts location of its config
 * (`worker/src/device-export-store.ts`). Both paths must exist inside the
 * container. This check starts the same worker container and proves the module
 * loads and an artifact writes.
 *
 * Run from the repository root: it reads the pinned node image from the
 * deployment Dockerfile and mounts the repository files. Docker holds the
 * worker container.
 */

const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** The module the worker imports and the file it writes. */
const probe = `
  (async () => {
    const { readFileSync, writeFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const { pathToFileURL } = require('node:url');
    const config = JSON.parse(readFileSync(process.env.CC_CONFIG_FILE, 'utf8'));
    const store = await import(
      pathToFileURL(resolve(process.cwd(), 'deployment/storage/index.mjs')).href
    );
    if (typeof store.createArtifactStore !== 'function')
      throw new Error('deployment/storage/index.mjs exports no createArtifactStore');
    const file = resolve(config.artifacts.location, 'worker-store-probe.txt');
    writeFileSync(file, 'worker-store-probe');
    process.stdout.write(JSON.stringify({ module: 'deployment/storage/index.mjs', file }));
  })().catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error) + '\\n');
    process.exit(1);
  });
`;

test(
  'the review worker loads the deployment store and writes an artifact',
  { timeout: 120000 },
  async (t) => {
    const nodeImage = (
      await readFile('deployment/images/api.Dockerfile', 'utf8')
    ).match(/^FROM (node:\S+)/m)[1];
    const network = `cc-kestra-fixture-${randomUUID()}`;
    const name = `cc-kestra-fixture-worker-${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), 'cc-kestra-fixture-'));
    const secrets = join(directory, 'secrets');
    const artifacts = join(directory, 'artifacts');
    await mkdir(secrets, { recursive: true, mode: 0o700 });
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    // The worker reads this secret at startup. A single line of 32 characters.
    await writeFile(join(secrets, 'worker-dispatch'), 's'.repeat(32), {
      mode: 0o600,
    });
    const config = {
      artifacts: { kind: 'shared-filesystem', location: artifacts },
    };
    await writeFile(join(directory, 'profile.json'), JSON.stringify(config));
    docker('network', 'create', network);
    t.after(async () => {
      try {
        execFileSync('docker', ['rm', '-f', name]);
      } catch {
        // The probe owns only this container.
      }
      try {
        execFileSync('docker', ['network', 'rm', network]);
      } catch {
        // The probe owns only this network.
      }
      await rm(directory, { recursive: true, force: true });
    });

    startWorkerContainer({
      docker,
      name,
      network,
      directory,
      config,
      nodeImage,
    });
    let running = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      running = docker('inspect', '-f', '{{.State.Running}}', name) === 'true';
      if (running) break;
      await delay(100);
    }
    assert.equal(
      running,
      true,
      `the worker did not start: ${docker('logs', name)}`,
    );

    const answer = JSON.parse(docker('exec', name, 'node', '-e', probe));
    assert.equal(answer.module, 'deployment/storage/index.mjs');
    assert.equal(
      await readFile(join(artifacts, 'worker-store-probe.txt'), 'utf8'),
      'worker-store-probe',
    );
  },
);
