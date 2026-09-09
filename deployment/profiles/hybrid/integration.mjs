#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareHybrid } from './prepare.mjs';
import { renderHybrid } from './render.mjs';

const execute = promisify(execFile);
const kestraImage =
  'docker.io/kestra/kestra@sha256:c9e6551c671d8e13274b85f3ccafb945065b8e35e33cf2ea3eeff817d52e7114';
const postgresImage =
  'docker.io/library/postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280';
const workerImage =
  process.env.CC_HYBRID_WORKER_IMAGE ?? 'campus-commander/worker:cc-6';

async function run(file, args, options = {}) {
  return execute(file, args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
}

async function docker(args, options) {
  return run('docker', args, options);
}

async function waitFor(operation, seconds, description) {
  const deadline = Date.now() + seconds * 1000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${description} exceeded ${seconds} seconds.`, {
    cause: lastError,
  });
}

function request({
  port,
  servername,
  ca,
  authorization,
  method = 'GET',
  path,
  body,
  contentType,
}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: '127.0.0.1',
        port,
        servername,
        method,
        path,
        ca,
        headers: {
          ...(authorization ? { authorization } : {}),
          ...(contentType ? { 'content-type': contentType } : {}),
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
        },
        timeout: 5000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function signedCertificate(root, name, commonName, names, ca) {
  const key = join(root, `${name}-private-key`);
  const requestPath = join(root, `${name}.csr`);
  const certificate = join(root, `${name}-certificate`);
  const extension = join(root, `${name}.ext`);
  await run('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    `/CN=${commonName}`,
    '-keyout',
    key,
    '-out',
    requestPath,
  ]);
  await writeFile(
    extension,
    `subjectAltName=${names.map((name) => `DNS:${name}`).join(',')}\nextendedKeyUsage=serverAuth\n`,
  );
  await run('openssl', [
    'x509',
    '-req',
    '-days',
    '1',
    '-in',
    requestPath,
    '-CA',
    ca.certificate,
    '-CAkey',
    ca.key,
    '-CAcreateserial',
    '-extfile',
    extension,
    '-out',
    certificate,
  ]);
  await chmod(key, 0o600);
  await chmod(certificate, 0o600);
  return { certificate, key };
}

function multipart(fields) {
  const boundary = `cc-${randomBytes(16).toString('hex')}`;
  const body = `${Object.entries(fields)
    .map(
      ([name, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    )
    .join('')}--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function fileCount(path) {
  const entries = await readdir(path, { recursive: true });
  return entries.length;
}

export async function qualifyHybrid() {
  const runId = `cc-hybrid-${process.pid}-${randomBytes(4).toString('hex')}`;
  const root = await mkdtemp(join(tmpdir(), `${runId}-`));
  const privateRoot = join(root, 'private');
  const storageRoot = join(root, 'kestra-internal');
  const artifactRoot = join(root, 'artifacts');
  const network = `${runId}-network`;
  const database = `${runId}-postgres`;
  const worker = `${runId}-worker`;
  const kestra = `${runId}-kestra`;
  const databaseVolume = `${runId}-postgres-data`;
  let stage = 'prerequisites';
  let networkCreated = false;
  let volumeCreated = false;
  let databasePassword = '';

  try {
    for (const image of [kestraImage, postgresImage, workerImage]) {
      await docker(['image', 'inspect', image]);
    }
    await mkdir(privateRoot, { mode: 0o700 });
    await mkdir(storageRoot, { mode: 0o700 });
    await mkdir(artifactRoot, { mode: 0o700 });

    stage = 'certificates';
    const ca = {
      certificate: join(privateRoot, 'district-ca'),
      key: join(privateRoot, 'district-ca-private-key'),
    };
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=hybrid-qualification-ca',
      '-keyout',
      ca.key,
      '-out',
      ca.certificate,
    ]);
    const databaseTls = await signedCertificate(
      privateRoot,
      'database',
      'district-postgres',
      ['district-postgres'],
      ca,
    );
    const workerTls = await signedCertificate(
      privateRoot,
      'workers',
      'workers',
      ['workers'],
      ca,
    );
    await signedCertificate(privateRoot, 'kestra', 'kestra', ['kestra'], ca);
    await chmod(ca.certificate, 0o600);
    await chmod(ca.key, 0o600);

    stage = 'configuration';
    const source = JSON.parse(
      await readFile(
        new URL('../../examples/hybrid.json', import.meta.url),
        'utf8',
      ),
    );
    source.host.workerHosts = 1;
    source.services.workers.placement.replicas = 1;
    for (const name of ['applicationDatabase', 'kestraDatabase']) {
      source.services[name].endpoint.url =
        'postgresql://district-postgres:5432';
    }
    source.services.kestraDatabase.role = 'kestra';
    source.services.kestra.internalStorage.location = storageRoot;
    source.artifacts.location = artifactRoot;
    const configPath = join(root, 'hybrid.json');
    await writeFile(configPath, `${JSON.stringify(source, null, 2)}\n`);
    databasePassword = `Database-A1-${randomBytes(24).toString('base64url')}`;
    await writeFile(
      join(privateRoot, 'kestra-database-password'),
      `${databasePassword}\n`,
      { mode: 0o600 },
    );
    const prepared = await prepareHybrid(configPath, root);
    const release = {
      schemaVersion: 1,
      platform: 'linux/amd64',
      images: source.images,
    };
    const compose = renderHybrid(source, release);
    if (
      compose.services['kestra-postgres'] ||
      compose.services.redis ||
      !compose.services.kestra ||
      !compose.services.workers
    ) {
      throw new Error(
        'Hybrid rendering changed the selected service ownership.',
      );
    }
    if (
      !compose.services.kestra.volumes.some(
        (volume) =>
          volume.source === './runtime/kestra' && volume.read_only === true,
      ) ||
      !compose.services.kestra.healthcheck.test[1].includes('server-ca.pem')
    ) {
      throw new Error(
        'Hybrid Kestra runtime mounts or trust probes are invalid.',
      );
    }

    stage = 'district-database';
    const databaseEnvironment = join(root, 'database.env');
    await writeFile(
      databaseEnvironment,
      `POSTGRES_DB=kestra\nPOSTGRES_USER=kestra\nPOSTGRES_PASSWORD=${databasePassword}\nPGPASSWORD=${databasePassword}\n`,
      { mode: 0o600 },
    );
    await docker(['network', 'create', network]);
    networkCreated = true;
    await docker(['volume', 'create', databaseVolume]);
    volumeCreated = true;
    await docker([
      'run',
      '-d',
      '--name',
      database,
      '--network',
      network,
      '--network-alias',
      'district-postgres',
      '--env-file',
      databaseEnvironment,
      '-v',
      `${databaseVolume}:/var/lib/postgresql`,
      '-v',
      `${databaseTls.certificate}:/input/server.crt:ro`,
      '-v',
      `${databaseTls.key}:/input/server.key:ro`,
      '--tmpfs',
      '/run/postgres-tls:mode=0700',
      '--entrypoint',
      '/bin/sh',
      postgresImage,
      '-ec',
      'cp /input/server.crt /run/postgres-tls/server.crt\ncp /input/server.key /run/postgres-tls/server.key\nchown -R postgres:postgres /run/postgres-tls\nchmod 700 /run/postgres-tls\nchmod 600 /run/postgres-tls/server.key\nexec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/run/postgres-tls/server.crt -c ssl_key_file=/run/postgres-tls/server.key',
    ]);
    await waitFor(
      async () => {
        try {
          await docker([
            'exec',
            database,
            'pg_isready',
            '-U',
            'kestra',
            '-d',
            'kestra',
          ]);
          return true;
        } catch {
          return false;
        }
      },
      60,
      'District PostgreSQL readiness',
    );
    const tlsQuery = await docker([
      'run',
      '--rm',
      '--network',
      network,
      '--env-file',
      databaseEnvironment,
      '-v',
      `${ca.certificate}:/run/ca.pem:ro`,
      postgresImage,
      'psql',
      'host=district-postgres port=5432 dbname=kestra user=kestra sslmode=verify-full sslrootcert=/run/ca.pem',
      '-Atc',
      "select current_setting('ssl');",
    ]);
    if (tlsQuery.stdout.trim() !== 'on') {
      throw new Error('District PostgreSQL did not negotiate verified TLS.');
    }

    stage = 'local-runtime';
    await docker([
      'run',
      '-d',
      '--name',
      worker,
      '--network',
      network,
      '--network-alias',
      'workers',
      '-p',
      '127.0.0.1::3001',
      '-e',
      'WORKER_DISPATCH_SECRET_FILE=/run/secrets/dispatch',
      '-e',
      'REQUIRE_TLS=true',
      '-e',
      'TLS_CERT_FILE=/run/tls/server.pem',
      '-e',
      'TLS_KEY_FILE=/run/tls/server.key',
      '-e',
      'TLS_CA_FILE=/run/tls/ca.pem',
      '-v',
      `${join(privateRoot, 'worker-dispatch')}:/run/secrets/dispatch:ro`,
      '-v',
      `${workerTls.certificate}:/run/tls/server.pem:ro`,
      '-v',
      `${workerTls.key}:/run/tls/server.key:ro`,
      '-v',
      `${ca.certificate}:/run/tls/ca.pem:ro`,
      workerImage,
    ]);
    await docker([
      'run',
      '-d',
      '--name',
      kestra,
      '--network',
      network,
      '--network-alias',
      'kestra',
      '-p',
      '127.0.0.1::8080',
      '-v',
      `${join(root, 'runtime', 'kestra')}:/run/kestra-runtime:ro`,
      '-v',
      `${storageRoot}:/app/storage`,
      '--entrypoint',
      '/bin/sh',
      kestraImage,
      '-ec',
      'set -a\n. /run/kestra-runtime/flow-secrets.env\nset +a\nexec docker-entrypoint.sh server standalone --config /run/kestra-runtime/application.yaml',
    ]);
    const workerPort = Number(
      (await docker(['port', worker, '3001/tcp'])).stdout
        .trim()
        .split(':')
        .at(-1),
    );
    const kestraPort = Number(
      (await docker(['port', kestra, '8080/tcp'])).stdout
        .trim()
        .split(':')
        .at(-1),
    );
    const caBytes = await readFile(ca.certificate);
    const authentication = JSON.parse(
      await readFile(join(privateRoot, 'kestra-auth'), 'utf8'),
    );
    const basic = `Basic ${Buffer.from(`${authentication.username}:${authentication.password}`).toString('base64')}`;
    const readinessPath = '/api/v1/main/flows/search?size=1';
    await waitFor(
      async () => {
        try {
          return (
            (
              await request({
                port: kestraPort,
                servername: 'kestra',
                ca: caBytes,
                authorization: basic,
                path: readinessPath,
              })
            ).status === 200
          );
        } catch {
          return false;
        }
      },
      150,
      'Kestra authenticated readiness',
    );
    const unauthenticated = await request({
      port: kestraPort,
      servername: 'kestra',
      ca: caBytes,
      path: readinessPath,
    });
    if (unauthenticated.status !== 401) {
      throw new Error(
        'Kestra accepted an unauthenticated control-plane request.',
      );
    }
    const dispatchSecret = (
      await readFile(join(privateRoot, 'worker-dispatch'), 'utf8')
    ).trim();
    const directDispatch = await request({
      port: workerPort,
      servername: 'workers',
      ca: caBytes,
      authorization: `Bearer ${dispatchSecret}`,
      method: 'POST',
      path: '/dispatch/synthetic',
      contentType: 'application/json',
      body: JSON.stringify({
        executionId: 'hybrid-direct',
        correlationId: runId,
        marker: 'hybrid-private-ca',
      }),
    });
    if (directDispatch.status !== 200) {
      throw new Error('The worker rejected the verified synthetic dispatch.');
    }

    stage = 'synthetic-execution';
    const flow = await readFile(
      new URL('../../kestra/cc11-external-worker.yaml', import.meta.url),
      'utf8',
    );
    const upload = await request({
      port: kestraPort,
      servername: 'kestra',
      ca: caBytes,
      authorization: basic,
      method: 'POST',
      path: '/api/v1/main/flows',
      contentType: 'application/x-yaml',
      body: flow,
    });
    if (upload.status !== 200) {
      throw new Error(`Kestra flow upload returned ${upload.status}.`);
    }
    const correlationId = `hybrid-${randomBytes(8).toString('hex')}`;
    const executionRequest = multipart({
      correlationId,
      marker: 'hybrid-runtime-marker',
      delayMilliseconds: '0',
    });
    const executionStart = await request({
      port: kestraPort,
      servername: 'kestra',
      ca: caBytes,
      authorization: basic,
      method: 'POST',
      path: '/api/v1/main/executions/campus.validation/cc11_external_worker',
      ...executionRequest,
    });
    if (executionStart.status !== 200) {
      throw new Error(
        `Kestra execution start returned ${executionStart.status}.`,
      );
    }
    const executionId = JSON.parse(executionStart.body).id;
    const execution = await waitFor(
      async () => {
        const response = await request({
          port: kestraPort,
          servername: 'kestra',
          ca: caBytes,
          authorization: basic,
          path: `/api/v1/main/executions/${executionId}`,
        });
        if (response.status !== 200) return undefined;
        const current = JSON.parse(response.body);
        return ['SUCCESS', 'WARNING', 'FAILED', 'KILLED', 'CANCELLED'].includes(
          current.state.current,
        )
          ? current
          : undefined;
      },
      45,
      'Hybrid synthetic execution',
    );
    if (execution.state.current !== 'SUCCESS') {
      throw new Error(`Hybrid execution ended in ${execution.state.current}.`);
    }
    const storageUri = execution.taskRunList.find(
      ({ taskId }) => taskId === 'persist_result',
    )?.outputs?.uri;
    if (!storageUri?.startsWith('kestra://')) {
      throw new Error('The hybrid execution produced no internal-storage URI.');
    }
    const storageEntriesBefore = await fileCount(storageRoot);

    stage = 'district-database-outage';
    await docker(['stop', '--time', '3', database]);
    await waitFor(
      async () => {
        try {
          const response = await request({
            port: kestraPort,
            servername: 'kestra',
            ca: caBytes,
            authorization: basic,
            path: readinessPath,
          });
          return response.status !== 200;
        } catch {
          return true;
        }
      },
      20,
      'Kestra database outage observation',
    );
    const outageObservedAt = Date.now();
    await docker(['start', database]);
    await waitFor(
      async () => {
        try {
          await docker([
            'exec',
            database,
            'pg_isready',
            '-U',
            'kestra',
            '-d',
            'kestra',
          ]);
          return true;
        } catch {
          return false;
        }
      },
      60,
      'District PostgreSQL recovery',
    );
    await waitFor(
      async () => {
        try {
          return (
            (
              await request({
                port: kestraPort,
                servername: 'kestra',
                ca: caBytes,
                authorization: basic,
                path: readinessPath,
              })
            ).status === 200
          );
        } catch {
          return false;
        }
      },
      60,
      'Kestra recovery after district PostgreSQL restart',
    );
    const recoverySeconds = Math.ceil((Date.now() - outageObservedAt) / 1000);
    const preserved = await request({
      port: kestraPort,
      servername: 'kestra',
      ca: caBytes,
      authorization: basic,
      path: `/api/v1/main/executions/${executionId}`,
    });
    if (
      preserved.status !== 200 ||
      JSON.parse(preserved.body).state.current !== 'SUCCESS' ||
      (await fileCount(storageRoot)) < storageEntriesBefore
    ) {
      throw new Error(
        'Synthetic state did not survive district database recovery.',
      );
    }

    const workerImageId = (
      await docker(['image', 'inspect', workerImage, '--format', '{{.Id}}'])
    ).stdout.trim();
    return {
      checkedAt: new Date().toISOString(),
      status: 'PASS',
      sourceState: 'uncommitted workspace',
      images: {
        kestra: kestraImage,
        postgres: postgresImage,
        worker: workerImage,
        workerImageId,
      },
      preparation: {
        runtimeFiles: prepared.runtimeFiles,
        credentialStatuses: prepared.secrets.map(({ status }) => status),
        jdbcMode: 'verify-full',
      },
      placement: {
        localKestra: true,
        localReplacementDatabase: false,
        localReplacementRedis: false,
        simulatedHosts: 1,
      },
      trust: {
        databaseTls: 'verified private CA',
        kestraTls: 'verified private CA',
        workerTls: 'verified private CA',
        controlPlaneUnauthenticatedStatus: unauthenticated.status,
        workerAuthenticatedStatus: directDispatch.status,
      },
      execution: {
        id: executionId,
        correlationId,
        state: execution.state.current,
        storageUriSha256: createHash('sha256').update(storageUri).digest('hex'),
      },
      outage: {
        dependency: 'district PostgreSQL',
        observed: true,
        recoverySeconds,
        preservedExecutionState: true,
        preservedInternalStorage: true,
      },
      limits: [
        'The check simulates district endpoints on one Docker host.',
        'The check does not satisfy the distinct-host acceptance criterion.',
        'The check uses synthetic certificates and a harmless worker task.',
      ],
    };
  } catch (error) {
    const databaseDiagnostic = await docker([
      'logs',
      '--tail',
      '20',
      database,
    ]).catch(() => ({ stdout: '', stderr: '' }));
    const rawDiagnostic = `${databaseDiagnostic.stdout}${databaseDiagnostic.stderr}`;
    const diagnostic = (
      databasePassword
        ? rawDiagnostic.replaceAll(databasePassword, '<redacted>')
        : rawDiagnostic
    ).trim();
    throw new Error(
      `Hybrid integration failed during ${stage}: ${error.message}${diagnostic ? `\nDistrict PostgreSQL log:\n${diagnostic}` : ''}`,
      { cause: error },
    );
  } finally {
    await docker(['rm', '-f', kestra, worker, database]).catch(() => undefined);
    if (networkCreated) {
      await docker(['network', 'rm', network]).catch(() => undefined);
    }
    if (volumeCreated) {
      await docker(['volume', 'rm', databaseVolume]).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  qualifyHybrid()
    .then((result) =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    )
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
