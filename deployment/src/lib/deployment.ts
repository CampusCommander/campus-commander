import { z } from 'zod';

const name = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const absolutePath = z
  .string()
  .regex(/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/);
const positiveInteger = z.number().int().positive();
const image = z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/);

export const secretReferenceSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('file'),
    path: z.string().regex(/^\/run\/secrets\/[a-z][a-z0-9-]{0,62}$/),
  }),
  z.strictObject({ provider: z.literal('kubernetes'), name, key: name }),
]);

const tls = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('disabled') }),
  z.strictObject({ mode: z.literal('system-ca') }),
  z.strictObject({
    mode: z.literal('private-ca'),
    caSecretRef: secretReferenceSchema,
  }),
]);

const endpoint = z.strictObject({
  url: z.string().refine((value) => {
    try {
      const url = new URL(value);
      return (
        Boolean(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.pathname === '' || url.pathname === '/') &&
        ['http:', 'https:', 'postgresql:', 'redis:', 'rediss:'].includes(
          url.protocol,
        )
      );
    } catch {
      return false;
    }
  }, 'Use a service origin without credentials, query, fragment, or path.'),
  tls,
});

const health = z
  .strictObject({
    probe: z.enum(['http', 'postgresql', 'redis']),
    path: z
      .string()
      .regex(/^\/[a-zA-Z0-9/_-]*$/)
      .optional(),
    intervalSeconds: positiveInteger,
    timeoutSeconds: positiveInteger,
    startupGraceSeconds: positiveInteger,
    failureThreshold: positiveInteger,
  })
  .superRefine((value, ctx) => {
    if ((value.probe === 'http') !== (value.path !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'Only HTTP probes require a path.',
      });
    }
    if (value.timeoutSeconds >= value.intervalSeconds) {
      ctx.addIssue({
        code: 'custom',
        path: ['timeoutSeconds'],
        message: 'Probe timeout must be shorter than its interval.',
      });
    }
  });

const resources = z
  .strictObject({
    cpuRequestMillis: positiveInteger,
    cpuLimitMillis: positiveInteger,
    memoryRequestMiB: positiveInteger,
    memoryLimitMiB: positiveInteger,
  })
  .superRefine((value, ctx) => {
    for (const [request, limit] of [
      ['cpuRequestMillis', 'cpuLimitMillis'],
      ['memoryRequestMiB', 'memoryLimitMiB'],
    ] as const) {
      if (value[request] > value[limit]) {
        ctx.addIssue({
          code: 'custom',
          path: [request],
          message: 'Resource request exceeds its limit.',
        });
      }
    }
  });

const placement = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('local'),
    replicas: positiveInteger,
    resources,
  }),
  z.strictObject({ kind: z.literal('external'), operator: name }),
]);

const service = z.strictObject({
  placement,
  endpoint,
  health,
  serverTls: z
    .strictObject({
      certificateSecretRef: secretReferenceSchema,
      privateKeySecretRef: secretReferenceSchema,
    })
    .optional(),
});
const persistence = z.strictObject({
  kind: z.enum(['local-volume', 'shared-filesystem', 'external-managed']),
  location: absolutePath,
  capacityGiB: positiveInteger,
  operator: name,
});

const database = service.extend({
  database: name,
  role: name,
  passwordSecretRef: secretReferenceSchema,
  migrationOwner: z.enum(['application-installer', 'kestra']),
  persistence,
});

const shape = z.strictObject({
  schemaVersion: z.literal(1),
  phase: z.literal(1),
  profile: z.enum(['all-docker', 'hybrid', 'kubernetes']),
  host: z.strictObject({
    os: z.literal('linux'),
    architecture: z.literal('amd64'),
    workerHosts: positiveInteger,
  }),
  images: z.strictObject({ frontend: image, api: image, workers: image }),
  components: z.strictObject({
    qualification: z.literal('pending'),
    followOn: z.literal('P1-T02/P1-T03/P1-T16'),
  }),
  services: z.strictObject({
    frontend: service,
    api: service.extend({ bootstrapSecretRef: secretReferenceSchema }),
    workers: service.extend({ dispatchSecretRef: secretReferenceSchema }),
    applicationDatabase: database,
    kestraDatabase: database,
    redis: service.extend({
      passwordSecretRef: secretReferenceSchema,
      persistence,
      restartPolicy: z.literal('discard-cache'),
    }),
    kestra: service.extend({
      authSecretRef: secretReferenceSchema,
      internalStorage: persistence,
    }),
    edge: service.extend({
      bootstrapSecretRef: secretReferenceSchema,
      access: z.literal('bootstrap-only'),
    }),
  }),
  artifacts: persistence,
});

