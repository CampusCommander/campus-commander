import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = await mkdtemp('/tmp/cc-phase2-kestra-db-probe-');
const network = 'cc-kestra-probe-' + randomUUID();
const db = network + '-db',
  kestra = network + '-kestra';
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
import {
  postgresImage as dbImage,
  kestraImage,
} from '../profiles/all-docker/render.mjs';
const password = 'A1' + randomUUID();
const auth =
  'Basic ' +
  Buffer.from('probe@example.invalid:' + password).toString('base64');
const report = {
  status: 'in-progress',
  purpose: 'focused-database-recovery-probe',
  recordedAt: new Date().toISOString(),
  images: { postgres: dbImage, kestra: kestraImage },
  terminationGracePeriod:
    process.env.CC_KESTRA_TERMINATION_GRACE_PERIOD ?? '5m',
  recoveryBoundSeconds: 120,
  samples: [],
  limits: [
    'Synthetic standalone Kestra and PostgreSQL only. This probe does not qualify a deployment profile.',
    'The focused probe does not apply deployment resource limits.',
    'Task completion is the recovery signal. An HTTP 200 response alone does not establish orchestration recovery.',
    'JVM signals capture private thread dumps. Raw logs remain in the private fixture directory.',
  ],
};
console.log(JSON.stringify({ root, network, db, kestra }));
let origin;
const request = async (path, options = {}) =>
  fetch(origin + path, {
    ...options,
    headers: { authorization: auth, ...options.headers },
    signal: AbortSignal.timeout(1500),
  });
