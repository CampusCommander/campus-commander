#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDeploymentConfig } from '../../../dist/deployment/lib/deployment.js';
import { redisImage } from '../../redis/runtime.mjs';

export const postgresImage =
  'postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280';
export const kestraImage =
  'docker.io/kestra/kestra@sha256:c9e6551c671d8e13274b85f3ccafb945065b8e35e33cf2ea3eeff817d52e7114';

const digestReference = /^[a-z0-9][a-z0-9./:-]*@sha256:[a-f0-9]{64}$/;
const restart = { restart: 'unless-stopped' };
const hardening = {
  read_only: true,
  security_opt: ['no-new-privileges:true'],
  cap_drop: ['ALL'],
};
const profileMount = {
  type: 'bind',
  source: './runtime/profile.json',
  target: '/run/config/profile.json',
  read_only: true,
};
const operatorMount = {
  type: 'bind',
  source: './runtime/operator.json',
  target: '/run/config/operator.json',
  read_only: true,
};
const health = (path, port, protocol = 'http') => ({
  test: [
    'CMD',
    'node',
    '-e',
    `fetch('${protocol}://127.0.0.1:${port}${path}').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`,
  ],
  interval: '10s',
  timeout: '3s',
  retries: 12,
  start_period: '10s',
});
const secretName = (reference) =>
  reference.provider === 'file' ? basename(reference.path) : reference.name;
const mountedSecret = (reference) => ({
  source: secretName(reference),
  target: secretName(reference),
});
const resourceLimits = (service) => ({
  deploy: {
    resources: {
      limits: {
        cpus: String(
          (service.placement.resources?.cpuLimitMillis ?? 500) / 1000,
        ),
        memory: `${service.placement.resources?.memoryLimitMiB ?? 512}M`,
      },
      reservations: {
        cpus: String(
          (service.placement.resources?.cpuRequestMillis ?? 100) / 1000,
        ),
        memory: `${service.placement.resources?.memoryRequestMiB ?? 128}M`,
      },
    },
  },
});

export function releaseImages(release) {
  const architectures =
    release?.architectures ?? (release?.platform ? [release.platform] : []);
  if (release?.schemaVersion !== 1 || !architectures.includes('linux/amd64'))
    throw new Error(
      'Release manifest must include linux/amd64 in schema version 1.',
    );
  const images = {
    frontend: release.images?.frontend,
    api: release.images?.api,
    workers: release.images?.workers ?? release.images?.worker,
  };
  if (Object.values(images).some((image) => !digestReference.test(image ?? '')))
    throw new Error('Release image references require repository digests.');
  return images;
}

export function effectiveConfig(input, release) {
  const images = releaseImages(release);
  return { ...structuredClone(input), images };
}

