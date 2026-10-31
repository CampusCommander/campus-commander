import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GOOGLE_CAPABILITIES } from '../libs/application-contracts/src/lib/google-capabilities.ts';

/** The fixed review seed. A seed always yields the same customer ID and district. */
export const MOCK_SEED = 'campus-commander-review';
/** The district name every review environment presents. */
export const MOCK_DISTRICT_NAME = 'Easton Consulting';
/** The primary domain of the review district. The mock derives its child domains. */
export const MOCK_PRIMARY_DOMAIN = 'easton-consulting.com';
/** The tiers that CC_MOCK_TIER accepts. */
export const MOCK_TIERS = ['small', 'medium', 'large', 'xlarge'];
/** The hostnames the mock serves. The container carries them as network aliases. */
export const MOCK_GOOGLE_HOSTS = [
  'oauth2.googleapis.com',
  'admin.googleapis.com',
  'www.googleapis.com',
  'chromemanagement.googleapis.com',
  'sheets.googleapis.com',
];
/** The scopes Campus Commander requests. The mock grants exactly this list. */
export const MOCK_SCOPES = GOOGLE_CAPABILITIES.map(
  (capability) => capability.scope,
);
/** The mock package path inside the repository and inside the mock container. */
const packagePath = 'node_modules/@campuscommander/admin-sdk-mock';
const cliPath = `${packagePath}/dist/bin/admin-sdk-mock.js`;

/** The version of the installed mock package. */
export async function installedMockVersion() {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), packagePath, 'package.json'), 'utf8'),
  );
  return manifest.version;
}

/**
 * Read the mock settings from the environment.
 * `CC_MOCK_TIER` wins. `CC_MOCK_TIER_DEFAULT` holds the default of the running
 * target. The fallback is small. Delays default to on.
 */
export function mockReviewSettings(env = process.env) {
  const tier = env.CC_MOCK_TIER ?? env.CC_MOCK_TIER_DEFAULT ?? 'small';
  assert.ok(
    MOCK_TIERS.includes(tier),
    `CC_MOCK_TIER must name one of ${MOCK_TIERS.join(', ')}.`,
  );
  const delays = env.CC_MOCK_DELAYS ?? 'on';
  assert.ok(
    ['on', 'off'].includes(delays),
    'CC_MOCK_DELAYS must be on or off.',
  );
  return { tier, delays: delays === 'on' };
}

/**
 * The container log from both streams, so a failure prints the mock's own reason.
 * `docker logs` writes the container stdout and stderr to its own two streams.
 * A failing call keeps its message on stderr.
 */