async function flowRun() {
  const r = await request('/api/v1/main/executions/campus.probe/db_recovery', {
    method: 'POST',
  });
  if (!r.ok) return null;
  return (await r.json()).id;
}
async function completed(id) {
  if (!id) return false;
  const r = await request('/api/v1/main/executions/' + id);
  return r.ok && (await r.json()).state.current === 'SUCCESS';
}
try {
  docker('network', 'create', network);
  docker(
    'run',
    '-d',
    '--name',
    db,
    '--network',
    network,
    '-e',
    'POSTGRES_PASSWORD=' + password,
    dbImage,
  );
  for (let n = 0; n < 100; n++) {
    try {
      docker('exec', db, 'pg_isready', '-U', 'postgres');
      break;
    } catch {
      await delay(200);
    }
  }
  await writeFile(
    join(root, 'auth'),
    JSON.stringify({ username: 'probe@example.invalid', password }),
    { mode: 0o600 },
  );
  await writeFile(join(root, 'db-password'), password, { mode: 0o600 });
  execFileSync(process.execPath, ['deployment/kestra/render-config.mjs'], {
    stdio: 'pipe',
    env: {
      ...process.env,
      CC_KESTRA_PROFILE: 'all-docker',
      CC_KESTRA_RUNTIME_DIR: root,
      CC_KESTRA_AUTH_FILE: join(root, 'auth'),
      CC_KESTRA_DATABASE_PASSWORD_FILE: join(root, 'db-password'),
      CC_KESTRA_DATABASE_URL: `jdbc:postgresql://${db}:5432/postgres`,
      CC_KESTRA_DATABASE_USERNAME: 'postgres',
      CC_KESTRA_URL: 'http://localhost:8080',
      CC_KESTRA_STORAGE_PATH: join(root, 'storage'),
    },
  });
  docker(
    'run',
    '-d',
    '--name',
    kestra,
    '--network',
    network,
    '--restart',
    'unless-stopped',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '-v',
    `${root}:${root}`,
    '-p',
    '127.0.0.1::8080',
    kestraImage,
    'server',
    'standalone',
    '--config',
    join(root, 'application.yaml'),
  );
  origin =
    'http://127.0.0.1:' + docker('port', kestra, '8080/tcp').split(':').at(-1);
  let ready = false;
  for (let n = 0; n < 180; n++) {
    try {
      if ((await request('/api/v1/main/flows/search?size=1')).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Record unavailability until the next bounded observation. */
    }
    await delay(500);
  }
  assert.ok(ready, 'Kestra did not start.');
  const flow =
    'id: db_recovery\nnamespace: campus.probe\ntasks:\n  - id: log\n    type: io.kestra.plugin.core.log.Log\n    message: synthetic recovery probe\n';
  const created = await request('/api/v1/main/flows', {
    method: 'POST',
    headers: { 'content-type': 'application/x-yaml' },
    body: flow,
  });
  assert.equal(created.status, 200);
  const before = await flowRun();
  let baseline = false;
  for (let n = 0; n < 60; n++) {
    if (await completed(before)) {
      baseline = true;
      break;
    }
    await delay(250);
  }
  assert.ok(baseline, 'Baseline task did not complete.');
  report.baselineExecution = before;
  report.interruptedAt = new Date().toISOString();
  docker('stop', db);
  await delay(1000);
  docker('start', db);
  report.databaseStartedAt = new Date().toISOString();
  const started = Date.now();
  let next,
    success = false;
  const dumps = new Set();
  for (let n = 0; Date.now() - started < 120000; n++) {
    const elapsedMs = Date.now() - started;
    for (const threshold of [10000, 45000, 80000])
      if (elapsedMs >= threshold && !dumps.has(threshold)) {
        dumps.add(threshold);
        try {
          docker('exec', kestra, 'sh', '-c', 'kill -QUIT "$(pidof java)"');
        } catch {
          /* Record unavailability until the next bounded observation. */
        }
      }
    const state = JSON.parse(docker('inspect', kestra))[0];
    const binding = state.NetworkSettings.Ports?.['8080/tcp']?.[0]?.HostPort;
    if (binding) origin = 'http://127.0.0.1:' + binding;
    let httpStatus = null;
    try {
      const r = await request('/api/v1/main/flows/search?size=1');
      httpStatus = r.status;
      if (r.ok && !next) next = await flowRun();
      if (next) success = await completed(next);
    } catch {
      /* Record unavailability until the next bounded observation. */
    }
    const sample = {
      elapsedMs,
      httpStatus,
      restartCount: state.RestartCount,
      status: state.State.Status,
      pid: state.State.Pid,
      port: binding,
    };
    report.samples.push(sample);
    if (n % 10 === 0) console.log(JSON.stringify(sample));
    if (success) break;
    await delay(500);
  }
  report.recoveryMs = Date.now() - started;
  report.recoveredExecution = next;
  report.status = success ? 'passed' : 'failed';
  assert.ok(
    success,
    'Kestra did not complete a task within 120 seconds after database recovery.',
  );
  assert.ok(await completed(before), 'The previous execution was lost.');
} catch (error) {
  report.status = 'failed';
  report.message =
    error instanceof assert.AssertionError
      ? error.message
      : 'The focused probe command failed. Inspect the private fixture.';
  await writeFile(join(root, 'failure-private.txt'), String(error.stack), {
    mode: 0o600,
  });
  process.exitCode = 1;
} finally {
  const logs = spawnSync('docker', ['logs', '--timestamps', kestra], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const privateLog = String(logs.stdout ?? '') + String(logs.stderr ?? '');
  await writeFile(join(root, 'kestra-private.log'), privateLog, {
    mode: 0o600,
  });
  report.privateLogSha256 = createHash('sha256')
    .update(privateLog)
    .digest('hex');
  const cleanupFailures = [];
  for (const name of [kestra, db]) {
    try {
      docker('rm', '-f', '-v', name);
    } catch {
      cleanupFailures.push(name);
    }
  }
  try {
    docker('network', 'rm', network);
  } catch {
    cleanupFailures.push(network);
  }
  report.ownedResourcesRemoved = cleanupFailures.length === 0;
  if (cleanupFailures.length) {
    report.status = 'failed';
    report.cleanupFailures = cleanupFailures;
    process.exitCode = 1;
  }
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  await mkdir('dist/phase-2-evidence', { recursive: true });
  await writeFile(
    'dist/phase-2-evidence/kestra-database-recovery-probe.json',
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      status: report.status,
      recoveryMs: report.recoveryMs,
      message: report.message,
      root,
    }),
  );
}