export function renderAllDocker(
  input,
  release,
  { profile = 'all-docker', allowExternal = false } = {},
) {
  const config = parseDeploymentConfig(input);
  if (config.profile !== profile)
    throw new Error(`The renderer requires the ${profile} profile.`);
  for (const service of Object.values(config.services)) {
    if (
      !allowExternal &&
      service.placement?.kind &&
      service.placement.kind !== 'local'
    )
      throw new Error(
        'The all-Docker profile requires local service placement.',
      );
  }
  const images = releaseImages(release);
  const services = config.services;
  const refs = {
    bootstrap: services.edge.bootstrapSecretRef,
    dispatch: services.workers.dispatchSecretRef,
    appPassword: services.applicationDatabase.passwordSecretRef,
    kestraPassword: services.kestraDatabase.passwordSecretRef,
    redisPassword: services.redis.passwordSecretRef,
    kestraAuth: services.kestra.authSecretRef,
  };
  const secretReferences = [
    ...Object.values(refs),
    ...(config.applicationAuth ? [config.applicationAuth.clientSecretRef] : []),
    services.edge.serverTls.certificateSecretRef,
    services.edge.serverTls.privateKeySecretRef,
  ];
  const secrets = Object.fromEntries(
    secretReferences.map((reference) => [
      secretName(reference),
      { file: `./private/${secretName(reference)}` },
    ]),
  );
  for (const name of [
    'application-postgres-admin-password',
    'kestra-postgres-admin-password',
    'postgres-migrator',
  ])
    secrets[name] = { file: `./private/${name}` };
  const apiSecrets = [
    ...(config.applicationAuth ? [config.applicationAuth.clientSecretRef] : []),
    refs.appPassword,
    refs.kestraPassword,
    refs.redisPassword,
    refs.kestraAuth,
  ].map(mountedSecret);
  const appDatabaseSecrets = [
    {
      source: 'application-postgres-admin-password',
      target: 'application-postgres-admin-password',
    },
  ];
  const kestraDatabaseSecrets = [
    {
      source: 'kestra-postgres-admin-password',
      target: 'kestra-postgres-admin-password',
    },
  ];

  const compose = {
    name: 'campus-commander',
    services: {
      'volume-permissions': {
        image: images.api,
        user: '0:0',
        restart: 'no',
        ...resourceLimits(services.api),
        command: [
          '/bin/sh',
          '-c',
          'mkdir -p /artifacts /kestra-storage /kestra-runtime /redis-runtime && chown -R 1000:1000 /artifacts /kestra-storage /kestra-runtime /redis-runtime && chmod 700 /artifacts /kestra-storage /kestra-runtime /redis-runtime',
        ],
        cap_drop: ['ALL'],
        cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
        security_opt: ['no-new-privileges:true'],
        volumes: [
          'artifacts:/artifacts',
          'kestra-storage:/kestra-storage',
          'kestra-runtime:/kestra-runtime',
          'redis-runtime:/redis-runtime',
        ],
        networks: ['internal'],
      },
      'application-postgres': {
        image: postgresImage,
        ...restart,
        ...resourceLimits(services.applicationDatabase),
        shm_size: '256mb',
        environment: {
          POSTGRES_PASSWORD_FILE:
            '/run/secrets/application-postgres-admin-password',
        },
        secrets: appDatabaseSecrets,
        volumes: ['application-postgres:/var/lib/postgresql'],
        networks: ['internal'],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U postgres -d postgres'],
          interval: '10s',
          timeout: '3s',
          retries: 12,
          start_period: '10s',
        },
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'],
      },
      'kestra-postgres': {
        image: postgresImage,
        ...restart,
        ...resourceLimits(services.kestraDatabase),
        shm_size: '256mb',
        environment: {
          POSTGRES_PASSWORD_FILE: '/run/secrets/kestra-postgres-admin-password',
        },
        secrets: kestraDatabaseSecrets,
        volumes: ['kestra-postgres:/var/lib/postgresql'],
        networks: ['internal'],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U postgres -d postgres'],
          interval: '10s',
          timeout: '3s',
          retries: 12,
          start_period: '10s',
        },
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'],
      },
      'redis-config': {
        image: images.api,
        user: '1000:1000',
        restart: 'no',
        ...hardening,
        ...resourceLimits(services.redis),
        command: [
          '/bin/sh',
          '-c',
          'rm -f /run/redis/redis.conf && exec node /app/deployment/redis/runtime.mjs /run/config/profile.json /run/redis/redis.conf',
        ],
        depends_on: {
          'volume-permissions': { condition: 'service_completed_successfully' },
        },
        secrets: [mountedSecret(refs.redisPassword)],
        volumes: [profileMount, 'redis-runtime:/run/redis'],
        networks: ['internal'],
      },
      redis: {
        image: redisImage,
        user: '1000:1000',
        ...restart,
        ...hardening,
        ...resourceLimits(services.redis),
        command: ['redis-server', '/run/redis/redis.conf'],
        depends_on: {
          'redis-config': { condition: 'service_completed_successfully' },
        },
        volumes: ['redis-runtime:/run/redis:ro'],
        tmpfs: ['/data:uid=1000,gid=1000,mode=0700'],
        networks: ['internal'],
        healthcheck: {
          test: [
            'CMD-SHELL',
            `REDISCLI_AUTH="$$(cat /run/secrets/${secretName(refs.redisPassword)})" redis-cli --no-auth-warning ping | grep -qx PONG`,
          ],
          interval: '10s',
          timeout: '3s',
          retries: 12,
          start_period: '5s',
        },
        secrets: [mountedSecret(refs.redisPassword)],
      },
      'database-provision': {
        image: images.api,
        restart: 'no',
        ...hardening,
        ...resourceLimits(services.applicationDatabase),
        command: [
          'node',
          '/app/deployment/postgres/cli.mjs',
          'provision',
          '/run/config/profile.json',
          '/run/config/operator.json',
        ],
        depends_on: {
          'application-postgres': { condition: 'service_healthy' },
          'kestra-postgres': { condition: 'service_healthy' },
        },
        secrets: [
          mountedSecret(refs.appPassword),
          mountedSecret(refs.kestraPassword),
          {
            source: 'application-postgres-admin-password',
            target: 'application-postgres-admin-password',
          },
          {
            source: 'kestra-postgres-admin-password',
            target: 'kestra-postgres-admin-password',
          },
          { source: 'postgres-migrator', target: 'postgres-migrator' },
        ],
        volumes: [profileMount, operatorMount],
        networks: ['internal'],
      },
      'database-migrate': {
        image: images.api,
        restart: 'no',
        ...hardening,
        ...resourceLimits(services.api),
        command: [
          'node',
          '/app/deployment/postgres/cli.mjs',
          'migrate',
          '/run/config/profile.json',
          '/run/config/operator.json',
        ],
        depends_on: {
          'database-provision': { condition: 'service_completed_successfully' },
        },
        secrets: [{ source: 'postgres-migrator', target: 'postgres-migrator' }],
        volumes: [profileMount, operatorMount],
        networks: ['internal'],
      },
      'bootstrap-initialize': {
        image: images.api,
        restart: 'no',
        ...hardening,
        ...resourceLimits(services.api),
        command: [
          'node',
          '/app/deployment/bootstrap/cli.mjs',
          'initialize',
          '/run/config/profile.json',
        ],
        depends_on: {
          'database-migrate': { condition: 'service_completed_successfully' },
        },
        secrets: [
          mountedSecret(refs.appPassword),
          mountedSecret(refs.bootstrap),
        ],
        volumes: [profileMount],
        networks: ['internal'],
      },
      'kestra-config': {
        image: images.api,
        restart: 'no',
        ...hardening,
        ...resourceLimits(services.kestra),
        command: ['node', '/app/deployment/kestra/render-config.mjs'],
        environment: {
          CC_KESTRA_PROFILE: 'all-docker',
          CC_KESTRA_RUNTIME_DIR: '/run/kestra-runtime',
          CC_KESTRA_RUNTIME_MOUNT_PATH: '/run/kestra-runtime',
          CC_KESTRA_AUTH_FILE: `/run/secrets/${secretName(refs.kestraAuth)}`,
          CC_KESTRA_DATABASE_PASSWORD_FILE: `/run/secrets/${secretName(refs.kestraPassword)}`,
          CC_KESTRA_DATABASE_URL: `jdbc:${services.kestraDatabase.endpoint.url}/${services.kestraDatabase.database}`,
          CC_KESTRA_DATABASE_USERNAME: services.kestraDatabase.role,
          CC_KESTRA_URL: services.kestra.endpoint.url,
          CC_KESTRA_STORAGE_PATH: '/app/storage',
          CC_KESTRA_WORKER_BASE_URL: services.workers.endpoint.url,
          CC_KESTRA_WORKER_DISPATCH_SECRET_FILE: `/run/secrets/${secretName(refs.dispatch)}`,
        },
        depends_on: {
          'volume-permissions': { condition: 'service_completed_successfully' },
          'database-provision': { condition: 'service_completed_successfully' },
        },
        secrets: [
          mountedSecret(refs.kestraAuth),
          mountedSecret(refs.kestraPassword),
          mountedSecret(refs.dispatch),
        ],
        volumes: ['kestra-runtime:/run/kestra-runtime'],
        networks: ['internal'],
      },
      kestra: {
        image: kestraImage,
        ...restart,
        ...hardening,
        ...resourceLimits(services.kestra),
        entrypoint: ['/bin/sh', '-c'],
        command: [
          'set -a; . /run/kestra-runtime/flow-secrets.env; set +a; exec docker-entrypoint.sh server standalone --config /run/kestra-runtime/application.yaml',
        ],
        depends_on: {
          'kestra-config': { condition: 'service_completed_successfully' },
          'kestra-postgres': { condition: 'service_healthy' },
        },
        volumes: [
          'kestra-runtime:/run/kestra-runtime:ro',
          'kestra-storage:/app/storage',
        ],
        tmpfs: ['/tmp:uid=1000,gid=1000,mode=0700'],
        networks: ['internal'],
        healthcheck: {
          test: [
            'CMD-SHELL',
            'curl --fail --silent --header @/run/kestra-runtime/probe-header "http://localhost:8080/api/v1/main/flows/search?size=1" >/dev/null',
          ],
          interval: '15s',
          timeout: '5s',
          retries: 20,
          start_period: '60s',
        },
      },
      frontend: {
        image: images.frontend,
        ...restart,
        ...hardening,
        ...resourceLimits(services.frontend),
        networks: ['ingress', 'internal'],
        healthcheck: health('/health', 8080),
        tmpfs: ['/tmp'],
      },
      workers: {
        image: images.workers,
        ...restart,
        ...hardening,
        ...resourceLimits(services.workers),
        networks: ['internal'],
        healthcheck: health('/health', 3001),
        tmpfs: ['/tmp'],
        environment: {
          PORT: '3001',
          WORKER_DISPATCH_SECRET_FILE: `/run/secrets/${secretName(refs.dispatch)}`,
          CC_CONFIG_FILE: '/run/config/profile.json',
        },
        secrets: [
          mountedSecret(refs.dispatch),
          mountedSecret(refs.appPassword),
        ],
        volumes: [
          profileMount,
          'artifacts:/var/lib/campus-commander/artifacts',
        ],
        depends_on: {
          'database-migrate': { condition: 'service_completed_successfully' },
          'volume-permissions': { condition: 'service_completed_successfully' },
        },
      },
      api: {
        image: images.api,
        ...restart,
        ...hardening,
        deploy: {
          ...resourceLimits(services.api).deploy,
          replicas: services.api.placement.replicas,
        },
        networks: ['ingress', 'internal'],
        healthcheck: health('/health', 3000),
        tmpfs: ['/tmp'],
        environment: {
          PORT: '3000',
          CC_CONFIG_FILE: '/run/config/profile.json',
        },
        secrets: apiSecrets,
        volumes: [
          profileMount,
          'artifacts:/var/lib/campus-commander/artifacts',
        ],
        depends_on: {
          'database-migrate': { condition: 'service_completed_successfully' },
          'bootstrap-initialize': {
            condition: 'service_completed_successfully',
          },
          redis: { condition: 'service_healthy' },
          kestra: { condition: 'service_healthy' },
          frontend: { condition: 'service_healthy' },
          workers: { condition: 'service_healthy' },
        },
      },
      edge: {
        image: images.api,
        ...restart,
        ...hardening,
        ...resourceLimits(services.edge),
        networks: ['ingress'],
        ports: ['443:8443'],
        tmpfs: ['/tmp'],
        command: ['node', '/app/deployment/bootstrap/main.mjs'],
        environment: {
          PORT: '8443',
          CC_CONFIG_FILE: '/run/config/profile.json',
        },
        secrets: [
          mountedSecret(refs.bootstrap),
          mountedSecret(services.edge.serverTls.certificateSecretRef),
          mountedSecret(services.edge.serverTls.privateKeySecretRef),
        ],
        volumes: [profileMount],
        depends_on: { api: { condition: 'service_healthy' } },
        healthcheck: {
          test: [
            'CMD',
            'node',
            '-e',
            `const fs=require('node:fs'),https=require('node:https'),host=${JSON.stringify(new URL(services.edge.endpoint.url).hostname)};https.get({hostname:'127.0.0.1',port:8443,path:'/health',servername:host,ca:fs.readFileSync('/run/secrets/${secretName(services.edge.serverTls.certificateSecretRef)}')},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))`,
          ],
          interval: '10s',
          timeout: '3s',
          retries: 12,
          start_period: '10s',
        },
      },
    },
    networks: { ingress: {}, internal: { internal: true } },
    volumes: {
      'application-postgres': {},
      'kestra-postgres': {},
      artifacts: {},
      'kestra-storage': {},
      'kestra-runtime': {},
      'redis-runtime': {},
    },
    secrets,
  };
  if (profile === 'all-docker') stageRuntimeFiles(compose);
  return compose;
}

