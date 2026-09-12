#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  effectiveConfig,
  renderAllDocker,
  stageRuntimeFiles,
} from '../all-docker/render.mjs';

const secretName = (reference) =>
  reference.provider === 'file' ? basename(reference.path) : reference.name;
const mountedSecret = (reference) => ({
  source: secretName(reference),
  target: secretName(reference),
});
const local = (service) => service.placement.kind === 'local';
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
const hardening = {
  read_only: true,
  security_opt: ['no-new-privileges:true'],
  cap_drop: ['ALL'],
};

function collectReferences(value, references = []) {
  if (!value || typeof value !== 'object') return references;
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith('SecretRef')) references.push(child);
    else collectReferences(child, references);
  }
  return references;
}

function uniqueReferences(references) {
  return [
    ...new Map(
      references.map((reference) => [secretName(reference), reference]),
    ).values(),
  ];
}

function caReference(service) {
  return service.endpoint.tls.mode === 'private-ca'
    ? service.endpoint.tls.caSecretRef
    : undefined;
}

function secretsFor(...references) {
  return uniqueReferences(references.flat().filter(Boolean)).map(mountedSecret);
}

function serverTls(service) {
  return {
    TLS_CERT_FILE: `/run/secrets/${secretName(service.serverTls.certificateSecretRef)}`,
    TLS_KEY_FILE: `/run/secrets/${secretName(service.serverTls.privateKeySecretRef)}`,
    TLS_SERVER_NAME: new URL(service.endpoint.url).hostname,
    ...(caReference(service)
      ? { TLS_CA_FILE: `/run/secrets/${secretName(caReference(service))}` }
      : {}),
  };
}

function removeDependency(service, name) {
  if (!service?.depends_on) return;
  delete service.depends_on[name];
  if (!Object.keys(service.depends_on).length) delete service.depends_on;
}

function addNetwork(service, name) {
  service.networks ??= [];
  if (!service.networks.includes(name)) service.networks.push(name);
}

function configureApplicationTls(compose, config) {
  const services = config.services;
  for (const name of ['frontend', 'api', 'workers']) {
    const service = compose.services[name];
    if (!service) continue;
    service.environment = {
      ...(service.environment ?? {}),
      ...serverTls(services[name]),
      ...(name === 'workers' ? { REQUIRE_TLS: 'true' } : {}),
    };
    delete service.healthcheck;
  }
}

function configureEdgeHealth(compose, service) {
  const host = new URL(service.endpoint.url).hostname;
  const ca = caReference(service);
  compose.services.edge.healthcheck = {
    test: [
      'CMD',
      'node',
      '-e',
      `const fs=require('node:fs'),https=require('node:https'),host=${JSON.stringify(host)},request=https.get({hostname:'127.0.0.1',port:8443,path:'/health',servername:host${ca ? `,ca:fs.readFileSync('/run/secrets/${secretName(ca)}')` : ''},timeout:3000},response=>{response.resume();process.exit(response.statusCode===200?0:1)});request.on('timeout',()=>request.destroy());request.on('error',()=>process.exit(1))`,
    ],
    interval: '10s',
    timeout: '5s',
    retries: 12,
    start_period: '10s',
  };
}

function configurePostgresTls(service, config) {
  const certificate = config.serverTls.certificateSecretRef;
  const privateKey = config.serverTls.privateKeySecretRef;
  service.entrypoint = ['/bin/sh', '-ec'];
  service.command = [
    `cp /run/secrets/${secretName(certificate)} /run/postgres-tls/server.crt\n` +
      `cp /run/secrets/${secretName(privateKey)} /run/postgres-tls/server.key\n` +
      'chown postgres:postgres /run/postgres-tls/server.crt /run/postgres-tls/server.key\n' +
      'chmod 600 /run/postgres-tls/server.key\n' +
      'exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on ' +
      '-c ssl_cert_file=/run/postgres-tls/server.crt ' +
      '-c ssl_key_file=/run/postgres-tls/server.key',
  ];
  service.tmpfs = ['/run/postgres-tls:uid=999,gid=999,mode=0700'];
  service.secrets.push(mountedSecret(certificate), mountedSecret(privateKey));
}

