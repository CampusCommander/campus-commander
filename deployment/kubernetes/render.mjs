import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import { redisImage } from '../redis/runtime.mjs';
import {
  httpProbe,
  prepare,
  waitDatabase,
  renderRedisScript,
  createDirectory,
} from './runtime-scripts.mjs';

const name = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .max(63);
const reference = z.strictObject({
  provider: z.literal('kubernetes'),
  name,
  key: name,
});
const image = z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
const cidr = z.string().refine((value) => {
  const [address, prefix, ...extra] = value.split('/');
  const version = isIP(address);
  return (
    !extra.length &&
    version &&
    /^\d+$/.test(prefix ?? '') &&
    Number(prefix) <= (version === 4 ? 32 : 128)
  );
}, 'Use an explicit IPv4 or IPv6 CIDR.');
const operatorSchema = z.strictObject({
  namespace: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
    .max(63),
  clusterDomain: z
    .string()
    .regex(/^[a-z0-9.-]+$/)
    .default('cluster.local'),
  workerNodeCount: z.number().int().min(2),
  imagePullSecrets: z.array(name).default([]),
  storageClasses: z.strictObject({
    postgres: name.optional(),
    artifacts: name,
    kestraInternal: name.optional(),
  }),
  release: z
    .object({
      schemaVersion: z.literal(1),
      sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
      architectures: z.array(z.literal('linux/amd64')).min(1),
      images: z.strictObject({ frontend: image, api: image, workers: image }),
    })
    .passthrough(),
  migrationRole: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
  migrationPasswordSecretRef: reference,
  databaseAdmins: z
    .strictObject({
      applicationDatabase: reference.optional(),
      kestraDatabase: reference.optional(),
    })
    .default({}),
  kestraRuntime: z
    .strictObject({
      name,
      applicationKey: name,
      keyStoreKey: name,
      probeHeaderKey: name,
      workerTrustStoreKey: name.optional(),
      javaOptionsKey: name.optional(),
      dispatchTokenKey: name,
    })
    .optional(),
  edgeIngress: z.strictObject({
    sourceRanges: z.array(cidr).min(1),
    annotations: z.record(z.string(), z.string()).default({}),
  }),
  externalEgress: z.record(z.string(), z.array(cidr).min(1)).default({}),
  dns: z.strictObject({
    namespace: name,
    podLabels: z.record(z.string(), z.string()),
  }),
});
const serviceNames = {
  frontend: 'frontend',
  api: 'api',
  workers: 'workers',
  applicationDatabase: 'application-postgres',
  kestraDatabase: 'kestra-postgres',
  redis: 'redis',
  kestra: 'kestra',
  edge: 'edge',
};
const postgresImage =
  'postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280';
const kestraImage =
  'docker.io/kestra/kestra@sha256:c9e6551c671d8e13274b85f3ccafb945065b8e35e33cf2ea3eeff817d52e7114';
const secretPath = (ref) => `/run/secrets/${ref.name}/${ref.key}`;
const caPath = (service) =>
  service.endpoint.tls.mode === 'private-ca'
    ? secretPath(service.endpoint.tls.caSecretRef)
    : '/etc/ssl/certs/ca-certificates.crt';
const collectRefs = (value) => {
  const refs = [];
  if (value && typeof value === 'object') {
    if (value.provider === 'kubernetes') refs.push(value);
    else
      for (const child of Object.values(value))
        refs.push(...collectRefs(child));
  }
  return refs;
};
const resources = (service) => ({
  requests: {
    cpu: `${service.placement.resources.cpuRequestMillis}m`,
    memory: `${service.placement.resources.memoryRequestMiB}Mi`,
  },
  limits: {
    cpu: `${service.placement.resources.cpuLimitMillis}m`,
    memory: `${service.placement.resources.memoryLimitMiB}Mi`,
  },
});
const security = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
};

