import { execFile } from 'node:child_process';
import { access, readFile, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { arch, platform, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import { secretPath } from '../redis/runtime.mjs';
import { connectDatabase } from '../postgres/index.mjs';
import { probeRedis } from '../redis/probe.mjs';
import { probeHttp } from '../bootstrap/status.mjs';

const exec = promisify(execFile);
async function command(file, args) {
  const result = await exec(file, args, {
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
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
      const passed = await operation();
      checks.push({
        name,
        status: passed === true ? 'passed' : 'failed',
        ...(passed === true ? {} : { instruction }),
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
      'Install Docker Engine and grant the operator access to its socket.',
      async () =>
        Boolean(
          await run('docker', ['version', '--format', '{{.Server.Version}}']),
        ),
    );
    await check(
      'docker-compose',
      'Install the qualified Docker Compose plugin.',
      async () =>
        Boolean(await run('docker', ['compose', 'version', '--short'])),
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
