import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { MOCK_EXIT_MESSAGE } from './admin-sdk-mock-fixture.mjs';

/**
 * Harness-level regressions for a stopped mock.
 *
 * Each check runs the review harness as its own process against a real mock
 * container, then stops that container at one precise moment. The harness must
 * report the container log and exit nonzero, and it must never continue against
 * a stopped backend. Docker and the built application are required.
 *
 * Run from the repository root through `npm exec -- nx run
 * api-e2e:admin-sdk-mock-exit-test`.
 */
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const dockerNames = () =>
  docker('ps', '-a', '--format', '{{.Names}}').split('\n').filter(Boolean);
/** The marker of `admin-sdk-mock-fault-hook.mjs`. */
const HOOK_MARKER = 'The fault hook stopped';
/** The startup banner of the review harness. */
const BANNER = 'Client review: https://';

/** The last lines of a run output, for a failure message. */
const tail = (output) => output.slice(-4000);

/** A dot-free temporary root, because the deployment schema rejects a dot. */
function temporaryRoot() {
  const base = tmpdir();
  return /^[a-zA-Z0-9_/-]+$/.test(base) ? base : '/tmp';
}

/** Fail fast when another review environment already runs. */
function assertNoReviewEnvironment() {
  const active = dockerNames().filter((name) => name.startsWith('cc-phase2-'));
  assert.deepEqual(active, [], 'Another review environment is active.');
}

/**
 * Run the review harness as its own process with the mock serving Google.
 * `hook` loads a fault hook, and `environment` adds harness variables.
 * `logPath` keeps the raw run output as evidence.
 */
function startHarness({ root, hook, environment = {}, logPath }) {
  const env = {
    ...process.env,
    TMPDIR: root,
    CI: 'true',
    CC_AUTH_PHASE: '3',
    CC_CLIENT_REVIEW: '1',
    CC_CLIENT_REVIEW_GOOGLE: 'admin-sdk-mock',
    ...environment,
  };
  for (const key of [
    'NODE_OPTIONS',
    'CC_MOCK_TIER',
    'CC_MOCK_TIER_DEFAULT',
    'CC_MOCK_DELAYS',
    'CC_MOCK_INTEGRATION',
    'CC_MOCK_FAULT_REQUEST',
  ])
    if (!(key in environment)) delete env[key];
  const args = ['api-e2e/auth.test.mjs'];
  // `--import` resolves a bare specifier as a package name, so the hook needs
  // its absolute path.
  if (hook) args.unshift('--import', join(process.cwd(), hook));
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const record = (bytes) => {
    output += bytes;
    if (logPath) appendFileSync(logPath, bytes);
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  const ended = new Promise((resolve) =>
    child.on('exit', (code) => resolve(code)),
  );
  const alive = () => child.exitCode === null && child.signalCode === null;
  return {
    child,
    get output() {
      return output;
    },
    /** Wait for one line in the run output. Returns the time it appeared. */
    async waitForText(needle, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (output.includes(needle)) return Date.now();
        assert.ok(
          alive(),
          `The run ended before "${needle}" appeared.\n${tail(output)}`,
        );
        assert.ok(
          Date.now() < deadline,
          `The run output never held "${needle}".\n${tail(output)}`,
        );
        await delay(100);
      }
    },
    /** Wait for the process to end. Returns its exit code. */
    waitForExit(timeoutMs) {
      return Promise.race([
        ended,
        delay(timeoutMs).then(() =>
          assert.fail(
            `The run did not exit within ${timeoutMs} ms.\n${tail(output)}`,
          ),
        ),
      ]);
    },
  };
}

/**
 * Wait for the reviewer's startup trigger: the mock is ready and the worker
 * container exists. The startup sequence still runs at that moment.
 */
async function waitForStartupTrigger(root, harness) {
  const deadline = Date.now() + 300000;
  for (;;) {
    const names = dockerNames();
    const mockName = names.find(
      (name) => name.startsWith('cc-phase2-') && name.endsWith('-mock'),
    );
    if (mockName) {
      const network = mockName.slice(0, -'-mock'.length);
      const runDirectory = (await readdir(root).catch(() => []))
        .filter((entry) => entry.startsWith('cc-phase2-auth-'))
        .map((entry) => join(root, entry))
        .find((entry) =>
          existsSync(join(entry, 'admin-sdk-mock', 'ready.json')),
        );
      if (runDirectory && names.includes(`${network}-worker`))
        return { mockName, network, runDirectory };
    }
    assert.ok(
      Date.now() < deadline,
      `The environment never reached the mock ready state.\n${tail(harness.output)}`,
    );
    await delay(200);
  }
}