export function mockLog(name) {
  const result = spawnSync('docker', ['logs', name], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error)
    return `docker logs ${name} failed: ${result.error.message}\n`;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * Watch the mock container after its ready signal.
 *
 * The mock serves every Google call in mock mode. An exit after readiness must
 * fail the run, so the harness never continues against a stopped backend.
 * `failure` resolves with the container log when the mock stops.
 * `assertRunning` throws that log for callers that check between steps.
 * `exitedLog` returns the log without throwing.
 * `stop` ends the watch after the environment stops.
 */
export function watchAdminSdkMock({ docker, name }) {
  let exited = null;
  let settle;
  const failure = new Promise((resolve) => {
    settle = resolve;
  });
  const running = () => {
    try {
      return docker('inspect', '-f', '{{.State.Running}}', name).trim();
    } catch {
      return 'missing';
    }
  };
  const check = () => {
    if (exited !== null) return exited;
    if (running() === 'true') return null;
    exited = mockLog(name);
    clearInterval(timer);
    settle(exited);
    return exited;
  };
  const timer = setInterval(check, 1000);
  // The watch never holds the process open on its own.
  timer.unref();
  return {
    name,
    failure,
    /** The container log when the mock has exited, otherwise null. */
    exitedLog() {
      return check();
    },
    /** Throw the mock log when the container no longer runs. */
    assertRunning() {
      const log = check();
      if (log !== null) throw mockExitedError(log);
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/** The first line of the message a stopped mock raises. */
export const MOCK_EXIT_MESSAGE =
  'The Admin SDK mock exited after its ready signal.';

/** The message a stopped mock raises. The harness, the tests, and the runbook match this sentence. */
export function mockExitedMessage(log) {
  return `${MOCK_EXIT_MESSAGE}\n${log}`;
}

/** The error for a stopped mock. `cause` keeps the failure that reached it first. */
export function mockExitedError(log, cause) {
  return new Error(
    mockExitedMessage(log),
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Fail a mock-backed run when the mock stops.
 *
 * The reporter prints the container log once, at the moment the watch detects
 * the exit, so the diagnostic reaches the run output without waiting for the
 * run to end. `step` fails the current work and every later step: startup stops
 * at the exit, and the first request error never hides the stopped backend.
 * `check` fails callers that only test the state between steps.
 */
export function startMockExitGuard({
  watch,
  write = (text) => process.stderr.write(text),
}) {
  let reported = false;
  const report = (log = watch.exitedLog()) => {
    const entry = log ?? null;
    if (entry === null || reported) return entry;
    reported = true;
    write(`${mockExitedMessage(entry)}\n`);
    return entry;
  };
  // The guard reports the exit on its own. A rejected promise with no handler
  // ends the process, so both derived promises keep a handler.
  watch.failure.then(
    (log) => report(log),
    () => undefined,
  );
  const failure = watch.failure.then((log) => {
    throw mockExitedError(log);
  });
  failure.catch(() => undefined);
  return {
    /** Print the container log once. Returns the log, or null while the mock runs. */
    report,
    /** The failure that ends a guarded step or wait. */
    failure,
    /** Fail when the mock has already exited. */
    check() {
      watch.assertRunning();
    },
    /** True when the mock has exited. Loops use it to release the process. */
    exited() {
      return watch.exitedLog() !== null;
    },
    /** Fail before `run` starts, and during it, when the mock stops. */
    async step(run) {
      watch.assertRunning();
      // A step may return a value or a promise. Both reach the race.
      const attempt = Promise.resolve().then(run);
      // An abandoned step must not raise an unhandled rejection.
      attempt.catch(() => undefined);
      try {
        return await Promise.race([attempt, failure]);
      } catch (error) {
        // The abort already carries the log. Otherwise a step failure that
        // reached the harness first keeps its own error as the cause.
        if (error?.message?.startsWith(MOCK_EXIT_MESSAGE)) throw error;
        const log = watch.exitedLog();
        throw log === null ? error : mockExitedError(log, error);
      }
    },
  };
}

/**
 * Start the Admin SDK mock on the harness network and wait for its ready signal.
 *
 * The mock runs the pinned package from this checkout, mounted read-only, on the
 * pinned Node image. It exports its CA into the run directory and keeps its data in
 * a temporary directory there. The control port publishes on 127.0.0.1 at a free
 * port, never 8080. The ready file and the control listener gate the app start.
 */
export async function startAdminSdkMock({
  docker,
  directory,
  network,
  names,
  nodeImage,
  tier,
  delays,
  environment = {},
}) {
  const name = `${network}-mock`;
  names.push(name);
  const root = join(directory, 'admin-sdk-mock');
  await mkdir(join(root, 'credentials'), { recursive: true, mode: 0o700 });
  const configFile = join(root, 'admin-sdk-mock.json');
  const caFile = join(root, 'ca.pem');
  const readyFile = join(root, 'ready.json');
  const keyFile = join(root, 'credentials', `${MOCK_SEED}.json`);
  await writeFile(
    configFile,
    `${JSON.stringify(
      {
        dataDir: join(root, 'data'),
        caFile,
        readyFile,
        listen: {
          google: { host: '0.0.0.0', port: 443 },
          control: { host: '0.0.0.0', port: 8080 },
        },
        timing: { scale: 1, delays },
        domains: [
          {
            spec: {
              tier,
              seed: MOCK_SEED,
              name: MOCK_DISTRICT_NAME,
              primaryDomain: MOCK_PRIMARY_DOMAIN,
            },
            serviceAccounts: [{ out: keyFile, scopes: MOCK_SCOPES }],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--network',
    network,
    ...MOCK_GOOGLE_HOSTS.flatMap((host) => ['--network-alias', host]),
    ...Object.entries(environment).flatMap(([key, value]) => [
      '-e',
      `${key}=${value}`,
    ]),
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--workdir',
    '/mock',
    '-v',
    `${process.cwd()}/${packagePath}:/mock/${packagePath}:ro`,
    // The mock generates its CA with node-forge, its one runtime dependency.
    '-v',
    `${process.cwd()}/node_modules/node-forge:/mock/node_modules/node-forge:ro`,
    '-v',
    `${root}:${root}`,
    '-p',
    '127.0.0.1::8080',
    '-p',
    '127.0.0.1::443',
    nodeImage,
    'node',
    `/mock/${cliPath}`,
    'start',
    '--config',
    configFile,
  );
  const published = (port) => {
    try {
      return Number(docker('port', name, `${port}/tcp`).split(':').at(-1));
    } catch {
      return 0;
    }
  };
  const controlPort = published(8080);
  const googlePort = published(443);
  assert.ok(
    controlPort > 0,
    `The mock control port is not published.\n${mockLog(name)}`,
  );
  assert.notEqual(
    controlPort,
    8080,
    'The mock control port must never be 8080.',
  );
  assert.ok(
    googlePort > 0,
    `The mock Google port is not published.\n${mockLog(name)}`,
  );
  const controlUrl = `http://127.0.0.1:${controlPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 600; attempt++) {
    if (existsSync(readyFile)) {
      ready = true;
      break;
    }
    let running = 'false';
    try {
      running = docker('inspect', '-f', '{{.State.Running}}', name).trim();
    } catch {
      running = 'missing';
    }
    assert.equal(
      running,
      'true',
      `The Admin SDK mock exited before its ready signal.\n${mockLog(name)}`,
    );
    await delay(500);
  }
  assert.ok(
    ready,
    `The Admin SDK mock did not become ready within 300 seconds.\n${mockLog(name)}`,
  );
  // The mock must serve every later call. The watch fails the caller with the
  // container log when the mock exits after its ready signal.
  const watch = watchAdminSdkMock({ docker, name });
  const control = async (path) => {
    watch.assertRunning();
    const response = await fetch(`${controlUrl}${path}`);
    assert.equal(
      response.status,
      200,
      `The mock control API answered ${response.status} for ${path}.\n${mockLog(name)}`,
    );
    return response.json();
  };
  const health = await control('/health');
  assert.equal(health.status, 'ok', 'The mock control API is not healthy.');
  const version = await installedMockVersion();
  const readyEvent = JSON.parse(await readFile(readyFile, 'utf8'));
  assert.equal(
    readyEvent.version,
    version,
    'The running mock does not match the installed package version.',
  );
  const [domain] = readyEvent.domains;
  assert.ok(domain?.customerId, 'The mock ready event names no customer.');
  const counts = async () => (await control('/domains'))[0].counts;
  const mock = {
    name,
    watch,
    tier,
    delays,
    version,
    root,
    configFile,
    caFile,
    ca: await readFile(caFile, 'utf8'),
    keyFile,
    key: JSON.parse(await readFile(keyFile, 'utf8')),
    controlUrl,
    googlePort,
    customerId: domain.customerId,
    adminEmail: domain.adminEmail,
    deviceCount: (await counts()).devices,
    counts,
    quota: () => control(`/domains/${domain.customerId}/quota`),
  };
  return mock;
}