export function stageRuntimeFiles(
  compose,
  { initializerName = 'volume-permissions', directoryFiles = [] } = {},
) {
  const initializer = compose.services[initializerName];
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const commands = [initializer.command[2], 'umask 077'];
  const sourceSecrets = new Set();
  initializer.command[1] = '-ec';
  initializer.read_only = true;
  initializer.volumes.push({
    type: 'bind',
    source: './runtime',
    target: '/source/config',
    read_only: true,
    bind: { create_host_path: false },
  });
  for (const [name, service] of Object.entries(compose.services)) {
    if (
      name === initializerName ||
      name.endsWith('-postgres') ||
      service.user === '0:0'
    )
      continue;
    service.user = '1000:1000';
    const configFiles = [];
    service.volumes = (service.volumes ?? []).filter((mount) => {
      if (
        typeof mount !== 'string' &&
        mount.target.startsWith('/run/config/')
      ) {
        configFiles.push(basename(mount.target));
        return false;
      }
      return true;
    });
    const files = (service.secrets ?? []).map(({ source, target }) => {
      sourceSecrets.add(source);
      return { source: `/run/secrets/${source}`, target };
    });
    const directories = directoryFiles.filter(
      (entry) => entry.service === name,
    );
    for (const directory of directories) {
      service.volumes = service.volumes.filter(
        (mount) =>
          typeof mount === 'string' || mount.target !== directory.target,
      );
      initializer.volumes.push({
        type: 'bind',
        source: directory.source,
        target: `/source/${name}-${directory.kind}`,
        read_only: true,
        bind: { create_host_path: false },
      });
    }
    for (const [kind, entries, target = `/run/${kind}`] of [
      ['secrets', files],
      [
        'config',
        configFiles.map((file) => ({
          source: `/source/config/${file}`,
          target: file,
        })),
      ],
      ...directories.map((directory) => [
        directory.kind,
        directory.files.map((file) => ({
          source: `/source/${name}-${directory.kind}/${file}`,
          target: file,
        })),
        directory.target,
      ]),
    ]) {
      if (!entries.length) continue;
      const volume = `${name}-${kind}`;
      const destination = `/staged/${volume}`;
      compose.volumes[volume] = {};
      initializer.volumes.push(`${volume}:${destination}`);
      service.volumes.push(`${volume}:${target}:ro`);
      commands.push(
        `mkdir -p ${quote(destination)}`,
        `find ${quote(destination)} -mindepth 1 -delete`,
      );
      for (const entry of entries) {
        const path = quote(`${destination}/${entry.target}`);
        commands.push(
          `rm -f ${path}`,
          `cp ${quote(entry.source)} ${path}`,
          `chmod 600 ${path}`,
        );
      }
      commands.push(
        `chown -R 1000:1000 ${quote(destination)}`,
        `chmod 700 ${quote(destination)}`,
      );
      service.depends_on ??= {};
      service.depends_on[initializerName] = {
        condition: 'service_completed_successfully',
      };
    }
    delete service.secrets;
  }
  initializer.secrets = [...sourceSecrets].map((name) => ({
    source: name,
    target: name,
  }));
  initializer.command[2] = commands.join('\n');
  for (const service of Object.values(compose.services)) {
    for (const { source, target } of service.secrets ?? []) {
      service.volumes ??= [];
      service.volumes.push({
        type: 'bind',
        source: compose.secrets[source].file,
        target: `/run/secrets/${target}`,
        read_only: true,
        bind: { create_host_path: false },
      });
    }
    delete service.secrets;
  }
  delete compose.secrets;
}

export async function renderFiles(configPath, releasePath, outputPath) {
  const input = JSON.parse(await readFile(configPath, 'utf8'));
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  const compose = renderAllDocker(input, release);
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await mkdir(resolve(dirname(outputPath), 'runtime'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(compose, null, 2)}\n`);
  await writeFile(
    resolve(dirname(outputPath), 'runtime/profile.json'),
    `${JSON.stringify(effectiveConfig(input, release), null, 2)}\n`,
  );
  return compose;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [configPath, releasePath, outputPath = 'docker-compose.yml'] =
    process.argv.slice(2);
  if (!configPath || !releasePath)
    throw new Error(
      'Usage: render.mjs <config> <release-manifest> [compose-output]',
    );
  renderFiles(configPath, releasePath, outputPath).catch(() => {
    process.stderr.write(
      'All-Docker profile rendering failed. Check the validated configuration and release manifest.\n',
    );
    process.exitCode = 1;
  });
}
