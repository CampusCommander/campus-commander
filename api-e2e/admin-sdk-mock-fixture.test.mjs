import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startAdminSdkMock } from './admin-sdk-mock-fixture.mjs';

/**
 * Fixture checks against a real mock container.
 *
 * These checks cover the two mock failure paths of the review harness: a CLI
 * failure before the ready signal, and an exit after readiness. Both paths must
 * report the container log, so the harness never continues against a stopped or
 * misconfigured mock.
 *
 * Run from the repository root: it reads the pinned image from the deployment
 * Dockerfile. Docker holds the mock container.
 */

const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const nodeImage = (
  await readFile('deployment/images/api.Dockerfile', 'utf8')
).match(/^FROM (node:\S+)/m)[1];

/** One throwaway network and one run directory for a mock probe. */
async function mockProbe(t) {
  const network = `cc-mock-fixture-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'cc-mock-fixture-'));
  const names = [];
  docker('network', 'create', network);
  t.after(async () => {
    await Promise.allSettled(
      names.map(
        (name) =>
          new Promise((resolve) => {
            try {
              execFileSync('docker', ['rm', '-f', name]);
            } catch {
              // The probe owns only these names.
            }
            resolve();
          }),
      ),
    );
    await rm(directory, { recursive: true, force: true });
    try {
      execFileSync('docker', ['network', 'rm', network]);
    } catch {
      // The probe owns only this network.
    }
  });
  return (overrides = {}) =>
    startAdminSdkMock({
      docker,
      directory,
      network,
      names,
      nodeImage,
      tier: 'small',
      delays: false,
      ...overrides,
    });
}

test('a startup failure reports the mock CLI stderr', async (t) => {
  const start = await mockProbe(t);
  await assert.rejects(
    start({ environment: { MOCK_GOOGLE_PORT: 'not-a-port' } }),
    (error) => {
      assert.match(error.message, /exited before its ready signal/);
      assert.match(error.message, /MOCK_GOOGLE_PORT must be a whole number/);
      return true;
    },
  );
});

test('an exit after readiness fails the watch with the mock log', async (t) => {
  const start = await mockProbe(t);
  const mock = await start();
  try {
    assert.equal(mock.watch.assertRunning(), undefined);
    docker('kill', mock.name);
    const log = await Promise.race([
      mock.watch.failure,
      delay(20000).then(() =>
        assert.fail('The watch did not report the stopped mock.'),
      ),
    ]);
    assert.match(log, /"event":"ready"/);
    assert.throws(
      () => mock.watch.assertRunning(),
      /The Admin SDK mock exited after its ready signal/,
    );
  } finally {
    mock.watch.stop();
  }
});
