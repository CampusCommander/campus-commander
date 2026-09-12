#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { prepareHybrid } from './prepare.mjs';
import { renderFiles } from './render.mjs';
import {
  boundedArtifactVolumeArguments,
  useBoundedArtifactVolume,
  verifyBoundedArtifactVolume,
} from './cc18-faults.mjs';
import { qualificationImages } from '../../qualification/images.mjs';
import { applicationRedisAcl } from '../../redis/runtime.mjs';

const execute = promisify(execFile);
const {
  frontend: frontendImage,
  api: apiImage,
  worker: workerImage,
} = qualificationImages({
  frontend:
    'localhost:15000/campus-commander/frontend@sha256:9ae5b788f8c21da072d1cf1b6cd506c0ed3abd1b5aab4d7e7110f97e144e5842',
  api: 'localhost:15000/campus-commander/api@sha256:73cd46ece723ff04d0369ad755c202debb1b07e59527e65a25abc53c1ae3f6f5',
  worker:
    'localhost:15000/campus-commander/worker@sha256:6e692bc185bcadb36ea1378aa5a321faa98c8fbf760058c5695dbad528688f0a',
});
const kestraImage =
  'docker.io/kestra/kestra@sha256:c9e6551c671d8e13274b85f3ccafb945065b8e35e33cf2ea3eeff817d52e7114';
const postgresImage =
  'docker.io/library/postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280';
const redisImage =
  'redis:8.0.5-alpine@sha256:6c8e66693fa71bad36ae06c75c990446ad01dbd4b081dd847eb9869f20d7c6ee';
const retainFixture = process.env.CC_HYBRID_KEEP_FIXTURE === 'true';
const processFaultMode = process.env.CC_HYBRID_PROCESS_FAULTS === 'true';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const checksum = (value) =>
  createHash('sha256')
    .update(
      typeof value === 'string' ? value : JSON.stringify(canonical(value)),
    )
    .digest('hex');
async function internalFileChecksums(root, relative = '') {
  const result = [];
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory())
      result.push(...(await internalFileChecksums(root, path)));
    else {
      if (!entry.isFile())
        throw new Error(
          'The synthetic storage tree contains an unsupported entry.',
        );
      result.push({
        path,
        sha256: createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

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

async function compose(project, file, args, options) {
  return docker(['compose', '-p', project, '-f', file, ...args], options);
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
  timeoutMilliseconds = 5000,
}) {
  return new Promise((resolve, reject) => {
    const client = https.request(
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
        timeout: timeoutMilliseconds,
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
    client.on('timeout', () => client.destroy(new Error('request timeout')));
    client.on('error', reject);
    if (body) client.write(body);
    client.end();
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

async function writeSecret(root, name, value) {
  const path = join(root, name);
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
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

async function publishedPort(project, file, service, port) {
  const output = await compose(project, file, ['port', service, String(port)]);
  const value = Number(output.stdout.trim().split(':').at(-1));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`No published fixture port exists for ${service}.`);
  }
  return value;
}

async function containerId(project, file, service) {
  const result = await compose(project, file, ['ps', '-q', service]);
  const id = result.stdout.trim();
  if (!id) throw new Error(`No container exists for ${service}.`);
  return id;
}

async function containerHealth(id) {
  const result = await docker([
    'inspect',
    id,
    '--format',
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
  ]);
  return result.stdout.trim();
}

async function availablePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      servers.push(server);
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve);
          }),
      ),
    );
  }
}

async function configureRuntimeCompose(
  path,
  externalNetwork,
  { controller = false, boundedArtifact } = {},
) {
  let document = JSON.parse(await readFile(path, 'utf8'));
  let artifactConsumers = [];
  document.networks.egress = { external: true, name: externalNetwork };
  if (boundedArtifact) {
    const bounded = useBoundedArtifactVolume(document, boundedArtifact);
    document = bounded.document;
    artifactConsumers = bounded.consumers;
  }
  if (controller) {
    const [edgePort, apiPort, kestraPort] = await availablePorts(3);
    document.services.edge.ports = [`127.0.0.1:${edgePort}:8443`];
    document.services.api.ports = [`127.0.0.1:${apiPort}:3000`];
    document.services.kestra.ports = [`127.0.0.1:${kestraPort}:8080`];
  } else {
    delete document.services.workers.ports;
  }
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
  return { document, artifactConsumers };
}

async function checkArtifact(workerId, path) {
  const result = await docker([
    'exec',
    workerId,
    'node',
    '-e',
    `const f=require('node:fs'),c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(f.readFileSync(${JSON.stringify(path)})).digest('hex'))`,
  ]);
  return result.stdout.trim();
}

async function writeContainerFile(container, path, bytes) {
  await docker([
    'exec',
    container,
    'node',
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(path)},Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'),{mode:0o600,flag:'wx'})`,
  ]);
}

async function verifyPostgresCertificateFault(container) {
  const probe = `import fs from 'node:fs/promises';import net from 'node:net';import tls from 'node:tls';import {connectionOptions} from '/app/deployment/postgres/index.mjs';import {secretPath} from '/app/deployment/redis/runtime.mjs';const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));const options=await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r)));const connect=servername=>new Promise((resolve,reject)=>{const socket=net.createConnection({host:options.host,port:options.port??5432});socket.setTimeout(5000,()=>socket.destroy(Error('PostgreSQL TLS probe timed out.')));socket.once('error',reject);socket.once('connect',()=>socket.write(Buffer.from([0,0,0,8,4,210,22,47])));socket.once('data',bytes=>{if(bytes[0]!==83){socket.destroy();reject(Error('PostgreSQL rejected TLS.'));return}socket.removeAllListeners();const client=tls.connect({socket,servername,ca:options.ssl.ca,rejectUnauthorized:true});client.setTimeout(5000,()=>client.destroy(Error('PostgreSQL TLS handshake timed out.')));client.once('secureConnect',()=>{const authorized=client.authorized;client.destroy();resolve(authorized)});client.once('error',reject)});});const served=await connect('wrong-postgres.invalid');let rejectionCode;try{await connect(options.host)}catch(error){rejectionCode=error.code}if(!served||rejectionCode!=='ERR_TLS_CERT_ALTNAME_INVALID')throw Error('PostgreSQL did not serve the injected hostname certificate.');process.stdout.write(JSON.stringify({injectedCertificateServed:true,districtHostnameRejected:true,rejectionCode}));`;
  return JSON.parse(
    (
      await docker([
        'exec',
        container,
        'node',
        '--input-type=module',
        '-e',
        probe,
      ])
    ).stdout,
  );
}