export const deploymentConfigSchema = shape.superRefine((config, ctx) => {
  const reject = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  const services = config.services;
  const distributed =
    config.profile === 'kubernetes' || config.host.workerHosts > 1;
  for (const [key, value] of Object.entries(services)) {
    const path = ['services', key];
    // Field refinements can fail without preventing this refinement.
    let protocol: string;
    try {
      protocol = new URL(value.endpoint.url).protocol;
    } catch {
      continue;
    }
    const databaseService =
      key === 'applicationDatabase' || key === 'kestraDatabase';
    const expectedProbe = databaseService
      ? 'postgresql'
      : key === 'redis'
        ? 'redis'
        : 'http';
    const allowed = databaseService
      ? ['postgresql:']
      : key === 'redis'
        ? ['redis:', 'rediss:']
        : ['http:', 'https:'];
    if (!allowed.includes(protocol))
      reject(
        [...path, 'endpoint', 'url'],
        'Endpoint protocol does not match the service.',
      );
    if (value.health.probe !== expectedProbe)
      reject(
        [...path, 'health', 'probe'],
        'Health probe does not match the service.',
      );
    const encrypted = value.endpoint.tls.mode !== 'disabled';
    if (
      !databaseService &&
      encrypted !== ['https:', 'rediss:'].includes(protocol)
    ) {
      reject(
        [...path, 'endpoint', 'tls'],
        'TLS mode contradicts the endpoint protocol.',
      );
    }
    if (
      (key === 'edge' || value.placement.kind === 'external' || distributed) &&
      !encrypted
    ) {
      reject(
        [...path, 'endpoint', 'tls'],
        'Edge, external, and distributed endpoints require verified TLS.',
      );
    }
    const needsServerTls = value.placement.kind === 'local' && encrypted;
    if (needsServerTls !== (value.serverTls !== undefined)) {
      reject(
        [...path, 'serverTls'],
        'Local TLS listeners require certificate and private-key references. Other listeners must omit server TLS.',
      );
    }
    if (config.profile === 'all-docker' && value.placement.kind !== 'local') {
      reject(
        [...path, 'placement'],
        'The all-Docker profile requires local services.',
      );
    }
    if (
      ['frontend', 'api', 'workers'].includes(key) &&
      value.placement.kind !== 'local'
    ) {
      reject(
        [...path, 'placement'],
        'Application services must run in the selected runtime.',
      );
    }
    if (
      value.placement.kind === 'local' &&
      !['frontend', 'api', 'workers', 'edge'].includes(key) &&
      value.placement.replicas !== 1
    ) {
      reject(
        [...path, 'placement', 'replicas'],
        'Stateful service replication requires separate qualification.',
      );
    }
  }
  if (
    config.profile === 'hybrid' &&
    !Object.values(services).some(
      (value) => value.placement.kind === 'external',
    )
  ) {
    reject(['profile'], 'The hybrid profile requires an external service.');
  }
  if (config.profile === 'all-docker' && config.host.workerHosts !== 1) {
    reject(
      ['host', 'workerHosts'],
      'The all-Docker profile requires one worker host.',
    );
  }
  const workers = services.workers.placement;
  if (workers.kind === 'local' && workers.replicas < config.host.workerHosts) {
    reject(['host', 'workerHosts'], 'Worker hosts exceed worker replicas.');
  }
  if (sameOrigin(services.api.endpoint.url, services.workers.endpoint.url)) {
    reject(
      ['services', 'workers', 'endpoint'],
      'Workers require an endpoint separate from the API.',
    );
  }
  const appDb = services.applicationDatabase;
  const kestraDb = services.kestraDatabase;
  if (
    appDb.database === kestraDb.database ||
    appDb.role === kestraDb.role ||
    sameSecret(appDb.passwordSecretRef, kestraDb.passwordSecretRef)
  ) {
    reject(
      ['services', 'kestraDatabase'],
      'Application and Kestra require distinct databases, roles, and secret references.',
    );
  }
  if (appDb.migrationOwner !== 'application-installer') {
    reject(
      ['services', 'applicationDatabase', 'migrationOwner'],
      'The application installer owns application migrations.',
    );
  }
  if (kestraDb.migrationOwner !== 'kestra') {
    reject(
      ['services', 'kestraDatabase', 'migrationOwner'],
      'Kestra owns Kestra migrations.',
    );
  }
  if (
    !sameSecret(
      services.api.bootstrapSecretRef,
      services.edge.bootstrapSecretRef,
    )
  ) {
    reject(
      ['services', 'api', 'bootstrapSecretRef'],
      'API and edge must reference the same bootstrap credential.',
    );
  }
  if (
    config.artifacts.kind === 'external-managed' ||
    (distributed && config.artifacts.kind !== 'shared-filesystem')
  ) {
    reject(
      ['artifacts', 'kind'],
      'Distributed artifact consumers require a shared filesystem.',
    );
  }
  if (
    config.profile === 'all-docker' &&
    config.artifacts.kind !== 'local-volume'
  ) {
    reject(
      ['artifacts', 'kind'],
      'The all-Docker profile requires local artifact persistence.',
    );
  }
  for (const key of [
    'applicationDatabase',
    'kestraDatabase',
    'redis',
    'kestra',
  ] as const) {
    const value = services[key];
    const storageKey = key === 'kestra' ? 'internalStorage' : 'persistence';
    const storage =
      key === 'kestra'
        ? services.kestra.internalStorage
        : services[key].persistence;
    if (
      (value.placement.kind === 'external') !==
      (storage.kind === 'external-managed')
    ) {
      reject(
        ['services', key, storageKey, 'kind'],
        'Persistence ownership contradicts service placement.',
      );
    }
    if (
      key === 'kestra' &&
      value.placement.kind === 'local' &&
      distributed &&
      storage.kind !== 'shared-filesystem'
    ) {
      reject(
        ['services', key, storageKey, 'kind'],
        'Distributed Kestra consumers require shared internal storage.',
      );
    }
  }
  if (
    overlappingPaths(
      config.artifacts.location,
      services.kestra.internalStorage.location,
    )
  ) {
    reject(
      ['artifacts', 'location'],
      'Artifacts and Kestra internal storage require separate directory trees.',
    );
  }
  const expectedProvider =
    config.profile === 'kubernetes' ? 'kubernetes' : 'file';
  const inspectSecrets = (value: unknown, path: string[]) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith('SecretRef')) {
        const ref = secretReferenceSchema.safeParse(child);
        if (ref.success && ref.data.provider !== expectedProvider)
          reject([...path, key], 'Secret provider does not match the runtime.');
      } else inspectSecrets(child, [...path, key]);
    }
  };
  inspectSecrets(config, []);
});