function storagePreflight(images, config, includeKestra) {
  const volumes = [
    {
      type: 'bind',
      source: config.artifacts.location,
      target: '/check/artifacts',
    },
  ];
  const checks = [
    'test -r /check/artifacts',
    'test -w /check/artifacts',
    'test -x /check/artifacts',
  ];
  if (includeKestra) {
    volumes.push({
      type: 'bind',
      source: config.services.kestra.internalStorage.location,
      target: '/check/kestra',
    });
    checks.push(
      'test -r /check/kestra',
      'test -w /check/kestra',
      'test -x /check/kestra',
    );
  }
  return {
    image: images.api,
    user: '1000:1000',
    restart: 'no',
    ...hardening,
    command: ['/bin/sh', '-ec', checks.join('\n')],
    volumes,
    networks: ['internal'],
  };
}

function validateSupportedPlacement(config) {
  const services = config.services;
  if (local(services.applicationDatabase) !== local(services.kestraDatabase)) {
    throw new Error(
      'Hybrid local PostgreSQL requires both database services on the same installation host.',
    );
  }
  if (config.host.workerHosts > 1 && local(services.applicationDatabase)) {
    throw new Error(
      'Distributed workers require district PostgreSQL until a local database listener is separately qualified.',
    );
  }
  if (!local(services.kestra) && local(services.kestraDatabase)) {
    throw new Error('External Kestra requires district-owned PostgreSQL.');
  }
  if (
    config.host.workerHosts > 1 &&
    services.workers.placement.replicas !== config.host.workerHosts
  ) {
    throw new Error(
      'Distributed qualification requires one worker replica per declared worker host.',
    );
  }
}

