import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GOOGLE_CAPABILITIES } from '../libs/application-contracts/src/lib/google-capabilities.ts';

/** The fixed review seed. A seed always yields the same customer ID and district. */
export const MOCK_SEED = 'campus-commander-review';
/** The tiers that CC_MOCK_TIER accepts. */
export const MOCK_TIERS = ['small', 'medium', 'large', 'xlarge'];
/** The hostnames the mock serves. The container carries them as network aliases. */
export const MOCK_GOOGLE_HOSTS = [
  'oauth2.googleapis.com',
  'admin.googleapis.com',
  'www.googleapis.com',
  'chromemanagement.googleapis.com',
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

/** Read the mock settings from the environment. The tier defaults to small and delays to on. */
export function mockReviewSettings(env = process.env) {
  const tier = env.CC_MOCK_TIER ?? 'small';
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

/** The container log, so a startup failure prints the mock's own reason. */
export function mockLog(name) {
  try {
    return execFileSync('docker', ['logs', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
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
            spec: { tier, seed: MOCK_SEED },
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
  const control = async (path) => {
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