export function renderKubernetes(input, operatorInput) {
  const config = parseDeploymentConfig(input),
    operator = operatorSchema.parse(operatorInput);
  if (config.profile !== 'kubernetes')
    throw new Error('Use the Kubernetes deployment profile.');
  if (
    config.services.api.placement.replicas < 2 ||
    config.services.workers.placement.replicas < 2 ||
    operator.workerNodeCount < config.services.workers.placement.replicas
  )
    throw new Error(
      'Provide multiple API replicas and distinct nodes for every worker replica.',
    );
  for (const key of ['frontend', 'api', 'workers'])
    if (operator.release.images[key] !== config.images[key])
      throw new Error(
        'Application images differ from the shared release inventory.',
      );
  if (
    [
      config.services.applicationDatabase.role,
      config.services.kestraDatabase.role,
    ].includes(operator.migrationRole)
  )
    throw new Error('Use a separate application migration role.');
  for (const [key, service] of Object.entries(config.services)) {
    if (
      service.placement.kind === 'local' &&
      key !== 'edge' &&
      new URL(service.endpoint.url).hostname !==
        `${serviceNames[key]}.${operator.namespace}.svc.${operator.clusterDomain}`
    )
      throw new Error(
        'Local service endpoints must use the selected namespace and service names.',
      );
    if (service.placement.kind === 'external' && !operator.externalEgress[key])
      throw new Error('Declare external dependency network ranges.');
    if (
      service.placement.kind === 'local' &&
      key !== 'edge' &&
      Number(
        new URL(service.endpoint.url).port ||
          (['applicationDatabase', 'kestraDatabase'].includes(key)
            ? 5432
            : key === 'redis'
              ? 6379
              : 443),
      ) < 1024
    )
      throw new Error(
        'Nonroot listeners require an explicit unprivileged port.',
      );
    if (
      ['applicationDatabase', 'kestraDatabase'].includes(key) &&
      service.placement.kind === 'local' &&
      (!operator.databaseAdmins[key] || !operator.storageClasses.postgres)
    )
      throw new Error(
        'Local PostgreSQL requires an administration secret and storage class.',
      );
    if (
      ['applicationDatabase', 'kestraDatabase'].includes(key) &&
      service.placement.kind === 'external' &&
      operator.databaseAdmins[key]
    )
      throw new Error(
        'External database provisioning belongs to the district operator. Omit administration references.',
      );
  }
  if (config.services.kestra.placement.kind === 'local') {
    if (!operator.kestraRuntime || !operator.storageClasses.kestraInternal)
      throw new Error(
        'Local Kestra requires prepared runtime secrets and shared internal storage.',
      );
    if (
      Number(new URL(config.services.kestra.endpoint.url).port || 443) !== 8080
    )
      throw new Error('The qualified Kestra listener requires port 8080.');
    if (
      config.services.workers.endpoint.tls.mode === 'private-ca' &&
      (!operator.kestraRuntime.workerTrustStoreKey ||
        !operator.kestraRuntime.javaOptionsKey)
    )
      throw new Error(
        'Kestra requires prepared JVM trust for private-CA workers.',
      );
  }
  const namespace = operator.namespace,
    items = [];
  const configurationHash = createHash('sha256')
    .update(JSON.stringify({ config, operator }))
    .digest('hex')
    .slice(0, 12);
  const configurationName = `campus-config-${configurationHash}`;
  const labels = (key) => ({
    'app.kubernetes.io/part-of': 'campus-commander',
    'app.kubernetes.io/name': key,
  });
  const metadata = (name, key = name) => ({
    name,
    namespace,
    labels: labels(key),
  });
  const object = (apiVersion, kind, name, spec) => ({
    apiVersion,
    kind,
    metadata: metadata(name),
    spec,
  });
  items.push({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespace,
      labels: { 'pod-security.kubernetes.io/enforce': 'restricted' },
    },
  });
  items.push({
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: metadata('campus-runtime'),
    automountServiceAccountToken: false,
  });
  const runtimeOperator = {
    migrationRole: operator.migrationRole,
    migrationPasswordSecretRef: operator.migrationPasswordSecretRef,
    databaseAdmins: operator.databaseAdmins,
  };
  items.push({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: metadata(configurationName),
    immutable: true,
    data: {
      'deployment.json': JSON.stringify(config),
      'operator.json': JSON.stringify(runtimeOperator),
      'http-probe.cjs': httpProbe,
      'prepare.mjs': prepare,
      'wait.mjs': waitDatabase,
      'redis.mjs': renderRedisScript,
      'pg_hba.conf':
        'local all all trust\nhostssl all all all scram-sha-256\nhostnossl all all all reject\n',
    },
  });
  const pvc = (name, size, storageClass, access) =>
    items.push(
      object('v1', 'PersistentVolumeClaim', name, {
        accessModes: [access],
        storageClassName: storageClass,
        resources: { requests: { storage: `${size}Gi` } },
      }),
    );
  pvc(
    'campus-artifacts',
    config.artifacts.capacityGiB,
    operator.storageClasses.artifacts,
    'ReadWriteMany',
  );
  if (config.services.kestra.placement.kind === 'local')
    pvc(
      'kestra-internal',
      config.services.kestra.internalStorage.capacityGiB,
      operator.storageClasses.kestraInternal,
      'ReadWriteMany',
    );
  const mountsFor = (refs) => {
    const groups = new Map();
    for (const ref of refs) {
      if (!groups.has(ref.name)) groups.set(ref.name, new Set());
      groups.get(ref.name).add(ref.key);
    }
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, keys], index) => ({
        volume: {
          name: `secret-${index}`,
          secret: {
            secretName: name,
            defaultMode: 0o440,
            items: [...keys].sort().map((key) => ({ key, path: key })),
          },
        },
        mount: {
          name: `secret-${index}`,
          mountPath: `/run/secrets/${name}`,
          readOnly: true,
        },
      }));
  };
  const pod = (key, refs, uid = 1000) => {
    const secrets = mountsFor(refs);
    return {
      serviceAccountName: 'campus-runtime',
      automountServiceAccountToken: false,
      imagePullSecrets: operator.imagePullSecrets.map((name) => ({ name })),
      nodeSelector: {
        'kubernetes.io/os': 'linux',
        'kubernetes.io/arch': 'amd64',
      },
      securityContext: {
        runAsNonRoot: true,
        runAsUser: uid,
        runAsGroup: uid,
        fsGroup: uid,
        fsGroupChangePolicy: 'OnRootMismatch',
        seccompProfile: { type: 'RuntimeDefault' },
      },
      terminationGracePeriodSeconds: key === 'kestra' ? 360 : 30,
      volumes: [
        {
          name: 'config',
          configMap: { name: configurationName, defaultMode: 0o444 },
        },
        { name: 'tmp', emptyDir: {} },
        ...secrets.map((item) => item.volume),
      ],
      containers: [],
      initContainers: [],
      _mounts: [
        { name: 'config', mountPath: '/config', readOnly: true },
        { name: 'tmp', mountPath: '/tmp' },
        ...secrets.map((item) => item.mount),
      ],
    };
  };
  const env = (values) =>
    Object.entries(values).map(([name, value]) => ({
      name,
      value: String(value),
    }));
  const commonContainer = (key, service, image, spec) => ({
    name: key,
    image,
    imagePullPolicy: 'IfNotPresent',
    securityContext: security,
    resources: resources(service),
    volumeMounts: spec._mounts,
  });
  const portFor = (key, service) =>
    key === 'edge'
      ? 8443
      : Number(
          new URL(service.endpoint.url).port ||
            (['applicationDatabase', 'kestraDatabase'].includes(key)
              ? 5432
              : key === 'redis'
                ? 6379
                : 443),
        );
  const timing = (service) => ({
    periodSeconds: service.health.intervalSeconds,
    timeoutSeconds: service.health.timeoutSeconds,
    failureThreshold: service.health.failureThreshold,
  });
  const nodeProbe = (service, path) => ({
    exec: { command: ['node', '/config/http-probe.cjs', path] },
    ...timing(service),
  });
  const addDirectory = (spec, claim, path, subPath) => {
    const volume = claim;
    spec.volumes.push({
      name: volume,
      persistentVolumeClaim: { claimName: claim },
    });
    spec.initContainers.push({
      name: `prepare-${subPath}`,
      image: config.images.api,
      securityContext: security,
      resources: {
        requests: { cpu: '50m', memory: '64Mi' },
        limits: { cpu: '250m', memory: '128Mi' },
      },
      command: ['node', '-e', createDirectory],
      env: env({ CC_DIRECTORY: `/volume/${subPath}` }),
      volumeMounts: [{ name: volume, mountPath: '/volume' }],
    });
    return { name: volume, mountPath: path, subPath };
  };
  const waitContainer = (spec, serviceName) => ({
    name: 'wait-database',
    image: config.images.api,
    securityContext: security,
    resources: {
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '250m', memory: '128Mi' },
    },
    command: ['node', '/config/wait.mjs'],
    env: env({ CC_WAIT_DATABASE: serviceName }),
    volumeMounts: spec._mounts,
  });
  for (const [key, service] of Object.entries(config.services)) {
    if (service.placement.kind !== 'local') continue;
    let refs = collectRefs(service);
    if (key === 'api')
      refs = collectRefs([
        service,
        config.applicationAuth,
        ...Object.values(config.services).map(
          ({ endpoint, passwordSecretRef, authSecretRef }) => ({
            endpoint,
            passwordSecretRef,
            authSecretRef,
          }),
        ),
      ]);
    if (key === 'workers')
      refs = collectRefs([
        service,
        config.services.applicationDatabase.endpoint,
        config.services.applicationDatabase.passwordSecretRef,
      ]);
    if (key === 'edge')
      refs = collectRefs([
        service.serverTls,
        service.endpoint,
        config.services.frontend.endpoint,
        config.services.api.endpoint,
      ]);
    if (key === 'kestra') refs = collectRefs(service.endpoint);
    if (['applicationDatabase', 'kestraDatabase'].includes(key))
      refs = collectRefs([
        service.serverTls,
        service.endpoint,
        operator.databaseAdmins[key],
      ]);
    const spec = pod(
      key,
      refs,
      ['applicationDatabase', 'kestraDatabase'].includes(key) ? 999 : 1000,
    );
    const serviceName = serviceNames[key],
      port = portFor(key, service);
    let container;
    if (['frontend', 'api', 'workers', 'edge'].includes(key)) {
      container = commonContainer(
        key,
        service,
        config.images[key === 'edge' ? 'api' : key],
        spec,
      );
      const values = {
        PORT: port,
        CC_CONFIG_FILE: '/config/deployment.json',
        TLS_CERT_FILE: secretPath(service.serverTls.certificateSecretRef),
        TLS_KEY_FILE: secretPath(service.serverTls.privateKeySecretRef),
        TLS_SERVER_NAME: new URL(service.endpoint.url).hostname,
        CC_PROBE_HOST: new URL(service.endpoint.url).hostname,
        CC_PROBE_PORT: port,
      };
      if (service.endpoint.tls.mode === 'private-ca') {
        values.TLS_CA_FILE = caPath(service);
        values.CC_PROBE_CA = caPath(service);
      }
      if (key === 'workers')
        values.WORKER_DISPATCH_SECRET_FILE = secretPath(
          service.dispatchSecretRef,
        );
      container.env = env(values);
      if (key === 'edge')
        container.command = ['node', '/app/deployment/bootstrap/main.mjs'];
      container.livenessProbe = nodeProbe(service, '/health/live');
      container.readinessProbe = nodeProbe(
        service,
        ['api', 'edge'].includes(key) ? '/health/live' : '/health/ready',
      );
      container.startupProbe = {
        ...nodeProbe(service, '/health/live'),
        failureThreshold: Math.ceil(
          service.health.startupGraceSeconds / service.health.intervalSeconds,
        ),
      };
      if (['api', 'workers'].includes(key)) {
        spec.initContainers.push(waitContainer(spec, 'application'));
        container.volumeMounts = [
          ...container.volumeMounts,
          addDirectory(
            spec,
            'campus-artifacts',
            config.artifacts.location,
            'artifacts',
          ),
        ];
      }
      if (key === 'workers')
        spec.affinity = {
          podAntiAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: [
              {
                labelSelector: { matchLabels: labels('workers') },
                topologyKey: 'kubernetes.io/hostname',
              },
            ],
          },
        };
    } else if (['applicationDatabase', 'kestraDatabase'].includes(key)) {
      pvc(
        `${serviceName}-data`,
        service.persistence.capacityGiB,
        operator.storageClasses.postgres,
        'ReadWriteOnce',
      );
      spec.volumes.push(
        {
          name: 'data',
          persistentVolumeClaim: { claimName: `${serviceName}-data` },
        },
        { name: 'socket', emptyDir: {} },
      );
      container = commonContainer(serviceName, service, postgresImage, spec);
      container.env = env({
        POSTGRES_PASSWORD_FILE: secretPath(operator.databaseAdmins[key]),
        POSTGRES_INITDB_ARGS: '--encoding=UTF8 --auth-host=scram-sha-256',
        PGDATA: '/var/lib/postgresql/18/docker',
      });
      container.args = [
        'postgres',
        '-p',
        String(port),
        '-c',
        'ssl=on',
        '-c',
        `ssl_cert_file=${secretPath(service.serverTls.certificateSecretRef)}`,
        '-c',
        `ssl_key_file=${secretPath(service.serverTls.privateKeySecretRef)}`,
        '-c',
        'hba_file=/config/pg_hba.conf',
      ];
      container.volumeMounts = [
        ...container.volumeMounts,
        { name: 'data', mountPath: '/var/lib/postgresql' },
        { name: 'socket', mountPath: '/var/run/postgresql' },
      ];
      const command = [
        'sh',
        '-ec',
        `export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql 'host=${new URL(service.endpoint.url).hostname} hostaddr=127.0.0.1 port=${port} user=postgres dbname=postgres sslmode=verify-full sslrootcert=${caPath(service)}' -tAc 'SELECT 1'`,
      ];
      container.readinessProbe = { exec: { command }, ...timing(service) };
      container.livenessProbe = { tcpSocket: { port }, ...timing(service) };
      container.startupProbe = {
        exec: { command },
        ...timing(service),
        failureThreshold: Math.ceil(
          service.health.startupGraceSeconds / service.health.intervalSeconds,
        ),
      };
    } else if (key === 'redis') {
      spec.volumes.push(
        { name: 'generated', emptyDir: { medium: 'Memory' } },
        {
          name: 'data',
          emptyDir: { sizeLimit: `${service.persistence.capacityGiB}Gi` },
        },
      );
      spec.initContainers.push({
        name: 'render-redis',
        image: config.images.api,
        securityContext: security,
        resources: {
          requests: { cpu: '50m', memory: '64Mi' },
          limits: { cpu: '250m', memory: '128Mi' },
        },
        command: ['node', '/config/redis.mjs'],
        volumeMounts: [
          ...spec._mounts,
          { name: 'generated', mountPath: '/generated' },
        ],
      });
      container = commonContainer(key, service, redisImage, spec);
      container.args = ['redis-server', '/generated/redis.conf'];
      container.volumeMounts = [
        ...container.volumeMounts,
        { name: 'generated', mountPath: '/generated', readOnly: true },
        { name: 'data', mountPath: '/data' },
      ];
      const command = [
        'sh',
        '-ec',
        `export REDISCLI_AUTH="$(cat '${secretPath(service.passwordSecretRef)}')"; exec redis-cli --tls --cacert '${caPath(service)}' --sni '${new URL(service.endpoint.url).hostname}' -h 127.0.0.1 -p '${port}' PING`,
      ];
      container.readinessProbe = { exec: { command }, ...timing(service) };
      container.livenessProbe = { tcpSocket: { port }, ...timing(service) };
      container.startupProbe = {
        exec: { command },
        ...timing(service),
        failureThreshold: Math.ceil(
          service.health.startupGraceSeconds / service.health.intervalSeconds,
        ),
      };
    } else if (key === 'kestra') {
      const runtime = operator.kestraRuntime;
      spec.volumes.push({
        name: 'kestra-runtime',
        secret: {
          secretName: runtime.name,
          defaultMode: 0o440,
          items: [
            { key: runtime.applicationKey, path: 'application.yaml' },
            { key: runtime.keyStoreKey, path: 'server.p12' },
            { key: runtime.probeHeaderKey, path: 'probe-header' },
            ...(runtime.workerTrustStoreKey
              ? [
                  {
                    key: runtime.workerTrustStoreKey,
                    path: 'worker-truststore.p12',
                  },
                ]
              : []),
          ],
        },
      });
      const dbRefs = mountsFor(
        collectRefs([
          config.services.kestraDatabase.endpoint,
          config.services.kestraDatabase.passwordSecretRef,
        ]),
      );
      // The wait container requires database credentials in addition to the listener references.
      for (const entry of dbRefs) {
        const found = spec.volumes.find(
          (volume) =>
            volume.secret?.secretName === entry.volume.secret.secretName,
        );
        if (found) {
          for (const item of entry.volume.secret.items)
            if (
              !found.secret.items.some((existing) => existing.key === item.key)
            )
              found.secret.items.push(item);
        } else {
          entry.volume.name = `db-${entry.volume.name}`;
          entry.mount.name = entry.volume.name;
          spec.volumes.push(entry.volume);
          spec._mounts.push(entry.mount);
        }
      }
      spec.initContainers.push(waitContainer(spec, 'kestra'));
      container = commonContainer(key, service, kestraImage, spec);
      container.args = [
        'server',
        'standalone',
        '--config',
        '/run/kestra-runtime/application.yaml',
      ];
      container.env = [
        {
          name: 'ENV_CC_WORKER_BASE_URL',
          value: config.services.workers.endpoint.url,
        },
        {
          name: 'SECRET_CC_WORKER_DISPATCH_TOKEN',
          valueFrom: {
            secretKeyRef: { name: runtime.name, key: runtime.dispatchTokenKey },
          },
        },
        ...(runtime.javaOptionsKey
          ? [
              {
                name: 'JAVA_OPTS',
                valueFrom: {
                  secretKeyRef: {
                    name: runtime.name,
                    key: runtime.javaOptionsKey,
                  },
                },
              },
            ]
          : []),
      ];
      container.volumeMounts = [
        ...container.volumeMounts,
        {
          name: 'kestra-runtime',
          mountPath: '/run/kestra-runtime',
          readOnly: true,
        },
        addDirectory(
          spec,
          'kestra-internal',
          service.internalStorage.location,
          'kestra',
        ),
      ];
      const host = new URL(service.endpoint.url).hostname;
      const command = [
        'curl',
        '--fail',
        '--silent',
        '--show-error',
        '--output',
        '/dev/null',
        '--cacert',
        caPath(service),
        '--resolve',
        `${host}:${port}:127.0.0.1`,
        '--header',
        '@/run/kestra-runtime/probe-header',
        new URL('/api/v1/main/flows/search?size=1', service.endpoint.url).href,
      ];
      container.readinessProbe = { exec: { command }, ...timing(service) };
      container.livenessProbe = { tcpSocket: { port }, ...timing(service) };
      container.startupProbe = {
        exec: { command },
        ...timing(service),
        failureThreshold: Math.ceil(
          service.health.startupGraceSeconds / service.health.intervalSeconds,
        ),
      };
    }
    container.ports = [{ name: 'tls', containerPort: port }];
    spec.containers.push(container);
    delete spec._mounts;
    items.push(
      object('apps/v1', 'Deployment', serviceName, {
        replicas: service.placement.replicas,
        strategy: {
          type: [
            'applicationDatabase',
            'kestraDatabase',
            'redis',
            'kestra',
          ].includes(key)
            ? 'Recreate'
            : 'RollingUpdate',
          ...(key === 'workers'
            ? { rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } }
            : {}),
        },
        selector: { matchLabels: labels(key) },
        template: {
          metadata: {
            labels: labels(key),
            annotations: {
              'campus-commander/source-revision':
                operator.release.sourceRevision,
            },
          },
          spec,
        },
      }),
    );
    const serviceSpec = {
      selector: labels(key),
      ports: [
        {
          name: 'tls',
          port:
            key === 'edge'
              ? Number(new URL(service.endpoint.url).port || 443)
              : port,
          targetPort: 'tls',
        },
      ],
      ...(key === 'edge'
        ? {
            type: 'LoadBalancer',
            externalTrafficPolicy: 'Local',
            loadBalancerSourceRanges: operator.edgeIngress.sourceRanges,
          }
        : {}),
      ...(['applicationDatabase', 'kestraDatabase'].includes(key)
        ? { publishNotReadyAddresses: true }
        : {}),
    };
    const serviceObject = object('v1', 'Service', serviceName, serviceSpec);
    if (key === 'edge')
      serviceObject.metadata.annotations = operator.edgeIngress.annotations;
    items.push(serviceObject);
  }
  const jobRefs = collectRefs([
    config.services.applicationDatabase.endpoint,
    config.services.applicationDatabase.passwordSecretRef,
    config.services.kestraDatabase.endpoint,
    config.services.kestraDatabase.passwordSecretRef,
    config.services.api.bootstrapSecretRef,
    operator.migrationPasswordSecretRef,
    operator.databaseAdmins,
  ]);
  const job = pod('database-prepare', jobRefs);
  const jobContainer = {
    name: 'prepare',
    image: config.images.api,
    command: ['node', '/config/prepare.mjs'],
    securityContext: security,
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '256Mi' },
    },
    volumeMounts: job._mounts,
  };
  job.containers.push(jobContainer);
  delete job._mounts;
  job.restartPolicy = 'Never';
  items.push(
    object(
      'batch/v1',
      'Job',
      `database-prepare-${operator.release.sourceRevision.slice(0, 12)}-${configurationHash}`,
      {
        backoffLimit: 6,
        activeDeadlineSeconds: 900,
        template: {
          metadata: { labels: labels('database-prepare') },
          spec: job,
        },
      },
    ),
  );
  items.push(
    object('networking.k8s.io/v1', 'NetworkPolicy', 'default-deny', {
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
    }),
  );
  items.push(
    object('networking.k8s.io/v1', 'NetworkPolicy', 'dns-egress', {
      podSelector: {},
      policyTypes: ['Egress'],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: {
                  'kubernetes.io/metadata.name': operator.dns.namespace,
                },
              },
              podSelector: { matchLabels: operator.dns.podLabels },
            },
          ],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
      ],
    }),
  );
  const dependencies = {
    edge: ['frontend', 'api'],
    api: [
      'frontend',
      'workers',
      'applicationDatabase',
      'kestraDatabase',
      'redis',
      'kestra',
    ],
    workers: ['applicationDatabase'],
    kestra: ['kestraDatabase', 'workers'],
    'database-prepare': ['applicationDatabase', 'kestraDatabase'],
  };
  if (config.applicationAuth && !operator.externalEgress.identityProvider)
    throw new Error(
      'Phase 2 requires explicit identity-provider egress CIDRs.',
    );
  const ingress = new Map();
  for (const [source, targets] of Object.entries(dependencies)) {
    if (
      source !== 'database-prepare' &&
      config.services[source].placement.kind !== 'local'
    ) {
      if (source === 'kestra')
        for (const target of targets) {
          if (config.services[target].placement.kind !== 'local') continue;
          if (!ingress.has(target)) ingress.set(target, []);
          ingress.get(target).push({
            from: operator.externalEgress[source].map((cidr) => ({
              ipBlock: { cidr },
            })),
            ports: [
              {
                protocol: 'TCP',
                port: portFor(target, config.services[target]),
              },
            ],
          });
        }
      continue;
    }
    const egress = [];
    for (const target of targets) {
      const service = config.services[target];
      const port = portFor(target, service);
      let to;
      if (service.placement.kind === 'local') {
        to = [{ podSelector: { matchLabels: labels(target) } }];
        if (!ingress.has(target)) ingress.set(target, []);
        ingress.get(target).push({
          from: [{ podSelector: { matchLabels: labels(source) } }],
          ports: [{ protocol: 'TCP', port }],
        });
      } else
        to = operator.externalEgress[target].map((cidr) => ({
          ipBlock: { cidr },
        }));
      egress.push({ to, ports: [{ protocol: 'TCP', port }] });
    }
    if (source === 'api' && config.applicationAuth) {
      const ports = [
        ...new Set([
          443,
          Number(new URL(config.applicationAuth.issuer).port || 443),
        ]),
      ];
      egress.push({
        to: operator.externalEgress.identityProvider.map((cidr) => ({
          ipBlock: { cidr },
        })),
        ports: ports.map((port) => ({ protocol: 'TCP', port })),
      });
    }
    items.push(
      object(
        'networking.k8s.io/v1',
        'NetworkPolicy',
        `${source.toLowerCase()}-egress`,
        {
          podSelector: { matchLabels: labels(source) },
          policyTypes: ['Egress'],
          egress,
        },
      ),
    );
  }
  if (config.services.edge.placement.kind === 'local')
    ingress.set('edge', [
      {
        from: operator.edgeIngress.sourceRanges.map((cidr) => ({
          ipBlock: { cidr },
        })),
        ports: [{ protocol: 'TCP', port: 8443 }],
      },
    ]);
  else
    for (const key of ['frontend', 'api']) {
      if (!ingress.has(key)) ingress.set(key, []);
      ingress.get(key).push({
        from: operator.externalEgress.edge.map((cidr) => ({
          ipBlock: { cidr },
        })),
        ports: [{ protocol: 'TCP', port: portFor(key, config.services[key]) }],
      });
    }
  for (const [key, rules] of ingress)
    items.push(
      object(
        'networking.k8s.io/v1',
        'NetworkPolicy',
        `${serviceNames[key]}-ingress`,
        {
          podSelector: { matchLabels: labels(key) },
          policyTypes: ['Ingress'],
          ingress: rules,
        },
      ),
    );
  return { apiVersion: 'v1', kind: 'List', items };
}
