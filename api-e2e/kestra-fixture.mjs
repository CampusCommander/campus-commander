import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { kestraImage } from '../deployment/profiles/all-docker/render.mjs';

/** Start real Kestra and worker processes inside the test-owned network. */
export async function startKestraFixture({
  docker,
  directory,
  network,
  names,
  config,
  secret,
  password,
  nodeImage,
  workerImage,
}) {
  const workerName = `${network}-worker`,
    kestraName = `${network}-kestra`;
  names.push(workerName, kestraName);
  config.services.workers.dispatchSecretRef = await secret(
    'worker-dispatch',
    password,
  );
  config.services.kestra.authSecretRef = await secret(
    'kestra-auth',
    JSON.stringify({
      username: 'phase2@example.invalid',
      password: `A1${password}`,
    }),
  );
  const runtime = join(directory, 'kestra-runtime');
  const storage = join(directory, 'kestra-storage');
  await mkdir(storage, { mode: 0o700 });
  execFileSync(process.execPath, ['deployment/kestra/render-config.mjs'], {
    stdio: 'pipe',
    env: {
      ...process.env,
      CC_KESTRA_PROFILE: 'all-docker',
      CC_KESTRA_RUNTIME_DIR: runtime,
      CC_KESTRA_RUNTIME_MOUNT_PATH: runtime,
      CC_KESTRA_AUTH_FILE: join(directory, 'secrets/kestra-auth'),
      CC_KESTRA_DATABASE_PASSWORD_FILE: join(
        directory,
        'secrets/kestra-password',
      ),
      CC_KESTRA_DATABASE_URL: `jdbc:postgresql://${names[0]}:5432/cc-kestra`,
      CC_KESTRA_DATABASE_USERNAME: 'cc-kestra',
      CC_KESTRA_URL: `http://${kestraName}:8080`,
      CC_KESTRA_STORAGE_PATH: storage,
      CC_KESTRA_WORKER_BASE_URL: `http://${workerName}:3001`,
      CC_KESTRA_WORKER_DISPATCH_SECRET_FILE: join(
        directory,
        'secrets/worker-dispatch',
      ),
    },
  });
  const environment = JSON.parse(
    await readFile(join(runtime, 'runtime-environment.json'), 'utf8'),
  );
  const environmentPath = join(directory, 'kestra.env');
  await writeFile(
    environmentPath,
    Object.entries(environment)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    { mode: 0o600 },
  );
  docker(
    'run',
    '-d',
    '--name',
    workerName,
    '--network',
    network,
    '-p',
    '127.0.0.1::3001',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    ...(workerImage
      ? []
      : ['-v', `${process.cwd()}/dist/worker/main.js:/app/main.js:ro`]),
    '-v',
    `${directory}:${directory}:ro`,
    '-e',
    `WORKER_DISPATCH_SECRET_FILE=${join(directory, 'secrets/worker-dispatch')}`,
    workerImage ?? nodeImage,
    'node',
    '/app/main.js',
  );
  const startKestra = (listenerPort = '') =>
    docker(
      'run',
      '-d',
      '--name',
      kestraName,
      '--network',
      network,
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '--env-file',
      environmentPath,
      '-v',
      `${directory}:${directory}`,
      '-p',
      `127.0.0.1:${listenerPort}:8080`,
      kestraImage,
      'server',
      'standalone',
      '--config',
      join(runtime, 'application.yaml'),
    );
  startKestra();
  const port = Number(docker('port', kestraName, '8080/tcp').split(':').at(-1));
  const origin = `http://127.0.0.1:${port}`;
  const authorization = `Basic ${Buffer.from(`phase2@example.invalid:A1${password}`).toString('base64')}`;
  const waitReady = async () => {
    let ready = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      try {
        ready = (
          await fetch(`${origin}/api/v1/main/flows/search?size=1`, {
            headers: { authorization },
            signal: AbortSignal.timeout(2000),
          })
        ).ok;
        if (ready) break;
      } catch {
        /* Wait for the isolated Kestra listener. */
      }
      await delay(500);
    }
    assert.equal(ready, true, 'Kestra did not become ready.');
  };
  await waitReady();
  assert.equal(
    (await fetch(`${origin}/api/v1/main/flows/search?size=1`)).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/v1/main/flows/search?size=1`, {
        headers: { authorization: 'Basic aW52YWxpZA==' },
      })
    ).status,
    401,
  );
  const workerPort = Number(
    docker('port', workerName, '3001/tcp').split(':').at(-1),
  );
  let workerOrigin = `http://127.0.0.1:${workerPort}`;
  const rotateWorker = async (replacement) => {
    await writeFile(join(directory, 'secrets/worker-dispatch'), replacement, {
      mode: 0o600,
    });
    docker('restart', workerName);
    workerOrigin = `http://127.0.0.1:${Number(docker('port', workerName, '3001/tcp').split(':').at(-1))}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`${workerOrigin}/health/live`)).ok) return;
      } catch {
        /* Await worker restart. */
      }
      await delay(100);
    }
    assert.fail('The worker did not restart.');
  };
  const rotateKestraDispatch = async (replacement) => {
    environment.SECRET_CC_WORKER_DISPATCH_TOKEN =
      Buffer.from(replacement).toString('base64');
    await writeFile(
      environmentPath,
      Object.entries(environment)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
      { mode: 0o600 },
    );
    docker('rm', '-f', kestraName);
    startKestra(port);
    await waitReady();
  };
  config.services.kestra.endpoint.url = `http://${kestraName}:8080`;
  return {
    workerName,
    kestraName,
    origin,
    authorization,
    get workerOrigin() {
      return workerOrigin;
    },
    rotateWorker,
    rotateKestraDispatch,
  };
}