function renderBase(input, release) {
  const compose = renderAllDocker(input, release, {
    profile: 'hybrid',
    allowExternal: true,
  });
  const config = effectiveConfig(input, release);
  const services = config.services;
  const images = config.images;
  validateSupportedPlacement(config);

  delete compose.services['volume-permissions'];
  for (const service of Object.values(compose.services)) {
    removeDependency(service, 'volume-permissions');
  }

  compose.services['storage-preflight'] = storagePreflight(
    images,
    config,
    local(services.kestra),
  );
  compose.services.api.depends_on['storage-preflight'] = {
    condition: 'service_completed_successfully',
  };
  compose.services.workers.depends_on['storage-preflight'] = {
    condition: 'service_completed_successfully',
  };

  for (const name of ['api', 'workers']) {
    compose.services[name].volumes = compose.services[name].volumes.map(
      (volume) =>
        typeof volume === 'string' && volume.startsWith('artifacts:')
          ? {
              type: 'bind',
              source: config.artifacts.location,
              target: config.artifacts.location,
            }
          : volume,
    );
  }
  delete compose.volumes.artifacts;
  delete compose.volumes['kestra-storage'];
  delete compose.volumes['kestra-runtime'];

  if (local(services.applicationDatabase)) {
    configurePostgresTls(
      compose.services['application-postgres'],
      services.applicationDatabase,
    );
    configurePostgresTls(
      compose.services['kestra-postgres'],
      services.kestraDatabase,
    );
  } else {
    for (const name of [
      'application-postgres',
      'kestra-postgres',
      'database-provision',
    ]) {
      delete compose.services[name];
    }
    for (const name of ['application-postgres', 'kestra-postgres']) {
      delete compose.volumes[name];
    }
    compose.services['database-migrate'].depends_on = {};
  }

  if (!local(services.redis)) {
    delete compose.services.redis;
    delete compose.services['redis-config'];
    delete compose.volumes['redis-runtime'];
  } else {
    compose.services['runtime-volume-permissions'] = {
      image: images.api,
      user: '0:0',
      restart: 'no',
      ...hardening,
      cap_add: ['CHOWN', 'FOWNER'],
      command: [
        '/bin/sh',
        '-ec',
        'chown 1000:1000 /redis-runtime\nchmod 700 /redis-runtime',
      ],
      volumes: ['redis-runtime:/redis-runtime'],
      networks: ['internal'],
    };
    compose.services['redis-config'].depends_on = {
      'runtime-volume-permissions': {
        condition: 'service_completed_successfully',
      },
    };
    compose.services.redis.secrets.push(
      mountedSecret(services.redis.serverTls.certificateSecretRef),
      mountedSecret(services.redis.serverTls.privateKeySecretRef),
    );
  }

  delete compose.services['kestra-config'];
  if (!local(services.kestra)) {
    delete compose.services.kestra;
  } else {
    compose.services.kestra.depends_on = {
      'storage-preflight': { condition: 'service_completed_successfully' },
      ...(local(services.kestraDatabase)
        ? {
            'database-provision': {
              condition: 'service_completed_successfully',
            },
          }
        : {}),
    };
    compose.services.kestra.volumes = [
      {
        type: 'bind',
        source: './runtime/kestra',
        target: '/run/kestra-runtime',
        read_only: true,
      },
      {
        type: 'bind',
        source: services.kestra.internalStorage.location,
        target: '/app/storage',
      },
    ];
    compose.services.kestra.tmpfs = ['/tmp:uid=1000,gid=1000,mode=0700'];
    compose.services.kestra.healthcheck = {
      test: [
        'CMD-SHELL',
        `curl --fail --silent --cacert /run/kestra-runtime/server-ca.pem --header @/run/kestra-runtime/probe-header ${JSON.stringify(services.kestra.endpoint.url + '/api/v1/main/flows/search?size=1')} >/dev/null`,
      ],
      interval: '15s',
      timeout: '5s',
      retries: 20,
      start_period: '60s',
    };
  }

  configureApplicationTls(compose, config);
  configureEdgeHealth(compose, services.edge);
  compose.services.frontend.secrets = secretsFor(
    services.frontend.serverTls.certificateSecretRef,
    services.frontend.serverTls.privateKeySecretRef,
    caReference(services.frontend),
  );
  compose.services.api.secrets = secretsFor(
    config.applicationAuth?.clientSecretRef,
    services.api.serverTls.certificateSecretRef,
    services.api.serverTls.privateKeySecretRef,
    services.applicationDatabase.passwordSecretRef,
    services.kestraDatabase.passwordSecretRef,
    services.redis.passwordSecretRef,
    services.kestra.authSecretRef,
    [
      services.applicationDatabase,
      services.kestraDatabase,
      services.redis,
      services.frontend,
      services.workers,
      services.kestra,
    ].map(caReference),
  );
  compose.services.workers.secrets = secretsFor(
    services.workers.dispatchSecretRef,
    services.workers.serverTls.certificateSecretRef,
    services.workers.serverTls.privateKeySecretRef,
    services.applicationDatabase.passwordSecretRef,
    caReference(services.applicationDatabase),
    caReference(services.workers),
  );
  compose.services.edge.secrets = secretsFor(
    services.edge.serverTls.certificateSecretRef,
    services.edge.serverTls.privateKeySecretRef,
    caReference(services.edge),
    caReference(services.frontend),
    caReference(services.api),
  );
  compose.services['database-migrate'].secrets = secretsFor(
    { provider: 'file', path: '/run/secrets/postgres-migrator' },
    caReference(services.applicationDatabase),
  );
  compose.services['database-migrate'].volumes = [profileMount, operatorMount];
  compose.services['bootstrap-initialize'].secrets = secretsFor(
    services.applicationDatabase.passwordSecretRef,
    services.edge.bootstrapSecretRef,
    caReference(services.applicationDatabase),
  );
  if (compose.services['database-provision']) {
    compose.services['database-provision'].secrets = secretsFor(
      services.applicationDatabase.passwordSecretRef,
      services.kestraDatabase.passwordSecretRef,
      {
        provider: 'file',
        path: '/run/secrets/application-postgres-admin-password',
      },
      { provider: 'file', path: '/run/secrets/kestra-postgres-admin-password' },
      { provider: 'file', path: '/run/secrets/postgres-migrator' },
      caReference(services.applicationDatabase),
      caReference(services.kestraDatabase),
    );
  }

  const references = uniqueReferences([
    ...collectReferences(config),
    { provider: 'file', path: '/run/secrets/postgres-migrator' },
    ...(local(services.applicationDatabase)
      ? [
          {
            provider: 'file',
            path: '/run/secrets/application-postgres-admin-password',
          },
          {
            provider: 'file',
            path: '/run/secrets/kestra-postgres-admin-password',
          },
        ]
      : []),
  ]);
  compose.secrets = Object.fromEntries(
    references.map((reference) => [
      secretName(reference),
      { file: `./private/${secretName(reference)}` },
    ]),
  );

  compose.networks.egress = {
    driver: 'bridge',
    labels: {
      'com.campus-commander.scope': 'district-endpoints-only',
    },
  };
  const apiNeedsEgress =
    Boolean(config.applicationAuth) ||
    !local(services.applicationDatabase) ||
    !local(services.kestraDatabase) ||
    !local(services.redis) ||
    !local(services.kestra) ||
    config.host.workerHosts > 1;
  if (apiNeedsEgress) addNetwork(compose.services.api, 'egress');
  if (!local(services.applicationDatabase)) {
    addNetwork(compose.services['database-migrate'], 'egress');
    addNetwork(compose.services['bootstrap-initialize'], 'egress');
    addNetwork(compose.services.workers, 'egress');
  }
  if (
    local(services.kestra) &&
    (!local(services.kestraDatabase) || config.host.workerHosts > 1)
  ) {
    addNetwork(compose.services.kestra, 'egress');
  }

  if (!local(services.redis)) removeDependency(compose.services.api, 'redis');
  if (!local(services.kestra)) removeDependency(compose.services.api, 'kestra');
  if (config.host.workerHosts > 1) {
    delete compose.services.workers;
    removeDependency(compose.services.api, 'workers');
  }
  return compose;
}

