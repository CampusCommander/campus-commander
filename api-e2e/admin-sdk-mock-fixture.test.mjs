import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MOCK_GOOGLE_HOSTS,
  mockReviewSettings,
  startAdminSdkMock,
} from './admin-sdk-mock-fixture.mjs';

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

test('the tier follows the target default and the shell override', async () => {
  const project = JSON.parse(await readFile('api-e2e/project.json', 'utf8'));
  const targetEnv = (name) => project.targets[name].options.env ?? {};
  // The review target seeds the medium district. Every other mock target keeps
  // the small fallback.
  assert.equal(targetEnv('client-review-mock').CC_MOCK_TIER_DEFAULT, 'medium');
  assert.equal(
    targetEnv('admin-sdk-mock-integration').CC_MOCK_TIER_DEFAULT,
    undefined,
  );
  // No target sets CC_MOCK_TIER itself. A target env overrides the shell, so a
  // target value there would take the last word away from the shell.
  for (const [name, target] of Object.entries(project.targets))
    assert.equal(
      target.options?.env?.CC_MOCK_TIER,
      undefined,
      `${name} sets CC_MOCK_TIER in the target env.`,
    );
  assert.equal(mockReviewSettings({}).tier, 'small');
  assert.equal(
    mockReviewSettings({ CC_MOCK_TIER_DEFAULT: 'medium' }).tier,
    'medium',
  );
  assert.equal(
    mockReviewSettings({
      CC_MOCK_TIER: 'small',
      CC_MOCK_TIER_DEFAULT: 'medium',
    }).tier,
    'small',
  );
});

test('the mock seeds the Easton Consulting district', async (t) => {
  const start = await mockProbe(t);
  const mock = await start();
  try {
    // The written configuration pins the district every review run presents.
    const config = JSON.parse(await readFile(mock.configFile, 'utf8'));
    assert.deepEqual(config.domains[0].spec, {
      tier: 'small',
      seed: 'campus-commander-review',
      name: 'Easton Consulting',
      primaryDomain: 'easton-consulting.com',
    });
    assert.match(mock.adminEmail, /@easton-consulting\.com$/);
  } finally {
    mock.watch.stop();
  }
});

test('the mock network serves the Sheets host beside the other Google hosts', async (t) => {
  const start = await mockProbe(t);
  const mock = await start();
  try {
    // The container carries every host of the fixture as a network alias.
    const networks = JSON.parse(
      docker('inspect', '-f', '{{json .NetworkSettings.Networks}}', mock.name),
    );
    const aliases = Object.values(networks).flatMap(
      (network) => network.Aliases ?? [],
    );
    for (const host of MOCK_GOOGLE_HOSTS)
      assert.ok(aliases.includes(host), `${host} is not a network alias.`);
    assert.ok(
      MOCK_GOOGLE_HOSTS.includes('sheets.googleapis.com'),
      'The fixture routes the Sheets host.',
    );
    // The alias answers a Sheets client inside the network.
    const address = docker(
      'exec',
      mock.name,
      'node',
      '-e',
      "require('node:dns').lookup(process.argv[1], (error, address) => console.log(error ? error.code : address))",
      'sheets.googleapis.com',
    );
    assert.match(address, /^\d+\.\d+\.\d+\.\d+$/);
  } finally {
    mock.watch.stop();
  }
});