function readyStatus(response) {
  if (response.status !== 200) return undefined;
  const status = JSON.parse(response.body);
  const names = status.checks.map(({ name }) => name).sort();
  const expected = [
    'api',
    'application-database',
    'artifacts',
    'frontend',
    'kestra',
    'kestra-database',
    'process-started',
    'redis',
    'workers',
  ];
  if (
    status.status !== 'ready' ||
    names.join(',') !== expected.sort().join(',') ||
    status.checks.some(({ status }) => status !== 'ready')
  ) {
    return undefined;
  }
  return status;
}

export async function qualifyFullHybrid({ application } = {}) {
  const startedAt = Date.now();
  const runId = `cc-hybrid-full-${process.pid}-${randomBytes(4).toString('hex')}`;
  const root = await mkdtemp(join(tmpdir(), `${runId}-`));
  const privateRoot = join(root, 'private');
  const storageRoot = join(root, 'kestra-internal');
  const artifactVolumeRoot = join(root, 'artifact-volume');
  const artifactRoot = join(artifactVolumeRoot, 'artifacts');
  const controllerFile = join(root, 'docker-compose.controller.yml');
  const workerFiles = [
    join(root, 'docker-compose.worker-1.yml'),
    join(root, 'docker-compose.worker-2.yml'),
  ];
  const projects = {
    controller: `${runId}-controller`,
    workers: [`${runId}-worker-1`, `${runId}-worker-2`],
  };
  const externalNetwork = `${runId}-district`;
  const databaseContainer = `${runId}-district-postgres`;
  const redisContainer = `${runId}-district-redis`;
  const databaseVolume = `${runId}-postgres-data`;
  const artifactVolume = `${runId}-artifacts`;
  const registryContainer = 'cc13-registry';
  const created = {
    network: false,
    databaseVolume: false,
    artifactVolume: false,
    database: false,
    redis: false,
    controller: false,
    workers: [false, false],
  };
  const cleanup = async ({ strict = false, retainRoot = false } = {}) => {
    const failures = [];
    const attempt = async (operation) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    if (created.controller) {
      await attempt(() =>
        compose(projects.controller, controllerFile, [
          'down',
          '--volumes',
          '--remove-orphans',
          '--timeout',
          '3',
        ]),
      );
    }
    for (let index = 0; index < workerFiles.length; index += 1) {
      if (created.workers[index]) {
        await attempt(() =>
          compose(projects.workers[index], workerFiles[index], [
            'down',
            '--volumes',
            '--remove-orphans',
            '--timeout',
            '3',
          ]),
        );
      }
    }
    for (const [present, name] of [
      [created.redis, redisContainer],
      [created.database, databaseContainer],
    ]) {
      if (present && name.startsWith(runId)) {
        await attempt(() => docker(['rm', '-f', name]));
      }
    }
    if (created.databaseVolume && databaseVolume.startsWith(runId)) {
      await attempt(() => docker(['volume', 'rm', databaseVolume]));
    }
    if (created.artifactVolume && artifactVolume === `${runId}-artifacts`) {
      await attempt(async () => {
        const details = JSON.parse(
          (await docker(['volume', 'inspect', artifactVolume])).stdout,
        )[0];
        verifyBoundedArtifactVolume(details, artifactVolume, runId);
        await docker(['volume', 'rm', artifactVolume]);
      });
    }
    if (created.network && externalNetwork.startsWith(runId)) {
      await attempt(() => docker(['network', 'rm', externalNetwork]));
    }
    if (!retainRoot && failures.length === 0)
      await attempt(() => rm(root, { recursive: true, force: true }));
    if (strict && failures.length) {
      throw new AggregateError(
        failures,
        'Owned hybrid fixture cleanup failed.',
      );
    }
    return failures.length === 0;
  };
  let stage = 'prerequisites';
  let completedResult;
  let failure;

  try {
    const usesFixtureRegistry = [frontendImage, apiImage, workerImage].some(
      (image) => image.startsWith('localhost:15000/'),
    );
    if (usesFixtureRegistry) {
      const registryState = (
        await docker([
          'inspect',
          registryContainer,
          '--format',
          '{{.State.Status}}',
        ])
      ).stdout.trim();
      if (registryState !== 'running') {
        await docker(['start', registryContainer]);
      }
      await waitFor(
        async () => {
          try {
            const result = await run('curl', [
              '--fail',
              '--silent',
              'http://127.0.0.1:15000/v2/',
            ]);
            return result.stdout.trim() === '{}';
          } catch {
            return false;
          }
        },
        15,
        'Private registry readiness',
      );
    }
    for (const image of [
      frontendImage,
      apiImage,
      workerImage,
      kestraImage,
      postgresImage,
      redisImage,
    ]) {
      try {
        await docker(['image', 'inspect', image]);
      } catch {
        await docker(['pull', image]);
        await docker(['image', 'inspect', image]);
      }
    }

    await mkdir(privateRoot, { mode: 0o700 });
    await mkdir(storageRoot, { mode: 0o700 });
    await mkdir(artifactRoot, { mode: 0o700, recursive: true });

    stage = 'certificates-and-secrets';
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
      '/CN=hybrid-full-qualification-ca',
      '-keyout',
      ca.key,
      '-out',
      ca.certificate,
    ]);
    await chmod(ca.certificate, 0o600);
    await chmod(ca.key, 0o600);
    const databaseTls = await signedCertificate(
      privateRoot,
      'district-postgres',
      'district-postgres',
      ['district-postgres'],
      ca,
    );
    const redisTls = await signedCertificate(
      privateRoot,
      'district-redis',
      'district-redis',
      ['district-redis'],
      ca,
    );
    for (const [name, host] of [
      ['frontend', 'frontend'],
      ['api', 'api'],
      ['workers', 'workers'],
      ['kestra', 'kestra'],
      ['edge', 'campus.example.org'],
    ]) {
      await signedCertificate(privateRoot, name, host, [host], ca);
    }

    const credentials = {
      admin: randomBytes(32).toString('base64url'),
      application: randomBytes(32).toString('base64url'),
      kestra: randomBytes(32).toString('base64url'),
      migrator: randomBytes(32).toString('base64url'),
      redis: randomBytes(32).toString('base64url'),
    };
    await Promise.all([
      writeSecret(
        privateRoot,
        'district-postgres-admin-password',
        credentials.admin,
      ),
      writeSecret(
        privateRoot,
        'campus-database-password',
        credentials.application,
      ),
      writeSecret(privateRoot, 'kestra-database-password', credentials.kestra),
      writeSecret(privateRoot, 'postgres-migrator', credentials.migrator),
      writeSecret(privateRoot, 'redis-password', credentials.redis),
    ]);

    stage = 'render-and-validate';
    const source = JSON.parse(
      await readFile(
        new URL('../../examples/hybrid.json', import.meta.url),
        'utf8',
      ),
    );
    source.images = application?.baseline?.images ?? {
      frontend: frontendImage,
      api: apiImage,
      workers: workerImage,
    };
    for (const name of ['applicationDatabase', 'kestraDatabase']) {
      source.services[name].endpoint.url =
        'postgresql://district-postgres:5432';
    }
    source.services.redis.endpoint.url = 'rediss://district-redis:6379';
    source.services.edge.endpoint.tls = {
      mode: 'private-ca',
      caSecretRef: {
        provider: 'file',
        path: '/run/secrets/district-ca',
      },
    };
    source.services.kestra.internalStorage.location = storageRoot;
    source.artifacts.location = artifactRoot;
    if (application && !application.baseline) {
      source.phase = 2;
      source.applicationAuth = application.auth;
      source.services.edge.access = 'application';
      source.services.edge.endpoint.url = application.auth.publicOrigin;
      await writeSecret(privateRoot, 'oidc-client', application.password);
    }
    const configPath = join(root, 'hybrid.json');
    const releasePath = join(root, 'release.json');
    await writeFile(configPath, `${JSON.stringify(source, null, 2)}\n`);
    await writeFile(
      releasePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          architectures: ['linux/amd64'],
          images: source.images,
        },
        null,
        2,
      )}\n`,
    );
    const prepared = await prepareHybrid(configPath, root);
    const operator = {
      adminDatabase: 'postgres',
      adminRole: 'postgres',
      adminPasswordSecretRef: {
        provider: 'file',
        path: '/run/secrets/district-postgres-admin-password',
      },
      migrationRole: 'application-installer',
      migrationPasswordSecretRef: {
        provider: 'file',
        path: '/run/secrets/postgres-migrator',
      },
    };
    await writeFile(
      join(root, 'runtime', 'operator.json'),
      `${JSON.stringify(operator, null, 2)}\n`,
      { mode: 0o600 },
    );
    await renderFiles(configPath, releasePath, controllerFile, {
      workerBindAddresses: ['10.20.30.41', '10.20.30.42'],
    });
    const boundedArtifact = processFaultMode
      ? { artifactRoot, volumeName: artifactVolume }
      : undefined;
    const controllerRuntime = await configureRuntimeCompose(
      controllerFile,
      externalNetwork,
      { controller: true, boundedArtifact },
    );
    const controller = controllerRuntime.document;
    if (application) {
      controller.services.edge.ports = [
        `127.0.0.1:${new URL(application.auth.publicOrigin).port}:8443`,
      ];
      controller.services.api.environment.NODE_EXTRA_CA_CERTS =
        '/run/qualification/provider-ca';
      controller.services.api.extra_hosts = [
        'host.docker.internal:host-gateway',
      ];
      controller.services.api.volumes.push({
        type: 'bind',
        source: application.caFile,
        target: '/run/qualification/provider-ca',
        read_only: true,
      });
      await writeFile(
        controllerFile,
        `${JSON.stringify(controller, null, 2)}\n`,
      );
    }
    const workerRuntimes = await Promise.all(
      workerFiles.map((path) =>
        configureRuntimeCompose(path, externalNetwork, { boundedArtifact }),
      ),
    );
    const workerDocuments = workerRuntimes.map(({ document }) => document);
    const artifactConsumers = [
      ...controllerRuntime.artifactConsumers.map(
        (service) => `${projects.controller}:${service}`,
      ),
      ...workerRuntimes.flatMap(({ artifactConsumers }, index) =>
        artifactConsumers.map(
          (service) => `${projects.workers[index]}:${service}`,
        ),
      ),
    ];
    if (
      controller.services['application-postgres'] ||
      controller.services['kestra-postgres'] ||
      controller.services.redis ||
      controller.services.workers ||
      !controller.services.frontend ||
      !controller.services.api ||
      !controller.services.kestra ||
      !controller.services.edge ||
      workerDocuments.some(
        (document) =>
          Object.keys(document.services).sort().join(',') !==
          'runtime-files,storage-preflight,workers',
      )
    ) {
      throw new Error('Rendered ownership differs from the hybrid placement.');
    }

    created.network = true;
    await docker(['network', 'create', externalNetwork]);
    if (processFaultMode) {
      created.artifactVolume = true;
      await docker(boundedArtifactVolumeArguments(artifactVolume, runId));
      const details = JSON.parse(
        (await docker(['volume', 'inspect', artifactVolume])).stdout,
      )[0];
      verifyBoundedArtifactVolume(details, artifactVolume, runId);
      if (
        artifactConsumers.length !== 6 ||
        !artifactConsumers.every((name) =>
          /:(api|workers|storage-preflight)$/.test(name),
        )
      ) {
        throw new Error(
          'The bounded artifact volume does not cover every live consumer.',
        );
      }
    }
    for (const [project, file] of [
      [projects.controller, controllerFile],
      [projects.workers[0], workerFiles[0]],
      [projects.workers[1], workerFiles[1]],
    ]) {
      await compose(project, file, ['config', '--quiet']);
    }

    stage = 'district-postgresql';
    created.databaseVolume = true;
    await docker(['volume', 'create', databaseVolume]);
    created.database = true;
    await docker([
      'run',
      '-d',
      '--name',
      databaseContainer,
      '--network',
      externalNetwork,
      '--network-alias',
      'district-postgres',
      '-e',
      'POSTGRES_PASSWORD_FILE=/run/secrets/admin-password',
      '-v',
      `${join(privateRoot, 'district-postgres-admin-password')}:/run/secrets/admin-password:ro`,
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
            databaseContainer,
            'pg_isready',
            '-U',
            'postgres',
            '-d',
            'postgres',
          ]);
          return true;
        } catch {
          return false;
        }
      },
      60,
      'District PostgreSQL readiness',
    );
    await docker([
      'run',
      '--rm',
      '--network',
      externalNetwork,
      '--read-only',
      '--tmpfs',
      '/tmp:uid=1000,gid=1000,mode=0700',
      '-v',
      `${join(root, 'runtime', 'profile.json')}:/run/config/profile.json:ro`,
      '-v',
      `${join(root, 'runtime', 'operator.json')}:/run/config/operator.json:ro`,
      '-v',
      `${ca.certificate}:/run/secrets/district-ca:ro`,
      '-v',
      `${join(privateRoot, 'district-postgres-admin-password')}:/run/secrets/district-postgres-admin-password:ro`,
      '-v',
      `${join(privateRoot, 'campus-database-password')}:/run/secrets/campus-database-password:ro`,
      '-v',
      `${join(privateRoot, 'kestra-database-password')}:/run/secrets/kestra-database-password:ro`,
      '-v',
      `${join(privateRoot, 'postgres-migrator')}:/run/secrets/postgres-migrator:ro`,
      source.images.api,
      'node',
      '/app/deployment/postgres/cli.mjs',
      'provision',
      '/run/config/profile.json',
      '/run/config/operator.json',
    ]);

    stage = 'district-redis';
    const redisConfiguration = join(root, 'redis.conf');
    const passwordHash = createHash('sha256')
      .update(credentials.redis)
      .digest('hex');
    await writeFile(
      redisConfiguration,
      [
        'bind 0.0.0.0',
        'protected-mode yes',
        'daemonize no',
        'logfile ""',
        'save ""',
        'appendonly no',
        'enable-debug-command no',
        'enable-module-command no',
        `user default on #${passwordHash} ${applicationRedisAcl}`,
        'port 0',
        'tls-port 6379',
        'tls-cert-file /run/tls/server.crt',
        'tls-key-file /run/tls/server.key',
        'tls-auth-clients no',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    created.redis = true;
    await docker([
      'run',
      '-d',
      '--name',
      redisContainer,
      '--network',
      externalNetwork,
      '--network-alias',
      'district-redis',
      '--user',
      '1000:1000',
      '--read-only',
      '--tmpfs',
      '/data:uid=1000,gid=1000,mode=0700',
      '-v',
      `${redisConfiguration}:/run/redis.conf:ro`,
      '-v',
      `${redisTls.certificate}:/run/tls/server.crt:ro`,
      '-v',
      `${redisTls.key}:/run/tls/server.key:ro`,
      redisImage,
      'redis-server',
      '/run/redis.conf',
    ]);
    await waitFor(
      async () => {
        try {
          return (
            (
              await docker([
                'inspect',
                redisContainer,
                '--format',
                '{{.State.Status}}',
              ])
            ).stdout.trim() === 'running'
          );
        } catch {
          return false;
        }
      },
      15,
      'District Redis startup',
    );

    stage = 'worker-compose';
    for (let index = 0; index < workerFiles.length; index += 1) {
      created.workers[index] = true;
      await compose(projects.workers[index], workerFiles[index], ['up', '-d']);
    }
    const workerIds = await Promise.all(
      workerFiles.map((file, index) =>
        containerId(projects.workers[index], file, 'workers'),
      ),
    );
    await waitFor(
      async () =>
        (await Promise.all(workerIds.map(containerHealth))).every(
          (status) => status === 'healthy',
        ),
      45,
      'Worker image health checks',
    );

    stage = 'controller-compose';
    created.controller = true;
    await compose(projects.controller, controllerFile, ['up', '-d']);
    const apiPort = await publishedPort(
      projects.controller,
      controllerFile,
      'api',
      3000,
    );
    const kestraPort = await publishedPort(
      projects.controller,
      controllerFile,
      'kestra',
      8080,
    );
    const edgePort = await publishedPort(
      projects.controller,
      controllerFile,
      'edge',
      8443,
    );
    const caBytes = await readFile(ca.certificate);
    const readiness = await waitFor(
      async () => {
        try {
          return readyStatus(
            await request({
              port: apiPort,
              servername: 'api',
              ca: caBytes,
              path: '/health',
            }),
          );
        } catch {
          return undefined;
        }
      },
      180,
      'Eight-component application readiness',
    );

    const controllerIds = Object.fromEntries(
      await Promise.all(
        ['frontend', 'api', 'kestra', 'edge'].map(async (service) => [
          service,
          await containerId(projects.controller, controllerFile, service),
        ]),
      ),
    );
    const runtimeHealth = await waitFor(
      async () => {
        const health = Object.fromEntries(
          await Promise.all([
            ...Object.entries(controllerIds).map(async ([name, id]) => [
              name,
              await containerHealth(id),
            ]),
            ...workerIds.map(async (id, index) => [
              `worker-${index + 1}`,
              await containerHealth(id),
            ]),
          ]),
        );
        return Object.values(health).every((status) => status === 'healthy')
          ? health
          : undefined;
      },
      45,
      'Final application image health checks',
    );

    stage = 'protected-access';
    const kestraAuth = JSON.parse(
      await readFile(join(privateRoot, 'kestra-auth'), 'utf8'),
    );
    const kestraBasic = `Basic ${Buffer.from(`${kestraAuth.username}:${kestraAuth.password}`).toString('base64')}`;
    const kestraReadinessPath = '/api/v1/main/flows/search?size=1';
    const kestraUnauthenticated = await request({
      port: kestraPort,
      servername: 'kestra',
      ca: caBytes,
      path: kestraReadinessPath,
    });
    if (kestraUnauthenticated.status !== 401) {
      throw new Error('Kestra accepted unauthenticated control-plane access.');
    }
    const bootstrap = (
      await readFile(join(privateRoot, 'bootstrap'), 'utf8')
    ).trim();
    const edgeUnauthenticated = await request({
      port: edgePort,
      servername: 'campus.example.org',
      ca: caBytes,
      path: source.phase === 2 ? '/api/startup' : '/api',
    });
    const edgeAuthorized = await request({
      port: edgePort,
      servername: 'campus.example.org',
      ca: caBytes,
      authorization: `Basic ${Buffer.from(`operator:${bootstrap}`).toString('base64')}`,
      path: source.phase === 2 ? '/api/startup' : '/api',
    });
    if (edgeUnauthenticated.status !== 401 || edgeAuthorized.status !== 200) {
      throw new Error('The edge bootstrap access contract failed.');
    }

    stage = 'shared-directory';
    const artifactPath = join(artifactRoot, 'hybrid-full-marker');
    const artifactBytes = randomBytes(128);
    const artifactChecksum = createHash('sha256')
      .update(artifactBytes)
      .digest('hex');
    if (processFaultMode) {
      await writeContainerFile(controllerIds.api, artifactPath, artifactBytes);
    } else {
      await writeFile(artifactPath, artifactBytes, { mode: 0o600 });
    }
    const workerArtifactChecksums = await Promise.all(
      workerIds.map((id) => checkArtifact(id, artifactPath)),
    );
    if (
      workerArtifactChecksums.some((checksum) => checksum !== artifactChecksum)
    ) {
      throw new Error('A worker read a different shared artifact marker.');
    }

    stage = 'synthetic-execution';
    const flow = await readFile(
      new URL('../../kestra/cc11-external-worker.yaml', import.meta.url),
      'utf8',
    );
    const flowUpload = await request({
      port: kestraPort,
      servername: 'kestra',
      ca: caBytes,
      authorization: kestraBasic,
      method: 'POST',
      path: '/api/v1/main/flows',
      contentType: 'application/x-yaml',
      body: flow,
    });
    if (flowUpload.status !== 200) {
      throw new Error(`Kestra flow upload returned ${flowUpload.status}.`);
    }
    const correlationId = `hybrid-full-${randomBytes(8).toString('hex')}`;
    const executionRequest = multipart({
      correlationId,
      marker: 'hybrid-full-runtime-marker',
      delayMilliseconds: '0',
    });
    const executionStart = await request({
      port: kestraPort,
      servername: 'kestra',
      ca: caBytes,
      authorization: kestraBasic,
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
          authorization: kestraBasic,
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
      'Full hybrid synthetic execution',
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
    const storageEntriesBefore = (
      await readdir(storageRoot, { recursive: true })
    ).length;

    stage = 'redis-outage';
    await docker(['stop', '--time', '3', redisContainer]);
    await waitFor(
      async () => {
        try {
          return (
            (
              await request({
                port: apiPort,
                servername: 'api',
                ca: caBytes,
                path: '/health',
              })
            ).status === 503
          );
        } catch {
          return false;
        }
      },
      20,
      'Redis outage observation',
    );
    const redisRecoveryStarted = Date.now();
    await docker(['start', redisContainer]);
    await waitFor(
      async () => {
        try {
          return readyStatus(
            await request({
              port: apiPort,
              servername: 'api',
              ca: caBytes,
              path: '/health',
            }),
          );
        } catch {
          return undefined;
        }
      },
      45,
      'Readiness after Redis restart',
    );
    const redisRecoverySeconds = Math.ceil(
      (Date.now() - redisRecoveryStarted) / 1000,
    );

    stage = 'postgresql-outage';
    await docker(['stop', '--time', '3', databaseContainer]);
    await waitFor(
      async () => {
        try {
          return (
            (
              await request({
                port: apiPort,
                servername: 'api',
                ca: caBytes,
                path: '/health',
                timeoutMilliseconds: 10000,
              })
            ).status === 503
          );
        } catch {
          return false;
        }
      },
      20,
      'PostgreSQL outage observation',
    );
    const postgresRecoveryStarted = Date.now();
    await docker(['start', databaseContainer]);
    await waitFor(
      async () => {
        try {
          return readyStatus(
            await request({
              port: apiPort,
              servername: 'api',
              ca: caBytes,
              path: '/health',
            }),
          );
        } catch {
          return undefined;
        }
      },
      90,
      'Readiness after PostgreSQL restart',
    );
    const postgresRecoverySeconds = Math.ceil(
      (Date.now() - postgresRecoveryStarted) / 1000,
    );

    stage = 'persistence-verification';
    const preservedExecution = await request({
      port: kestraPort,
      servername: 'kestra',
      ca: caBytes,
      authorization: kestraBasic,
      path: `/api/v1/main/executions/${executionId}`,
    });
    const finalWorkerChecksums = await Promise.all(
      workerIds.map((id) => checkArtifact(id, artifactPath)),
    );
    const finalReadiness = await request({
      port: apiPort,
      servername: 'api',
      ca: caBytes,
      path: '/health',
    });
    if (
      preservedExecution.status !== 200 ||
      JSON.parse(preservedExecution.body).state.current !== 'SUCCESS' ||
      finalWorkerChecksums.some((checksum) => checksum !== artifactChecksum) ||
      (await readdir(storageRoot, { recursive: true })).length <
        storageEntriesBefore ||
      !readyStatus(finalReadiness)
    ) {
      throw new Error('State did not survive the external dependency outages.');
    }

    const componentContainers = {
      frontend: controllerIds.frontend,
      api: controllerIds.api,
      kestra: controllerIds.kestra,
      edge: controllerIds.edge,
      'worker-1': workerIds[0],
      'worker-2': workerIds[1],
      postgresql: databaseContainer,
      redis: redisContainer,
    };
    let processFaults;
    if (processFaultMode) {
      stage = 'process-fault-qualification';
      const common = `import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';import {connectionOptions} from '/app/deployment/postgres/index.mjs';import {createArtifactStore} from '/app/deployment/storage/index.mjs';import {secretPath} from '/app/deployment/redis/runtime.mjs';const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));const store=await createArtifactStore({pool,root:c.artifacts.location});`;
      const seeded = JSON.parse(
        (
          await docker([
            'exec',
            controllerIds.api,
            'node',
            '--input-type=module',
            '-e',
            common +
              `const bytes=Buffer.from('CC18 hybrid durable École 学校');const artifact=await store.stage({schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes]);await store.publish(artifact);await store.close();await pool.end();process.stdout.write(JSON.stringify(artifact));`,
          ])
        ).stdout,
      );
      const fixtureProbe =
        common +
        `const id=${JSON.stringify(seeded.artifactId)};const h=crypto.createHash('sha256');for await(const bytes of await store.openRead(id))h.update(bytes);const ledger=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;const metadata=(await pool.query('SELECT to_jsonb(a) AS value FROM cc.artifacts a WHERE id=$1',[id])).rows;const readyRows=Number((await pool.query("SELECT count(*) FROM cc.artifacts WHERE publication_state='ready'")).rows[0].count);await store.close();await pool.end();process.stdout.write(JSON.stringify({artifactId:id,sha256:h.digest('hex'),ledgerSha256:crypto.createHash('sha256').update(JSON.stringify(ledger)).digest('hex'),metadataSha256:crypto.createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),readyRows}));`;
      const databaseFixture = async () =>
        JSON.parse(
          (
            await docker([
              'exec',
              controllerIds.api,
              'node',
              '--input-type=module',
              '-e',
              fixtureProbe,
            ])
          ).stdout,
        );
      const baselineDatabase = await databaseFixture();
      const baselineExecution = checksum(JSON.parse(preservedExecution.body));
      const baselineFiles = await internalFileChecksums(storageRoot);
      const verifyFixtures = async () => {
        if (checksum(await databaseFixture()) !== checksum(baselineDatabase))
          throw new Error(
            'A process fault changed application database or artifact state.',
          );
        for (const worker of workerIds)
          if ((await checkArtifact(worker, artifactPath)) !== artifactChecksum)
            throw new Error(
              'A process fault changed the shared artifact marker.',
            );
        const response = await request({
          port: kestraPort,
          servername: 'kestra',
          ca: caBytes,
          authorization: kestraBasic,
          path: `/api/v1/main/executions/${executionId}`,
        });
        if (
          response.status !== 200 ||
          checksum(JSON.parse(response.body)) !== baselineExecution
        )
          throw new Error(
            'A process fault changed the Kestra execution state or outputs.',
          );
        if (
          checksum(await internalFileChecksums(storageRoot)) !==
          checksum(baselineFiles)
        )
          throw new Error('A process fault changed Kestra internal files.');
      };
      const protectedStartup = async () => {
        try {
          const response = await request({
            port: edgePort,
            servername: 'campus.example.org',
            ca: caBytes,
            authorization: `Basic ${Buffer.from(`operator:${bootstrap}`).toString('base64')}`,
            path: '/api/startup',
          });
          let value;
          try {
            value = JSON.parse(response.body);
          } catch {
            value = {};
          }
          return {
            httpStatus: response.status,
            status: value.status ?? 'unavailable',
            checks:
              value.checks?.map(({ name, status }) => ({ name, status })) ?? [],
          };
        } catch {
          return { status: 'unavailable', checks: [] };
        }
      };
      const apiObservation = () =>
        request({
          port: apiPort,
          servername: 'api',
          ca: caBytes,
          path: '/health',
        });
      const observeNamedFailure = (names, description) =>
        waitFor(
          async () => {
            let response;
            try {
              response = await apiObservation();
            } catch {
              return undefined;
            }
            if (response.status !== 503) return undefined;
            const value = JSON.parse(response.body);
            const checks = names.map((name) =>
              value.checks?.find((check) => check.name === name),
            );
            return checks.every((check) => check?.status === 'not-ready')
              ? checks.map(({ name, status }) => ({ name, status }))
              : undefined;
          },
          30,
          description,
        );
      const recoverReadiness = (description) =>
        waitFor(
          async () => {
            if (!readyStatus(await apiObservation())) return undefined;
            const value = await protectedStartup();
            return (
              value.status === 'ready' &&
              value.checks.length === 8 &&
              value.checks.every(({ status }) => status === 'ready')
            );
          },
          120,
          description,
        );
      const faultCells = [];

      stage = 'artifact-access-loss';
      await verifyFixtures();
      const artifactAccessStarted = Date.now();
      let artifactAccessObservation;
      try {
        await docker(['exec', controllerIds.api, 'chmod', '000', artifactRoot]);
        artifactAccessObservation = await observeNamedFailure(
          ['artifacts'],
          'Hybrid artifact access-loss observation',
        );
      } finally {
        await docker(['exec', controllerIds.api, 'chmod', '700', artifactRoot]);
      }
      const artifactAccessRecoveryStarted = Date.now();
      await recoverReadiness('Hybrid artifact access recovery');
      await verifyFixtures();
      faultCells.push({
        cell: 'artifact-access-loss',
        status: 'passed',
        observed: artifactAccessObservation,
        elapsedMilliseconds: Date.now() - artifactAccessStarted,
        recoveryMilliseconds: Date.now() - artifactAccessRecoveryStarted,
        originalFixturesPreserved: true,
      });

      stage = 'artifact-capacity';
      const capacityFiller = `${artifactRoot}/.cc18-capacity-filler`;
      const capacity = JSON.parse(
        (
          await docker([
            'exec',
            workerIds[0],
            'node',
            '-e',
            `const fs=require('node:fs'),root=${JSON.stringify(artifactRoot)},path=${JSON.stringify(capacityFiller)},before=fs.statfsSync(root),totalBytes=Number(before.blocks)*Number(before.bsize);if(Number(before.type)!==0x01021994||totalBytes>16777216)throw Error('Artifact filesystem is not the bounded tmpfs.');const file=fs.openSync(path,'wx',0o600),bytes=Buffer.alloc(65536,42);let writtenBytes=0,enospc=false;try{for(let index=0;index<300;index+=1)writtenBytes+=fs.writeSync(file,bytes)}catch(error){if(error.code!=='ENOSPC')throw error;enospc=true}finally{fs.closeSync(file)}if(!enospc)throw Error('Bounded artifact filesystem did not reach ENOSPC.');const after=fs.statfsSync(root);process.stdout.write(JSON.stringify({filesystemType:Number(before.type),totalBytes,writtenBytes,availableBytesBefore:Number(before.bavail)*Number(before.bsize),availableBytesAfter:Number(after.bavail)*Number(after.bsize)}))`,
          ])
        ).stdout,
      );
      if (
        capacity.filesystemType !== 0x01021994 ||
        capacity.totalBytes > 16 * 1024 * 1024 ||
        capacity.availableBytesAfter >= 65_536
      ) {
        throw new Error(
          'The live hybrid artifact filesystem exceeded its cap.',
        );
      }
      const capacityStarted = Date.now();
      const capacityObservation = await observeNamedFailure(
        ['artifacts'],
        'Hybrid artifact ENOSPC observation',
      );
      const failedArtifactId = randomUUID();
      const failedAttemptId = randomUUID();
      const failedPublication = JSON.parse(
        (
          await docker([
            'exec',
            controllerIds.api,
            'node',
            '--input-type=module',
            '-e',
            common +
              `const [artifactId,attemptId]=process.argv.slice(1),bytes=Buffer.alloc(1048576,67);let rejected=false;try{await store.stage({artifactId,attemptId,schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes])}catch{rejected=true}const row=(await pool.query('SELECT publication_state,active FROM cc.artifacts WHERE id=$1',[artifactId])).rows[0],readyRows=Number((await pool.query("SELECT count(*) FROM cc.artifacts WHERE publication_state='ready'")).rows[0].count);await store.close();await pool.end();process.stdout.write(JSON.stringify({rejected,row,readyRows}))`,
            failedArtifactId,
            failedAttemptId,
          ])
        ).stdout,
      );
      if (
        !failedPublication.rejected ||
        failedPublication.row?.publication_state === 'ready' ||
        failedPublication.row?.active !== false ||
        failedPublication.readyRows !== baselineDatabase.readyRows
      ) {
        throw new Error('Hybrid ENOSPC created an authoritative artifact.');
      }
      await docker([
        'exec',
        workerIds[0],
        'node',
        '-e',
        `require('node:fs').unlinkSync(${JSON.stringify(capacityFiller)})`,
      ]);
      const capacityRecoveryStarted = Date.now();
      const failedCleanup = JSON.parse(
        (
          await docker([
            'exec',
            controllerIds.api,
            'node',
            '--input-type=module',
            '-e',
            common +
              `const [artifactId,attemptId]=process.argv.slice(1),removed=await store.remove({artifactId,attemptId}),rowCount=Number((await pool.query('SELECT count(*) FROM cc.artifacts WHERE id=$1',[artifactId])).rows[0].count);await store.close();await pool.end();process.stdout.write(JSON.stringify({removed,rowCount}))`,
            failedArtifactId,
            failedAttemptId,
          ])
        ).stdout,
      );
      if (!failedCleanup.removed || failedCleanup.rowCount !== 0) {
        throw new Error(
          'Hybrid ENOSPC cleanup did not remove the failed attempt.',
        );
      }
      await recoverReadiness('Hybrid artifact capacity recovery');
      await verifyFixtures();
      faultCells.push({
        cell: 'artifact-capacity',
        status: 'passed',
        filesystem: capacity,
        observed: capacityObservation,
        publicationRejected: true,
        failedAttemptRemoved: true,
        elapsedMilliseconds: Date.now() - capacityStarted,
        recoveryMilliseconds: Date.now() - capacityRecoveryStarted,
        originalFixturesPreserved: true,
      });

      stage = 'database-certificate-fault';
      const originalDatabaseCertificate = await readFile(
        databaseTls.certificate,
      );
      const originalDatabaseKey = await readFile(databaseTls.key);
      const wrongDatabaseTls = await signedCertificate(
        privateRoot,
        'district-postgres-wrong-host',
        'wrong-postgres.invalid',
        ['wrong-postgres.invalid'],
        ca,
      );
      const wrongDatabaseCertificate = await readFile(
        wrongDatabaseTls.certificate,
      );
      const wrongDatabaseKey = await readFile(wrongDatabaseTls.key);
      const certificateStarted = Date.now();
      let certificateObservation;
      let certificateServiceProof;
      try {
        await writeFile(databaseTls.certificate, wrongDatabaseCertificate, {
          mode: 0o600,
        });
        await writeFile(databaseTls.key, wrongDatabaseKey, { mode: 0o600 });
        await docker(['restart', databaseContainer]);
        certificateServiceProof = await waitFor(
          async () => {
            try {
              return await verifyPostgresCertificateFault(controllerIds.api);
            } catch {
              return undefined;
            }
          },
          30,
          'Hybrid PostgreSQL injected certificate service',
        );
        certificateObservation = await observeNamedFailure(
          ['application-database', 'kestra-database'],
          'Hybrid database certificate rejection',
        );
      } finally {
        await writeFile(databaseTls.certificate, originalDatabaseCertificate, {
          mode: 0o600,
        });
        await writeFile(databaseTls.key, originalDatabaseKey, { mode: 0o600 });
        await docker(['restart', databaseContainer]);
      }
      const certificateRecoveryStarted = Date.now();
      await recoverReadiness('Hybrid database certificate recovery');
      await verifyFixtures();
      faultCells.push({
        cell: 'database-certificate-rejection',
        status: 'passed',
        fault: 'valid private-CA certificate with the wrong server name',
        serviceProof: certificateServiceProof,
        observed: certificateObservation,
        elapsedMilliseconds: Date.now() - certificateStarted,
        recoveryMilliseconds: Date.now() - certificateRecoveryStarted,
        originalFixturesPreserved: true,
      });

      const records = [];
      for (const [component, containers, failedNames] of [
        ['api', [controllerIds.api], []],
        ['workers', workerIds, ['workers']],
        ['kestra', [controllerIds.kestra], ['kestra']],
        ['redis', [redisContainer], ['redis']],
        [
          'postgresql',
          [databaseContainer],
          ['application-database', 'kestra-database'],
        ],
      ]) {
        await waitFor(
          async () => readyStatus(await apiObservation()),
          120,
          'Process fault baseline readiness',
        );
        const baseline = await protectedStartup();
        if (
          baseline.status !== 'ready' ||
          baseline.checks.length !== 8 ||
          baseline.checks.some(({ status }) => status !== 'ready')
        )
          throw new Error(
            'The protected process fault baseline lacks eight ready checks.',
          );
        await verifyFixtures();
        const started = Date.now();
        let observed;
        try {
          await docker(['stop', '--time', '5', ...containers]);
          observed = await waitFor(
            async () => {
              const edge = await protectedStartup();
              if (edge.status === 'ready') return undefined;
              if (component === 'api') return { edge, namedChecks: [] };
              const response = await apiObservation();
              if (response.status !== 503) return undefined;
              const health = JSON.parse(response.body);
              const namedChecks = failedNames
                .map((name) =>
                  health.checks?.find((check) => check.name === name),
                )
                .filter(Boolean)
                .map(({ name, status }) => ({ name, status }));
              if (
                namedChecks.length !== failedNames.length ||
                namedChecks.some(({ status }) => status !== 'not-ready')
              )
                return undefined;
              return { edge, namedChecks };
            },
            30,
            `${component} fault observation`,
          );
        } finally {
          await docker(['start', ...containers]);
        }
        const recoveryStarted = Date.now();
        await waitFor(
          async () => {
            if (!readyStatus(await apiObservation())) return undefined;
            const value = await protectedStartup();
            return (
              value.status === 'ready' &&
              value.checks.length === 8 &&
              value.checks.every(({ status }) => status === 'ready')
            );
          },
          120,
          `${component} bounded recovery`,
        );
        await verifyFixtures();
        records.push({
          component,
          status: 'passed',
          stoppedInstances: containers.length,
          elapsedMilliseconds: Date.now() - started,
          recoveryMilliseconds: Date.now() - recoveryStarted,
          recoveryBoundSeconds: 120,
          observed,
          fixturesPreserved: true,
        });
      }
      const stats = (
        await docker([
          'stats',
          '--no-stream',
          '--format',
          '{{json .}}',
          ...Object.values(componentContainers),
        ])
      ).stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const value = JSON.parse(line);
          return {
            name: value.Name,
            cpu: value.CPUPerc,
            memory: value.MemUsage,
            memoryPercent: value.MemPerc,
            pids: value.PIDs,
          };
        });
      processFaults = {
        status: 'passed',
        scope: 'same-host-complete-hybrid-faults',
        qualifiesProfile: false,
        acceptedRelease: false,
        topology: {
          artifactVolumeType: 'tmpfs',
          artifactVolumeCapacityBytes: 16 * 1024 * 1024,
          artifactConsumers: [
            'controller-api',
            'controller-storage-preflight',
            'worker-1',
            'worker-1-storage-preflight',
            'worker-2',
            'worker-2-storage-preflight',
          ],
        },
        faultCells,
        records,
        fixture: {
          database: baselineDatabase,
          executionId,
          executionSha256: baselineExecution,
          kestraFiles: baselineFiles,
        },
        resources: stats,
      };
    }
    const upgrade = application?.upgrade
      ? await application.upgrade({
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
          readExecution: async () => {
            const response = await request({
              port: kestraPort,
              servername: 'kestra',
              ca: caBytes,
              authorization: kestraBasic,
              path: `/api/v1/main/executions/${executionId}`,
            });
            if (response.status !== 200)
              throw new Error('The original Kestra execution is unavailable.');
            return JSON.parse(response.body);
          },
        })
      : undefined;
    const applicationResult = application
      ? await application.check({
          root,
          source,
          controllerFile,
          workerFiles,
          projects,
          controllerIds,
          workerIds,
          externalNetwork,
          databaseContainer,
          redisContainer,
          executionId,
        })
      : undefined;
    completedResult = {
      ...(upgrade ? { upgrade } : {}),
      ...(applicationResult ? { application: applicationResult } : {}),
      checkedAt: new Date().toISOString(),
      durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      status: 'PASS',
      sourceState: 'uncommitted workspace',
      ...(processFaultMode
        ? {
            baseGitRevision: (
              await run('git', ['rev-parse', 'HEAD'])
            ).stdout.trim(),
            processFaults,
          }
        : {}),
      images: {
        frontend: frontendImage,
        api: apiImage,
        worker: workerImage,
        kestra: kestraImage,
        postgres: postgresImage,
        redis: redisImage,
      },
      render: {
        controllerCompose: true,
        workerComposeFiles: 2,
        composeConfigAccepted: true,
        localReplacementPostgres: false,
        localReplacementRedis: false,
        productionPublishedServices: ['edge'],
        fixturePublishedServices: ['edge', 'api', 'kestra'],
      },
      preparation: {
        runtimeFiles: prepared.runtimeFiles,
        credentialStatuses: prepared.secrets.map(({ status }) => status),
        jdbcMode: 'verify-full',
      },
      startup: {
        componentContainers: Object.keys(componentContainers),
        runningContainerCount: Object.keys(componentContainers).length,
        imageHealth: runtimeHealth,
        readiness,
      },
      trust: {
        privateCa: true,
        edgeUnauthenticatedStatus: edgeUnauthenticated.status,
        edgeAuthorizedStatus: edgeAuthorized.status,
        kestraUnauthenticatedStatus: kestraUnauthenticated.status,
      },
      execution: {
        id: executionId,
        correlationId,
        state: execution.state.current,
        storageUriSha256: createHash('sha256').update(storageUri).digest('hex'),
      },
      persistence: {
        sharedArtifactChecksum: artifactChecksum,
        workerChecksumsMatch: true,
        executionPreserved: true,
        internalStoragePreserved: true,
        databaseVolume: databaseVolume,
      },
      outages: {
        redis: { observed: true, recoverySeconds: redisRecoverySeconds },
        postgres: {
          observed: true,
          recoverySeconds: postgresRecoverySeconds,
        },
        finalReadiness: 'ready',
      },
      cleanupPolicy: {
        uniquePrefix: runId,
        retainedForRestore: retainFixture,
        composeVolumesRemoved: false,
        ownedResourcesRemoved: false,
        oldCampusCommanderVolumesTouched: false,
      },
      ...(retainFixture
        ? {
            reusableFixture: {
              root,
              controllerFile,
              workerFiles,
              projects,
              externalNetwork,
              databaseContainer,
              redisContainer,
              databaseVolume,
            },
          }
        : {}),
      limits: [
        'All eight component containers ran on one Docker host.',
        'The two worker Compose projects simulate separate worker hosts.',
        ...(processFaultMode
          ? [
              'The shared artifact filesystem uses one bounded tmpfs volume on one Docker host.',
            ]
          : ['The shared directories use one host filesystem.']),
        'The check does not qualify district DNS, firewall, or storage infrastructure.',
        'The check uses synthetic certificates and a harmless worker task.',
      ],
    };
    return completedResult;
  } catch (error) {
    failure = new Error(
      `Full hybrid integration failed during ${stage}: ${error.message}. Diagnostic root retained at ${root}.`,
      { cause: error },
    );
    if (!retainFixture) {
      try {
        await cleanup({ strict: true, retainRoot: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [failure, cleanupError],
          `${failure.message} Owned resource cleanup also failed.`,
        );
      }
    }
    throw failure;
  } finally {
    if (!retainFixture && !failure) {
      const removed = await cleanup({ strict: true });
      if (completedResult) {
        completedResult.cleanupPolicy.composeVolumesRemoved = removed;
        completedResult.cleanupPolicy.ownedResourcesRemoved = removed;
      }
    }
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  qualifyFullHybrid()
    .then(async (result) => {
      const output = `${JSON.stringify(result, null, 2)}\n`;
      const resultPath = process.env.CC_HYBRID_RESULT;
      if (resultPath) {
        if (!isAbsolute(resultPath)) {
          throw new Error('Hybrid evidence requires an absolute new path.');
        }
        await writeFile(resultPath, output, { flag: 'wx', mode: 0o600 });
      }
      process.stdout.write(output);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