function stageHybridRuntime(compose, image, network) {
  compose.volumes ??= {};
  compose.services['runtime-files'] = {
    image,
    user: '0:0',
    restart: 'no',
    ...hardening,
    cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
    command: ['/bin/sh', '-ec', 'true'],
    volumes: [],
    networks: [network],
  };
  stageRuntimeFiles(compose, {
    initializerName: 'runtime-files',
    directoryFiles: compose.services.kestra
      ? [
          {
            service: 'kestra',
            kind: 'runtime-files',
            source: './runtime/kestra',
            target: '/run/kestra-runtime',
            files: [
              'application.yaml',
              'database-ca.pem',
              'flow-secrets.env',
              'probe-header',
              'server-ca.pem',
              'server.p12',
              'worker-truststore.p12',
            ],
          },
        ]
      : [],
  });
  return compose;
}

export function renderHybrid(input, release) {
  const compose = renderBase(input, release);
  return stageHybridRuntime(
    compose,
    effectiveConfig(input, release).images.api,
    'internal',
  );
}

function validateBindAddress(value) {
  if (
    typeof value !== 'string' ||
    !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) ||
    value === '0.0.0.0' ||
    value.startsWith('127.') ||
    value.split('.').some((part) => Number(part) > 255)
  ) {
    throw new Error(
      'Each worker host requires an explicit non-loopback IPv4 district interface.',
    );
  }
}