/** Record every container name while the run ends. */
function startSampling() {
  const seen = new Set();
  const timer = setInterval(() => {
    for (const name of dockerNames()) seen.add(name);
  }, 200);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      return [...seen];
    },
  };
}

/** Wait until the run removed its containers and its run directory. */
async function waitForEnvironmentRemoval(baseline, root) {
  const deadline = Date.now() + 90000;
  for (;;) {
    const containers = dockerNames().filter(
      (name) => name.startsWith('cc-phase2-') && !baseline.includes(name),
    );
    const directories = (await readdir(root).catch(() => [])).filter((entry) =>
      entry.startsWith('cc-phase2-auth-'),
    );
    if (containers.length === 0 && directories.length === 0) return;
    assert.ok(
      Date.now() < deadline,
      `The run left ${JSON.stringify({ containers, directories })} in place.`,
    );
    await delay(250);
  }
}

/** End one probe and remove everything it left, including a stuck process. */
async function cleanupProbe({ harness, root, baseline }) {
  if (harness?.child.exitCode === null && harness?.child.signalCode === null)
    harness.child.kill('SIGKILL');
  for (const name of dockerNames())
    if (name.startsWith('cc-phase2-') && !baseline.includes(name)) {
      try {
        docker('rm', '-f', name);
      } catch {
        /* The probe owns only its own names. */
      }
    }
  for (const network of docker('network', 'ls', '--format', '{{.Name}}').split(
    '\n',
  ))
    if (network.startsWith('cc-phase2-')) {
      try {
        docker('network', 'rm', network);
      } catch {
        /* The network is already gone or still holds another container. */
      }
    }
  await rm(root, { recursive: true, force: true });
}

test(
  'a mock exit after its ready signal stops startup and prints the mock log',
  { timeout: 900000 },
  async (t) => {
    assertNoReviewEnvironment();
    const baseline = dockerNames();
    const root = await mkdtemp(join(temporaryRoot(), 'cc-mock-exit-'));
    mkdirSync('dist/client-review', { recursive: true });
    const harness = startHarness({
      root,
      logPath: 'dist/client-review/mock-exit-startup.log',
    });
    t.after(() => cleanupProbe({ harness, root, baseline }));
    const target = await waitForStartupTrigger(root, harness);
    const sampled = startSampling();
    const killedAt = Date.now();
    docker('kill', target.mockName);
    const reportedAt = await harness.waitForText(MOCK_EXIT_MESSAGE, 60000);
    const reportedSeconds = (reportedAt - killedAt) / 1000;
    assert.ok(
      reportedSeconds <= 5,
      `The mock diagnostic took ${reportedSeconds.toFixed(1)} s, over the 5 s bound.`,
    );
    const code = await harness.waitForExit(120000);
    const seen = sampled.stop();
    assert.notEqual(
      code,
      0,
      'The review run must exit nonzero after a mock exit.',
    );
    assert.match(
      harness.output,
      /"event":"ready"/,
      'The run output must hold the mock log.',
    );
    assert.ok(
      !harness.output.includes(BANNER),
      'The ready banner must not print after a mock exit.',
    );
    assert.deepEqual(
      seen.filter((name) => /-api-|frontend/.test(name)),
      [],
      'No later startup step starts after the mock exit.',
    );
    await waitForEnvironmentRemoval(baseline, root);
  },
);

test(
  'a mock exit during an in-flight integration request reports the mock log',
  { timeout: 1200000 },
  async (t) => {
    assertNoReviewEnvironment();
    const baseline = dockerNames();
    const root = await mkdtemp(join(temporaryRoot(), 'cc-mock-inflight-'));
    mkdirSync('dist/client-review', { recursive: true });
    const harness = startHarness({
      root,
      hook: 'api-e2e/admin-sdk-mock-fault-hook.mjs',
      logPath: 'dist/client-review/mock-exit-inflight.log',
      environment: {
        CC_MOCK_INTEGRATION: '1',
        CC_MOCK_FAULT_REQUEST: 'POST /api/google-connection/candidates',
      },
    });
    t.after(() => cleanupProbe({ harness, root, baseline }));
    // The hook stops the mock while the candidate request is in flight.
    await harness.waitForText(HOOK_MARKER, 900000);
    await harness.waitForText(MOCK_EXIT_MESSAGE, 60000);
    const code = await harness.waitForExit(180000);
    assert.notEqual(
      code,
      0,
      'The integration run must exit nonzero after a mock exit.',
    );
    assert.match(
      harness.output,
      /"event":"ready"/,
      'The run output must hold the mock log.',
    );
    await waitForEnvironmentRemoval(baseline, root);
  },
);