export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;
export type SecretReference = z.infer<typeof secretReferenceSchema>;
export type DeploymentProfile = DeploymentConfig['profile'];

function sameSecret(left: SecretReference, right: SecretReference): boolean {
  return left.provider === 'file' && right.provider === 'file'
    ? left.path === right.path
    : left.provider === 'kubernetes' &&
        right.provider === 'kubernetes' &&
        left.name === right.name &&
        left.key === right.key;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function overlappingPaths(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

export interface ConfigurationIssue {
  path: string;
  message: string;
}

export class DeploymentConfigurationError extends Error {
  constructor(readonly issues: ConfigurationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
    this.name = 'DeploymentConfigurationError';
  }
}

/** Validate configuration before resolving secrets or starting services. */
export function parseDeploymentConfig(input: unknown): DeploymentConfig {
  const result = deploymentConfigSchema.safeParse(input);
  if (!result.success) {
    throw new DeploymentConfigurationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'configuration',
        message:
          issue.code === 'custom'
            ? issue.message
            : 'Missing, unknown, or invalid configuration setting.',
      })),
    );
  }
  return result.data;
}

/** Validate the release profile set before packaging examples. */
export function validateProfileSet(configs: readonly DeploymentConfig[]): void {
  const profiles = new Set(configs.map((config) => config.profile));
  if (configs.length !== 3 || profiles.size !== 3) {
    throw new DeploymentConfigurationError([
      {
        path: 'profiles',
        message: 'Provide exactly one configuration for each profile.',
      },
    ]);
  }
  for (const key of ['frontend', 'api', 'workers'] as const) {
    if (
      configs.some((config) => config.images[key] !== configs[0].images[key])
    ) {
      throw new DeploymentConfigurationError([
        {
          path: `images.${key}`,
          message: 'Application images must match across all profiles.',
        },
      ]);
    }
  }
}