export function renderWorkerHost(input, release, { hostIndex, bindAddress }) {
  const config = effectiveConfig(input, release);
  validateSupportedPlacement(config);
  if (
    !Number.isInteger(hostIndex) ||
    hostIndex < 0 ||
    hostIndex >= config.host.workerHosts
  ) {
    throw new Error('Worker host index is outside the declared host count.');
  }
  validateBindAddress(bindAddress);
  const base = renderAllDocker(input, release, {
    profile: 'hybrid',
    allowExternal: true,
  });
  configureApplicationTls(base, config);
  const worker = base.services.workers;
  worker.depends_on = {
    'storage-preflight': { condition: 'service_completed_successfully' },
  };
  worker.networks = ['egress'];
  const port = Number(
    new URL(config.services.workers.endpoint.url).port || 443,
  );
  worker.ports = [`${bindAddress}:${port}:${port}`];
  worker.volumes = [
    profileMount,
    {
      type: 'bind',
      source: config.artifacts.location,
      target: config.artifacts.location,
    },
  ];
  worker.secrets = secretsFor(
    config.services.workers.dispatchSecretRef,
    config.services.workers.serverTls.certificateSecretRef,
    config.services.workers.serverTls.privateKeySecretRef,
    config.services.applicationDatabase.passwordSecretRef,
    caReference(config.services.applicationDatabase),
    caReference(config.services.workers),
  );
  const preflight = storagePreflight(config.images, config, false);
  preflight.networks = ['egress'];
  const usedSecretNames = new Set(worker.secrets.map(({ source }) => source));
  const references = uniqueReferences(collectReferences(config)).filter(
    (reference) => usedSecretNames.has(secretName(reference)),
  );
  return stageHybridRuntime(
    {
      name: `campus-commander-worker-${hostIndex + 1}`,
      services: { 'storage-preflight': preflight, workers: worker },
      networks: {
        egress: {
          driver: 'bridge',
          labels: {
            'com.campus-commander.scope': 'district-endpoints-only',
          },
        },
      },
      secrets: Object.fromEntries(
        references.map((reference) => [
          secretName(reference),
          { file: `./private/${secretName(reference)}` },
        ]),
      ),
    },
    config.images.api,
    'egress',
  );
}

export async function renderFiles(
  configPath,
  releasePath,
  outputPath,
  { workerBindAddresses = [] } = {},
) {
  const input = JSON.parse(await readFile(configPath, 'utf8'));
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  if (
    input.host.workerHosts > 1 &&
    workerBindAddresses.length !== input.host.workerHosts
  ) {
    throw new Error('Provide one district bind address for each worker host.');
  }
  const compose = renderHybrid(input, release);
  const outputDirectory = resolve(dirname(outputPath));
  await mkdir(resolve(outputDirectory, 'runtime'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(compose, null, 2)}\n`);
  await writeFile(
    resolve(outputDirectory, 'runtime/profile.json'),
    `${JSON.stringify(effectiveConfig(input, release), null, 2)}\n`,
  );
  if (input.host.workerHosts > 1) {
    await Promise.all(
      workerBindAddresses.map((bindAddress, hostIndex) =>
        writeFile(
          resolve(
            outputDirectory,
            `docker-compose.worker-${hostIndex + 1}.yml`,
          ),
          `${JSON.stringify(
            renderWorkerHost(input, release, { hostIndex, bindAddress }),
            null,
            2,
          )}\n`,
        ),
      ),
    );
  }
  return compose;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [configPath, releasePath, outputPath = 'docker-compose.hybrid.yml'] =
    process.argv.slice(2);
  if (!configPath || !releasePath) {
    throw new Error(
      'Usage: render.mjs <config> <release-manifest> [compose-output]',
    );
  }
  const workerBindAddresses = (process.env.CC_WORKER_BIND_ADDRESSES ?? '')
    .split(',')
    .filter(Boolean);
  renderFiles(configPath, releasePath, outputPath, {
    workerBindAddresses,
  }).catch(() => {
    process.stderr.write(
      'Hybrid rendering failed. Check placements, release inventory, bind addresses, and district endpoints.\n',
    );
    process.exitCode = 1;
  });
}
