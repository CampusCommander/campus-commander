import { execFile } from 'node:child_process';
import {
  access,
  readFile,
  statfs,
  mkdtemp,
  writeFile,
  rm,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { arch, platform, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import { secretPath } from '../redis/runtime.mjs';
import { connectDatabase } from '../postgres/index.mjs';
import { probeRedis } from '../redis/probe.mjs';
import { probeHttp } from '../bootstrap/status.mjs';
import { evaluatePlatformVersion } from './platforms.mjs';

const exec = promisify(execFile);
async function command(file, args) {
  const result = await exec(file, args, {
    timeout: file === 'docker' && args[0] === 'run' ? 300000 : 10000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function verifyDockerFilesystem(
  installationRoot,
  image,
  run = command,
) {
  const directory = await mkdtemp(
    join(resolve(installationRoot), '.docker-path-'),
  );
  const marker = randomBytes(32).toString('hex');
  const path = join(directory, 'marker');
  try {
    await writeFile(path, marker, { mode: 0o600, flag: 'wx' });
    await run('docker', [
      'run',
      '--rm',
      '--network=none',
      '--read-only',
      '--user=0:0',
      '--cap-drop=ALL',
      '--cap-add=DAC_OVERRIDE',
      '--security-opt=no-new-privileges:true',
      '--mount',
      `type=bind,source=${path},target=/probe-marker,readonly`,
      '--entrypoint=node',
      image,
      '-e',
      "const fs=require('node:fs');if(!fs.statSync('/probe-marker').isFile()||fs.readFileSync('/probe-marker','utf8')!==process.argv[1])process.exit(1)",
      marker,
    ]);
    return true;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyDockerResources(image, run = command) {
  await run('docker', [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--memory=128m',
    '--cpus=0.25',
    '--pids-limit=32',
    '--entrypoint=node',
    image,
    '-e',
    `const fs=require('node:fs');
const read=(...paths)=>fs.readFileSync(paths.find(p=>fs.existsSync(p)),'utf8').trim();
const root='/sys/fs/cgroup/';
const memory=read(root+'memory.max',root+'memory/memory.limit_in_bytes');
const pids=read(root+'pids.max',root+'pids/pids.max');
const cpu=fs.existsSync(root+'cpu.max')?read(root+'cpu.max'):
  read(root+'cpu/cpu.cfs_quota_us',root+'cpu,cpuacct/cpu.cfs_quota_us')+' '+
  read(root+'cpu/cpu.cfs_period_us',root+'cpu,cpuacct/cpu.cfs_period_us');
if(memory!=='134217728'||cpu!=='25000 100000'||pids!=='32')process.exit(1);`,
  ]);
  return true;
}

/** Inspect prerequisites without starting services or changing active credentials. */
export async function preflight(
  input,
  {
    installationRoot,
    cluster,
    ownedHttpsPort = false,
    run = command,
    resolveSecret = (ref) => readFile(secretPath(ref)),
  } = {},
) {
  const config = parseDeploymentConfig(input);
  const checks = [];
  const check = async (name, instruction, operation) => {
    try {
      const outcome = await operation();
      const result =
        typeof outcome === 'object' && outcome !== null
          ? outcome
          : { passed: outcome === true };
      checks.push({
        name,
        status: result.passed === true ? 'passed' : 'failed',
        ...Object.fromEntries(
          Object.entries(result).filter(([key]) => key !== 'passed'),
        ),
        ...(result.passed === true ? {} : { instruction }),
      });
    } catch {
      checks.push({ name, status: 'failed', instruction });
    }
  };
  await check(
    'image-references',
    'Replace synthetic example images with published release digests.',
    () =>
      Object.values(config.images).every(
        (value) =>
          !value.includes('example.') &&
          !/@sha256:([a-f0-9])\1{63}$/.test(value),
      ),
  );
  await check(
    'installation-directory',
    'Provide an existing private installation directory with read and write access.',
    async () => {
      if (typeof installationRoot !== 'string') return false;
      await access(installationRoot, constants.R_OK | constants.W_OK);
      return true;
    },
  );
  if (config.profile === 'kubernetes') {
    const contextMatches =
      typeof cluster?.context === 'string' &&
      (await run('kubectl', ['config', 'current-context']).catch(() => '')) ===
        cluster.context;
    await check(
      'cluster-context',
      'Select the explicitly named district test cluster context.',
      () => contextMatches,
    );
    await check(
      'cluster-version',
      'Install Kubernetes 1.35.8 or newer within major version 1 on the selected cluster.',
      async () => {
        if (!contextMatches)
          return evaluatePlatformVersion('kubernetes', undefined);
        const version = JSON.parse(
          await run('kubectl', ['version', '--output=json']),
        );
        return evaluatePlatformVersion(
          'kubernetes',
          version.serverVersion?.gitVersion,
        );
      },
    );
    await check(
      'cluster-nodes',
      'Provide the configured count of ready Linux amd64 worker nodes.',
      async () => {
        if (!contextMatches) return false;
        const nodes = JSON.parse(
          await run('kubectl', ['get', 'nodes', '-o', 'json']),
        );
        return (
          nodes.items.filter(
            (node) =>
              node.status.nodeInfo.architecture === 'amd64' &&
              node.status.nodeInfo.operatingSystem === 'linux' &&
              node.status.conditions.some(
                (condition) =>
                  condition.type === 'Ready' && condition.status === 'True',
              ),
          ).length >= config.host.workerHosts
        );
      },
    );
    await check(
      'cluster-storage-classes',
      'Provide the required district storage classes and validate shared-filesystem access through CC-10.',
      async () => {
        if (
          !contextMatches ||
          !Array.isArray(cluster.storageClasses) ||
          !cluster.storageClasses.length
        )
          return false;
        const classes = JSON.parse(
          await run('kubectl', ['get', 'storageclass', '-o', 'json']),
        );
        return cluster.storageClasses.every((name) =>
          classes.items.some((item) => item.metadata.name === name),
        );
      },
    );
  } else {
    await check(
      'host-architecture',
      'Use the qualified Linux amd64 host architecture.',
      () => platform() === 'linux' && arch() === 'x64',
    );
    await check(
      'docker-engine',
      'Install Docker Engine 29.7.2 or newer within major version 29 and grant socket access.',
      async () =>
        evaluatePlatformVersion(
          'dockerEngine',
          await run('docker', ['version', '--format', '{{.Server.Version}}']),
        ),
    );
    await check(
      'docker-compose',
      'Install Docker Compose 5.5.0 or newer within major version 5.',
      async () =>
        evaluatePlatformVersion(
          'dockerCompose',
          await run('docker', ['compose', 'version', '--short']),
        ),
    );
    await check(
      'docker-installation-filesystem',
      'Run the installer on the Docker daemon host. A container with a mounted host Docker socket is not an installation host.',
      () => verifyDockerFilesystem(installationRoot, config.images.api, run),
    );
    await check(
      'docker-resource-limits',
      'Docker must enforce CPU, memory, and process limits. For nested Docker, repeat the installer with a private cgroup namespace.',
      () => verifyDockerResources(config.images.api, run),
    );
    await check(
      'host-memory',
      'Provide memory for the configured local service requests and operating-system overhead.',
      () => {
        const memory = Object.values(config.services).reduce(
          (sum, service) =>
            sum +
            (service.placement.kind === 'local'
              ? service.placement.resources.memoryRequestMiB *
                service.placement.replicas
              : 0),
          0,
        );
        return totalmem() >= (memory + 512) * 1024 * 1024;
      },
    );
    await check(
      'time-synchronization',
      'Enable host time synchronization and verify the active time service.',
      async () =>
        (await run('timedatectl', [
          'show',
          '--property=NTPSynchronized',
          '--value',
        ])) === 'yes',
    );
    await check(
      'storage-capacity',
      'Provide free installation storage for the configured local persistent components.',
      async () => {
        const info = await statfs(installationRoot);
        const required = [
          'applicationDatabase',
          'kestraDatabase',
          'kestra',
        ].reduce(
          (sum, name) => {
            const service = config.services[name];
            const storage =
              name === 'kestra' ? service.internalStorage : service.persistence;
            return (
              sum +
              (service.placement.kind === 'local' &&
              storage.kind === 'local-volume'
                ? storage.capacityGiB
                : 0)
            );
          },
          config.artifacts.kind === 'local-volume'
            ? config.artifacts.capacityGiB
            : 0,
        );
        return info.bavail * info.bsize >= required * 1024 ** 3;
      },
    );
    await check(
      'edge-certificate',
      'Supply a current district-hostname certificate and its matching private key.',
      async () => {
        const edge = config.services.edge;
        const certificate = new X509Certificate(
          await resolveSecret(edge.serverTls.certificateSecretRef),
        );
        const key = createPrivateKey(
          await resolveSecret(edge.serverTls.privateKeySecretRef),
        );
        const now = Date.now();
        return (
          certificate.checkHost(new URL(edge.endpoint.url).hostname) !==
            undefined &&
          Date.parse(certificate.validFrom) <= now &&
          now < Date.parse(certificate.validTo) &&
          certificate.checkPrivateKey(key)
        );
      },
    );
    await check(
      'https-port',
      'Release the configured public HTTPS port before installation.',
      () =>
        ownedHttpsPort ||
        new Promise((done) => {
          const socket = net.createServer();
          socket.once('error', () => done(false));
          socket.listen(
            Number(new URL(config.services.edge.endpoint.url).port || 443),
            '0.0.0.0',
            () => socket.close(() => done(true)),
          );
        }),
    );
    await check(
      'registry-access',
      'Authenticate registry access and verify every immutable application image exists.',
      async () => {
        for (const image of new Set(Object.values(config.images)))
          await run('docker', ['manifest', 'inspect', image]);
        return true;
      },
    );
  }
  await check(
    'district-dns',
    'Configure district DNS for the declared HTTPS hostname.',
    async () => {
      await lookup(new URL(config.services.edge.endpoint.url).hostname);
      return true;
    },
  );
  for (const [name, service] of Object.entries(config.services)) {
    if (service.placement.kind !== 'external') continue;
    await check(
      `external-${name}`,
      'Verify the external endpoint, credential mounts, certificate trust, and service access.',
      async () => {
        if (service.health.probe === 'postgresql') {
          const client = await connectDatabase(service, resolveSecret);
          await client.end();
          return true;
        }
        if (name === 'redis')
          return (await probeRedis(service, resolveSecret)).status === 'ready';
        if (name === 'kestra') {
          const auth = JSON.parse(
            (await resolveSecret(service.authSecretRef)).toString('utf8'),
          );
          if (
            typeof auth.username !== 'string' ||
            typeof auth.password !== 'string'
          )
            return false;
          return probeHttp(service, resolveSecret, {
            path: '/api/v1/main/flows/search?size=1',
            authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
          });
        }
        return probeHttp(service, resolveSecret);
      },
    );
  }
  return {
    profile: config.profile,
    status: checks.every((item) => item.status === 'passed')
      ? 'passed'
      : 'failed',
    checks,
  };
}
