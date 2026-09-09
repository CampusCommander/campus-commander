#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { prepareAllDocker } from '../profiles/all-docker/prepare.mjs';
import { renderFiles } from '../profiles/all-docker/render.mjs';
import { httpsStartup } from './faults.mjs';
import { qualificationImages } from './images.mjs';

const execute = promisify(execFile);
const capacityBytes = 16 * 1024 * 1024;
const tmpfsMagic = 0x01021994;
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
const requiredComponents = [
  'api',
  'application-database',
  'artifacts',
  'frontend',
  'kestra',
  'kestra-database',
  'redis',
  'workers',
];
const componentServices = [
  'frontend',
  'api',
  'workers',
  'application-postgres',
  'kestra-postgres',
  'redis',
  'kestra',
  'edge',
];

async function run(file, args, options = {}) {
  return execute(file, args, {
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function projectName(value) {
  if (!/^cc-fault-capacity-profile-[a-f0-9]{12}$/.test(value)) {
    throw new Error('Capacity qualification requires a unique owned project.');
  }
  return value;
}

function artifactTarget(service) {
  const mount = service.volumes?.find((volume) =>
    typeof volume === 'string'
      ? volume.startsWith('artifacts:')
      : volume.type === 'volume' && volume.source === 'artifacts',
  );
  return typeof mount === 'string' ? mount.split(':')[1] : mount?.target;
}

/** Apply a bounded shared filesystem without changing the product mount paths. */
export function boundedCapacityCompose(input, project, edgePort) {
  projectName(project);
  if (!Number.isInteger(edgePort) || edgePort < 1024 || edgePort > 65535) {
    throw new Error('Capacity qualification requires a safe loopback port.');
  }
  const compose = structuredClone(input);
  if (
    !compose.volumes?.artifacts ||
    compose.volumes.artifacts.external ||
    compose.volumes.artifacts.name
  ) {
    throw new Error('Capacity qualification requires its rendered volume.');
  }
  const expectedTarget = '/var/lib/campus-commander/artifacts';
  for (const name of ['api', 'workers']) {
    if (artifactTarget(compose.services?.[name]) !== expectedTarget) {
      throw new Error(
        'API and workers must share the rendered artifact mount.',
      );
    }
  }
  if (
    artifactTarget(compose.services?.['volume-permissions']) !== '/artifacts'
  ) {
    throw new Error('The permissions helper must mount the artifact volume.');
  }
  compose.name = project;
  compose.services.edge.ports = [`127.0.0.1:${edgePort}:8443`];
  for (const service of Object.values(compose.services)) {
    service.pull_policy = 'never';
    service.logging = {
      driver: 'json-file',
      options: { 'max-size': '1m', 'max-file': '1' },
    };
  }
  for (const [name, volume] of Object.entries(compose.volumes)) {
    if (volume.external || volume.name) {
      throw new Error('Capacity qualification rejects shared volumes.');
    }
    volume.labels = {
      ...(volume.labels ?? {}),
      'campus-commander.test': 'bounded-profile-capacity',
      'campus-commander.owner': project,
      'campus-commander.volume': name,
    };
  }
  compose.volumes.artifacts = {
    ...compose.volumes.artifacts,
    driver: 'local',
    driver_opts: {
      type: 'tmpfs',
      device: 'tmpfs',
      o: 'size=16m,uid=1000,gid=1000,mode=0700',
    },
  };
  return compose;
}

/** Reject cleanup unless Docker reports the unique Compose ownership labels. */
export function verifyOwnedVolume(volume, project, logicalName) {
  projectName(project);
  const expectedName = `${project}_${logicalName}`;
  if (
    volume.Name !== expectedName ||
    volume.Labels?.['com.docker.compose.project'] !== project ||
    volume.Labels?.['com.docker.compose.volume'] !== logicalName ||
    volume.Labels?.['campus-commander.test'] !== 'bounded-profile-capacity' ||
    volume.Labels?.['campus-commander.owner'] !== project ||
    volume.Labels?.['campus-commander.volume'] !== logicalName
  ) {
    throw new Error('Refusing to remove a volume without fixture ownership.');
  }
  return expectedName;
}

/** Verify the fault writer observed the capped Linux tmpfs before accepting ENOSPC. */
export function verifyBoundedFilesystem(observation) {
  if (
    observation.filesystemType !== tmpfsMagic ||
    !Number.isSafeInteger(observation.totalBytes) ||
    observation.totalBytes < 1 ||
    observation.totalBytes > capacityBytes ||
    observation.availableBytesAfter >= 65_536
  ) {
    throw new Error('Artifact filesystem does not match the bounded tmpfs.');
  }
  return observation;
}

function readyStatus(status) {
  if (status.status !== 'ready' || !Array.isArray(status.checks)) return false;
  const checks = new Map(
    status.checks.map((check) => [check.name, check.status]),
  );
  return (
    checks.size === requiredComponents.length &&
    requiredComponents.every((name) => checks.get(name) === 'ready')
  );
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

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function parseLines(value) {
  const text = value.trim();
  if (!text) return [];
  return text.startsWith('[')
    ? JSON.parse(text)
    : text.split('\n').filter(Boolean).map(JSON.parse);
}

function resourceListArguments(kind, project) {
  return [
    ...(kind === 'container' ? ['ps', '-a'] : [kind, 'ls']),
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--format',
    kind === 'volume' ? '{{.Name}}' : '{{.ID}}',
  ];
}

async function certificate(root) {
  const privateRoot = join(root, 'private');
  await mkdir(privateRoot, { mode: 0o700 });
  const key = join(privateRoot, 'edge-private-key');
  const cert = join(privateRoot, 'edge-certificate');
  await run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=campus.example.org',
      '-addext',
      'subjectAltName=DNS:campus.example.org',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 30_000 },
  );
  await chmod(key, 0o600);
  await chmod(cert, 0o600);
  return cert;
}

const seedCode = `
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const config=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const resolveSecret=(reference)=>fs.readFile(secretPath(reference));
const pool=new pg.Pool({...await connectionOptions(config.services.applicationDatabase,resolveSecret),max:1});
const store=await createArtifactStore({pool,root:config.artifacts.location});
try {
  const bytes=Buffer.from('CC-18 complete profile capacity baseline');
  const artifact=await store.stage({schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes]);
  await store.publish(artifact);
  await fs.writeFile(config.artifacts.location+'/.cc18-capacity-fixture.json',JSON.stringify(artifact),{mode:0o600,flag:'wx'});
  process.stdout.write(JSON.stringify(artifact));
} finally {await store.close();await pool.end()}
`;

const probeCode = `
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const config=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const resolveSecret=(reference)=>fs.readFile(secretPath(reference));
const pool=new pg.Pool({...await connectionOptions(config.services.applicationDatabase,resolveSecret),max:1});
const store=await createArtifactStore({pool,root:config.artifacts.location});
try {
  const artifact=JSON.parse(await fs.readFile(config.artifacts.location+'/.cc18-capacity-fixture.json'));
  const hash=crypto.createHash('sha256');let size=0;
  for await(const bytes of await store.openRead(artifact.artifactId)){hash.update(bytes);size+=bytes.length}
  const ready=Number((await pool.query("SELECT count(*) FROM cc.artifacts WHERE publication_state='ready'")).rows[0].count);
  process.stdout.write(JSON.stringify({artifactId:artifact.artifactId,sha256:hash.digest('hex'),sizeBytes:size,readyRows:ready}));
} finally {await store.close();await pool.end()}
`;

const fillCode = `
import fs from 'node:fs';
const config=JSON.parse(fs.readFileSync(process.env.CC_CONFIG_FILE));
const path=config.artifacts.location+'/.cc18-capacity-filler';
const before=fs.statfsSync(config.artifacts.location);
const totalBytes=Number(before.blocks)*Number(before.bsize);
if(totalBytes>16777216)throw new Error('Artifact filesystem exceeds the fixture cap.');
const file=fs.openSync(path,'wx',0o600),bytes=Buffer.alloc(65536,42);let writtenBytes=0,enospc=false;
try {for(let index=0;index<300;index++){writtenBytes+=fs.writeSync(file,bytes)}}catch(error){if(error.code!=='ENOSPC')throw error;enospc=true}finally{fs.closeSync(file)}
if(!enospc)throw new Error('Bounded artifact filesystem did not reach ENOSPC.');
const after=fs.statfsSync(config.artifacts.location);
process.stdout.write(JSON.stringify({filesystemType:Number(before.type),totalBytes,writtenBytes,availableBytesBefore:Number(before.bavail)*Number(before.bsize),availableBytesAfter:Number(after.bavail)*Number(after.bsize)}));
`;

const failedPublicationCode = `
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const [artifactId,attemptId]=process.argv.slice(1);
const config=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const resolveSecret=(reference)=>fs.readFile(secretPath(reference));
const pool=new pg.Pool({...await connectionOptions(config.services.applicationDatabase,resolveSecret),max:1});
const store=await createArtifactStore({pool,root:config.artifacts.location});
try {
  const bytes=Buffer.alloc(1048576,67);let rejected=false;
  try {await store.stage({artifactId,attemptId,schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes])}catch{rejected=true}
  const row=(await pool.query('SELECT publication_state,active FROM cc.artifacts WHERE id=$1',[artifactId])).rows[0];
  const readyRows=Number((await pool.query("SELECT count(*) FROM cc.artifacts WHERE publication_state='ready'")).rows[0].count);
  process.stdout.write(JSON.stringify({rejected,row,readyRows}));
} finally {await store.close();await pool.end()}
`;

const recoverCode = `
import fs from 'node:fs/promises';
import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const [artifactId,attemptId]=process.argv.slice(1);
const config=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
await fs.unlink(config.artifacts.location+'/.cc18-capacity-filler');
const resolveSecret=(reference)=>fs.readFile(secretPath(reference));
const pool=new pg.Pool({...await connectionOptions(config.services.applicationDatabase,resolveSecret),max:1});
const store=await createArtifactStore({pool,root:config.artifacts.location});
try {
  const removed=await store.remove({artifactId,attemptId});
  const rowCount=Number((await pool.query('SELECT count(*) FROM cc.artifacts WHERE id=$1',[artifactId])).rows[0].count);
  process.stdout.write(JSON.stringify({removed,rowCount}));
} finally {await store.close();await pool.end()}
`;

export async function qualifyProfileCapacity(reportPath) {
  if (!reportPath || !isAbsolute(reportPath)) {
    throw new Error('Provide an absolute new capacity evidence path.');
  }
  const startedAt = Date.now();
  const project = projectName(
    `cc-fault-capacity-profile-${randomBytes(6).toString('hex')}`,
  );
  const root = await mkdtemp(join(tmpdir(), `${project}-`));
  const composeFile = join(root, 'docker-compose.json');
  const configPath = join(root, 'input.json');
  const releasePath = join(root, 'release.json');
  const docker = (args, options) => run('docker', args, options);
  const compose = (args, options) =>
    docker(['compose', '-p', project, '-f', composeFile, ...args], options);
  const ownedVolumes = new Set();
  let logicalVolumes = [];
  let composeCreated = false;
  let stage = 'preflight';
  try {
    for (const image of [frontendImage, apiImage, workerImage]) {
      await docker(['image', 'inspect', image]);
    }
    for (const kind of ['container', 'volume', 'network']) {
      const result = await docker(resourceListArguments(kind, project));
      if (result.stdout.trim()) {
        throw new Error('The generated qualification project already exists.');
      }
    }

    stage = 'prepare-and-render';
    const edgePort = await availablePort();
    const config = JSON.parse(
      await readFile(
        new URL('../examples/all-docker.json', import.meta.url),
        'utf8',
      ),
    );
    config.images = {
      frontend: frontendImage,
      api: apiImage,
      workers: workerImage,
    };
    config.services.edge.endpoint.url = `https://campus.example.org:${edgePort}`;
    const release = {
      schemaVersion: 1,
      architectures: ['linux/amd64'],
      images: config.images,
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`, {
      mode: 0o600,
    });
    const caFile = await certificate(root);
    await prepareAllDocker(configPath, root);
    const rendered = await renderFiles(configPath, releasePath, composeFile);
    const bounded = boundedCapacityCompose(rendered, project, edgePort);
    await writeFile(composeFile, `${JSON.stringify(bounded, null, 2)}\n`, {
      mode: 0o600,
    });
    const topology = JSON.parse(
      (await compose(['config', '--format', 'json'])).stdout,
    );
    logicalVolumes = Object.keys(topology.volumes);
    if (
      topology.name !== project ||
      Object.values(topology.services).some(
        (service) =>
          service.container_name ||
          service.volumes?.some(
            (volume) => volume.type === 'bind' && !volume.read_only,
          ),
      ) ||
      Object.values(topology.volumes).some(
        (volume) =>
          volume.external || volume.name?.startsWith(project) === false,
      )
    ) {
      throw new Error('Rendered capacity topology failed isolation checks.');
    }
    const artifactVolume = topology.volumes.artifacts;
    if (
      artifactVolume.driver !== 'local' ||
      artifactVolume.driver_opts?.type !== 'tmpfs' ||
      artifactVolume.driver_opts?.device !== 'tmpfs' ||
      artifactVolume.driver_opts?.o !== 'size=16m,uid=1000,gid=1000,mode=0700'
    ) {
      throw new Error('Compose did not preserve the bounded artifact volume.');
    }

    stage = 'complete-profile-startup';
    composeCreated = true;
    await compose(['up', '-d']);
    for (const name of Object.keys(topology.volumes)) {
      const volumeName = `${project}_${name}`;
      const details = JSON.parse(
        (await docker(['volume', 'inspect', volumeName])).stdout,
      )[0];
      ownedVolumes.add(verifyOwnedVolume(details, project, name));
    }
    const edge = {
      url: config.services.edge.endpoint.url,
      caFile,
      bootstrapFile: join(root, 'private', 'bootstrap'),
      connectAddress: '127.0.0.1',
    };
    const baselineReadiness = await waitFor(
      async () => {
        const status = await httpsStartup(edge);
        return readyStatus(status) ? status : undefined;
      },
      180,
      'Complete profile readiness',
    );
    const componentState = await waitFor(
      async () => {
        const state = parseLines(
          (await compose(['ps', '--format', 'json'])).stdout,
        );
        const selected = state.filter(({ Service }) =>
          componentServices.includes(Service),
        );
        return selected.length === 8 &&
          selected.every(
            ({ State, Health }) =>
              State === 'running' && (!Health || Health === 'healthy'),
          )
          ? selected.map(({ Service, State, Health }) => ({
              service: Service,
              state: State,
              health: Health,
            }))
          : undefined;
      },
      45,
      'Eight component container health',
    );

    stage = 'baseline-artifact';
    const executeCode = async (service, code, args = []) =>
      (
        await compose([
          'exec',
          '-T',
          service,
          'node',
          '--input-type=module',
          '-e',
          code,
          ...args,
        ])
      ).stdout.trim();
    const artifact = JSON.parse(await executeCode('api', seedCode));
    const baselineArtifact = JSON.parse(await executeCode('api', probeCode));
    if (
      artifact.sha256 !== baselineArtifact.sha256 ||
      baselineArtifact.readyRows !== 1
    ) {
      throw new Error('Baseline artifact fixture differs from its descriptor.');
    }
    const baselineResources = parseLines(
      (await compose(['stats', '--no-stream', '--format', 'json'])).stdout,
    );

    stage = 'near-full-fault';
    const capacity = verifyBoundedFilesystem(
      JSON.parse(await executeCode('workers', fillCode)),
    );
    const faultStartedAt = Date.now();
    const faultReadiness = await waitFor(
      async () => {
        const status = await httpsStartup(edge);
        return status.status !== 'ready' &&
          status.checks?.some(
            (check) =>
              check.name === 'artifacts' && check.status === 'not-ready',
          )
          ? status
          : undefined;
      },
      30,
      'Artifact ENOSPC readiness failure',
    );
    const artifactId = randomUUID();
    const attemptId = randomUUID();
    const failedPublication = JSON.parse(
      await executeCode('api', failedPublicationCode, [artifactId, attemptId]),
    );
    if (
      !failedPublication.rejected ||
      failedPublication.row?.publication_state === 'ready' ||
      failedPublication.row?.active !== false ||
      failedPublication.readyRows !== baselineArtifact.readyRows
    ) {
      throw new Error('ENOSPC created an authoritative artifact publication.');
    }
    const faultResources = parseLines(
      (await compose(['stats', '--no-stream', '--format', 'json'])).stdout,
    );

    stage = 'capacity-recovery';
    const recovery = JSON.parse(
      await executeCode('api', recoverCode, [artifactId, attemptId]),
    );
    if (!recovery.removed || recovery.rowCount !== 0) {
      throw new Error('Failed artifact cleanup did not complete.');
    }
    const recoveredReadiness = await waitFor(
      async () => {
        const status = await httpsStartup(edge);
        return readyStatus(status) ? status : undefined;
      },
      60,
      'Complete profile recovery',
    );
    const recoveredArtifact = JSON.parse(await executeCode('api', probeCode));
    if (
      JSON.stringify(recoveredArtifact) !== JSON.stringify(baselineArtifact)
    ) {
      throw new Error(
        'The baseline artifact changed during capacity recovery.',
      );
    }

    const sourceState = (
      await run('git', ['status', '--porcelain'], { timeout: 10_000 })
    ).stdout.trim()
      ? 'uncommitted workspace'
      : 'clean';
    const result = {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      status: 'PASS',
      scope: 'complete-all-docker-artifact-capacity',
      qualifiesProfile: 'all-docker-capacity-only',
      sourceState,
      images: {
        frontend: frontendImage,
        api: apiImage,
        worker: workerImage,
        kestra: topology.services.kestra.image,
        applicationPostgres: topology.services['application-postgres'].image,
        kestraPostgres: topology.services['kestra-postgres'].image,
        redis: topology.services.redis.image,
      },
      topology: {
        projectPattern: 'cc-fault-capacity-profile-<12 hex>',
        componentCount: componentState.length,
        components: componentState,
        artifactMountConsumers: ['volume-permissions', 'api', 'workers'],
        artifactVolumeDriver: 'local',
        artifactVolumeType: 'tmpfs',
        artifactVolumeCapacityBytes: capacityBytes,
        writableHostBinds: false,
      },
      baseline: {
        readiness: baselineReadiness,
        artifact: baselineArtifact,
        resources: baselineResources,
      },
      fault: {
        kind: 'ENOSPC',
        capacity,
        readiness: faultReadiness,
        publicationRejected: true,
        failedPublicationState: failedPublication.row?.publication_state,
        readyRowsUnchanged: true,
        resources: faultResources,
      },
      recovery: {
        elapsedMilliseconds: Date.now() - faultStartedAt,
        readiness: recoveredReadiness,
        failedAttemptRemoved: true,
        originalArtifactPreserved: true,
        artifact: recoveredArtifact,
      },
      cleanupPolicy: {
        verifiedProjectVolumeLabels: true,
        removedOnlyOwnedResources: false,
        oldCampusCommanderVolumesTouched: false,
        registryStopped: false,
      },
      limits: [
        'The artifact filesystem is a synthetic tmpfs volume.',
        'The result makes no storage persistence claim.',
        'The check ran on one Docker host.',
        'The check does not reproduce ext4, quota, NFS, or object-storage behavior.',
        'The check qualifies only all-Docker artifact capacity behavior.',
      ],
    };

    stage = 'owned-resource-cleanup';
    await compose(['down', '--remove-orphans', '--timeout', '3']);
    composeCreated = false;
    for (const volume of [...ownedVolumes]) {
      await docker(['volume', 'rm', volume]);
      ownedVolumes.delete(volume);
    }
    for (const kind of ['container', 'volume', 'network']) {
      const remaining = await docker(resourceListArguments(kind, project));
      if (remaining.stdout.trim()) {
        throw new Error('Owned qualification resources remain after cleanup.');
      }
    }
    result.cleanupPolicy.removedOnlyOwnedResources = true;
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return result;
  } catch (error) {
    throw new Error(
      `Complete profile capacity integration failed during ${stage}: ${error.message}`,
      { cause: error },
    );
  } finally {
    if (composeCreated) {
      await compose(['down', '--remove-orphans', '--timeout', '3']).catch(
        () => undefined,
      );
    }
    for (const name of logicalVolumes) {
      try {
        const details = JSON.parse(
          (await docker(['volume', 'inspect', `${project}_${name}`])).stdout,
        )[0];
        ownedVolumes.add(verifyOwnedVolume(details, project, name));
      } catch {
        /* Preserve the primary failure and reject unverified resources. */
      }
    }
    for (const volume of ownedVolumes) {
      await docker(['volume', 'rm', volume]).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  qualifyProfileCapacity(process.argv[2])
    .then((result) =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    )
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
