import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  openSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  DeploymentConfigurationError,
  parseDeploymentConfig,
  validateProfileSet,
  type DeploymentProfile,
} from './deployment';

const profiles: DeploymentProfile[] = ['all-docker', 'hybrid', 'kubernetes'];
const workspace = resolve(import.meta.dirname, '../../..');
function fixture(profile: DeploymentProfile): unknown {
  return JSON.parse(
    readFileSync(
      resolve(workspace, 'deployment/examples', `${profile}.json`),
      'utf8',
    ),
  );
}
function changed(
  profile: DeploymentProfile,
  path: string,
  value: unknown,
): unknown {
  const config = fixture(profile);
  const parts = path.split('.');
  let target = config;
  for (const part of parts.slice(0, -1)) {
    if (!target || typeof target !== 'object')
      throw new Error('Invalid test path.');
    target = Reflect.get(target, part);
  }
  if (!target || typeof target !== 'object')
    throw new Error('Invalid test target.');
  Reflect.set(target, parts[parts.length - 1], value);
  return config;
}

describe('Phase 1 deployment contract', () => {
  it.each(profiles)('accepts the %s example', (profile) => {
    expect(parseDeploymentConfig(fixture(profile)).profile).toBe(profile);
  });

  it('uses identical application images across the three profiles', () => {
    const configs = profiles.map((profile) =>
      parseDeploymentConfig(fixture(profile)),
    );
    expect(() => validateProfileSet(configs)).not.toThrow();
    configs[1].images.api = `registry.example.org/api@sha256:${'f'.repeat(64)}`;
    expect(() => validateProfileSet(configs)).toThrow(
      'Application images must match',
    );
  });

  it('rejects missing or duplicate profiles', () => {
    const config = parseDeploymentConfig(fixture('all-docker'));
    expect(() => validateProfileSet([config])).toThrow('exactly one');
    expect(() => validateProfileSet([config, config, config])).toThrow(
      'exactly one',
    );
  });

  const invalid: {
    label: string;
    profile: DeploymentProfile;
    path: string;
    value: unknown;
    error: string;
  }[] = [
    {
      label: 'missing API',
      profile: 'all-docker',
      path: 'services.api',
      value: undefined,
      error: 'services.api',
    },
    {
      label: 'unknown credential field',
      profile: 'all-docker',
      path: 'services.redis.password',
      value: 'synthetic-sensitive-value',
      error: 'services.redis',
    },
    {
      label: 'unknown version',
      profile: 'all-docker',
      path: 'schemaVersion',
      value: 2,
      error: 'schemaVersion',
    },
    {
      label: 'unsupported architecture',
      profile: 'all-docker',
      path: 'host.architecture',
      value: 'arm64',
      error: 'host.architecture',
    },
    {
      label: 'later phase',
      profile: 'all-docker',
      path: 'phase',
      value: 3,
      error: 'phase',
    },
    {
      label: 'unpinned image',
      profile: 'all-docker',
      path: 'images.api',
      value: 'campus/api:latest',
      error: 'images.api',
    },
    {
      label: 'unqualified availability claim',
      profile: 'all-docker',
      path: 'components.qualification',
      value: 'qualified',
      error: 'components.qualification',
    },
    {
      label: 'embedded endpoint password',
      profile: 'hybrid',
      path: 'services.redis.endpoint.url',
      value: 'rediss://user:synthetic-sensitive-value@redis.example.org:6379',
      error: 'services.redis.endpoint.url',
    },
    {
      label: 'endpoint query credential',
      profile: 'all-docker',
      path: 'services.api.endpoint.url',
      value: 'http://api:3000?token=synthetic-sensitive-value',
      error: 'services.api.endpoint.url',
    },
    {
      label: 'malformed endpoint',
      profile: 'all-docker',
      path: 'services.api.endpoint.url',
      value: 'not a URL',
      error: 'services.api.endpoint.url',
    },
    {
      label: 'wrong protocol',
      profile: 'all-docker',
      path: 'services.applicationDatabase.endpoint.url',
      value: 'http://postgres:5432',
      error: 'Endpoint protocol',
    },
    {
      label: 'public HTTP',
      profile: 'all-docker',
      path: 'services.edge.endpoint',
      value: { url: 'http://campus.example.org', tls: { mode: 'disabled' } },
      error: 'require verified TLS',
    },
    {
      label: 'TLS protocol mismatch',
      profile: 'all-docker',
      path: 'services.api.endpoint.tls',
      value: { mode: 'system-ca' },
      error: 'TLS mode contradicts',
    },
    {
      label: 'external database without TLS',
      profile: 'hybrid',
      path: 'services.applicationDatabase.endpoint.tls',
      value: { mode: 'disabled' },
      error: 'require verified TLS',
    },
    {
      label: 'private CA without reference',
      profile: 'hybrid',
      path: 'services.redis.endpoint.tls',
      value: { mode: 'private-ca' },
      error: 'caSecretRef',
    },
    {
      label: 'raw secret',
      profile: 'all-docker',
      path: 'services.redis.passwordSecretRef',
      value: 'synthetic-sensitive-value',
      error: 'passwordSecretRef',
    },
    {
      label: 'secret path traversal',
      profile: 'all-docker',
      path: 'services.redis.passwordSecretRef.path',
      value: '/run/secrets/../password',
      error: 'passwordSecretRef.path',
    },
    {
      label: 'secret provider mismatch',
      profile: 'kubernetes',
      path: 'services.redis.passwordSecretRef',
      value: { provider: 'file', path: '/run/secrets/password' },
      error: 'Secret provider',
    },
    {
      label: 'missing bootstrap protection',
      profile: 'all-docker',
      path: 'services.edge.access',
      value: 'public',
      error: 'services.edge.access',
    },
    {
      label: 'bootstrap reference mismatch',
      profile: 'all-docker',
      path: 'services.api.bootstrapSecretRef.path',
      value: '/run/secrets/different-bootstrap',
      error: 'same bootstrap',
    },
    {
      label: 'database collision',
      profile: 'hybrid',
      path: 'services.kestraDatabase.database',
      value: 'campus',
      error: 'distinct databases',
    },
    {
      label: 'database role collision',
      profile: 'hybrid',
      path: 'services.kestraDatabase.role',
      value: 'campus-owner',
      error: 'distinct databases',
    },
    {
      label: 'database credential collision',
      profile: 'hybrid',
      path: 'services.kestraDatabase.passwordSecretRef.path',
      value: '/run/secrets/campus-database-password',
      error: 'distinct databases',
    },
    {
      label: 'application migration owner',
      profile: 'all-docker',
      path: 'services.applicationDatabase.migrationOwner',
      value: 'kestra',
      error: 'installer owns',
    },
    {
      label: 'Kestra migration owner',
      profile: 'all-docker',
      path: 'services.kestraDatabase.migrationOwner',
      value: 'application-installer',
      error: 'Kestra owns',
    },
    {
      label: 'external application',
      profile: 'hybrid',
      path: 'services.api.placement',
      value: { kind: 'external', operator: 'district' },
      error: 'Application services',
    },
    {
      label: 'all-Docker external service',
      profile: 'all-docker',
      path: 'services.redis.placement',
      value: { kind: 'external', operator: 'district' },
      error: 'requires local services',
    },
    {
      label: 'hybrid without external service',
      profile: 'all-docker',
      path: 'profile',
      value: 'hybrid',
      error: 'requires an external service',
    },
    {
      label: 'all-Docker multiple hosts',
      profile: 'all-docker',
      path: 'host.workerHosts',
      value: 2,
      error: 'one worker host',
    },
    {
      label: 'worker hosts exceed replicas',
      profile: 'hybrid',
      path: 'host.workerHosts',
      value: 3,
      error: 'exceed worker replicas',
    },
    {
      label: 'unqualified Kestra replicas',
      profile: 'kubernetes',
      path: 'services.kestra.placement.replicas',
      value: 2,
      error: 'replication requires',
    },
    {
      label: 'distributed local artifacts',
      profile: 'hybrid',
      path: 'artifacts.kind',
      value: 'local-volume',
      error: 'require a shared filesystem',
    },
    {
      label: 'Kubernetes local artifacts',
      profile: 'kubernetes',
      path: 'artifacts.kind',
      value: 'local-volume',
      error: 'require a shared filesystem',
    },
    {
      label: 'all-Docker shared artifacts',
      profile: 'all-docker',
      path: 'artifacts.kind',
      value: 'shared-filesystem',
      error: 'local artifact persistence',
    },
    {
      label: 'Kestra local distributed storage',
      profile: 'kubernetes',
      path: 'services.kestra.internalStorage.kind',
      value: 'local-volume',
      error: 'shared internal storage',
    },
    {
      label: 'external database local persistence',
      profile: 'hybrid',
      path: 'services.applicationDatabase.persistence.kind',
      value: 'local-volume',
      error: 'Persistence ownership',
    },
    {
      label: 'storage overlap',
      profile: 'all-docker',
      path: 'artifacts.location',
      value: '/var/lib/campus-commander/kestra-internal/artifacts',
      error: 'separate directory trees',
    },
    {
      label: 'relative storage path',
      profile: 'all-docker',
      path: 'artifacts.location',
      value: '../artifacts',
      error: 'artifacts.location',
    },
    {
      label: 'zero storage capacity',
      profile: 'all-docker',
      path: 'artifacts.capacityGiB',
      value: 0,
      error: 'capacityGiB',
    },
    {
      label: 'resource request exceeds limit',
      profile: 'all-docker',
      path: 'services.api.placement.resources.cpuRequestMillis',
      value: 1000,
      error: 'Resource request exceeds',
    },
    {
      label: 'zero replicas',
      profile: 'all-docker',
      path: 'services.api.placement.replicas',
      value: 0,
      error: 'replicas',
    },
    {
      label: 'wrong probe',
      profile: 'all-docker',
      path: 'services.redis.health.probe',
      value: 'postgresql',
      error: 'Health probe',
    },
    {
      label: 'missing HTTP health path',
      profile: 'all-docker',
      path: 'services.api.health.path',
      value: undefined,
      error: 'HTTP probes require a path',
    },
    {
      label: 'probe timeout exceeds interval',
      profile: 'all-docker',
      path: 'services.api.health.timeoutSeconds',
      value: 20,
      error: 'Probe timeout',
    },
    {
      label: 'distributed plaintext endpoint',
      profile: 'hybrid',
      path: 'services.api.endpoint',
      value: { url: 'http://api:3000', tls: { mode: 'disabled' } },
      error: 'require verified TLS',
    },
    {
      label: 'shared API and worker endpoint',
      profile: 'all-docker',
      path: 'services.workers.endpoint.url',
      value: 'http://api:3000/',
      error: 'endpoint separate',
    },
    {
      label: 'missing listener certificate',
      profile: 'kubernetes',
      path: 'services.api.serverTls',
      value: undefined,
      error: 'Local TLS listeners',
    },
    {
      label: 'external listener credentials',
      profile: 'hybrid',
      path: 'services.redis.serverTls',
      value: {
        certificateSecretRef: {
          provider: 'file',
          path: '/run/secrets/certificate',
        },
        privateKeySecretRef: {
          provider: 'file',
          path: '/run/secrets/private-key',
        },
      },
      error: 'Other listeners must omit',
    },
  ];
  it.each(invalid)('rejects $label', ({ profile, path, value, error }) => {
    expect(() => parseDeploymentConfig(changed(profile, path, value))).toThrow(
      error,
    );
  });

  it('does not retain or print credential values in validation errors', () => {
    for (const config of [
      changed(
        'all-docker',
        'services.redis.password',
        'synthetic-sensitive-value',
      ),
      changed(
        'all-docker',
        'services.redis.endpoint.url',
        'redis://user:synthetic-sensitive-value@redis:6379',
      ),
      changed(
        'all-docker',
        'services.redis.passwordSecretRef.path',
        'synthetic-sensitive-value',
      ),
    ]) {
      try {
        parseDeploymentConfig(config);
        throw new Error('Expected rejection.');
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentConfigurationError);
        expect(String(error)).not.toContain('synthetic-sensitive-value');
        expect(JSON.stringify(error)).not.toContain(
          'synthetic-sensitive-value',
        );
      }
    }
  });
});

describe('pre-start CLI', () => {
  const cli = resolve(workspace, 'dist/deployment/cli.js');
  function runCli(args: string[]) {
    const directory = mkdtempSync(resolve(tmpdir(), 'cc-4-cli-'));
    const stdoutPath = resolve(directory, 'stdout');
    const stderrPath = resolve(directory, 'stderr');
    const stdout = openSync(stdoutPath, 'w');
    const stderr = openSync(stderrPath, 'w');
    try {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: workspace,
        stdio: ['ignore', stdout, stderr],
        timeout: 10000,
      });
      return {
        status: result.status,
        stdout: readFileSync(stdoutPath, 'utf8'),
        stderr: readFileSync(stderrPath, 'utf8'),
      };
    } finally {
      closeSync(stdout);
      closeSync(stderr);
      rmSync(directory, { recursive: true });
    }
  }
  it('validates all examples and prints service placement', () => {
    const result = runCli(['--examples']);
    expect(result.status, result.stderr).toBe(0);
    for (const profile of profiles)
      expect(result.stdout).toContain(`VALID ${profile}`);
    expect(result.stdout).toContain('applicationDatabase: external');
    expect(result.stdout).toContain('PASS identical application images');
  });
  it('exits with status 1 for a contradictory configuration', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'cc-4-'));
    try {
      const file = resolve(directory, 'invalid.json');
      writeFileSync(
        file,
        JSON.stringify(changed('hybrid', 'artifacts.kind', 'local-volume')),
      );
      const result = runCli([file]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'artifacts.kind: Distributed artifact consumers require a shared filesystem.',
      );
      expect(result.stdout).toBe('');
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
  it.each(['missing-file.json', ''])(
    'fails closed for unreadable input: %s',
    (file) => {
      const result = runCli(file ? [file] : []);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Configuration read failed.');
    },
  );
  it('does not print malformed JSON contents', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'cc-4-'));
    try {
      const file = resolve(directory, 'invalid.json');
      writeFileSync(file, 'synthetic-sensitive-value');
      const result = runCli([file]);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('synthetic-sensitive-value');
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});

describe('Phase 2 authentication configuration', () => {
  it.each(profiles)(
    'requires secure application authentication for %s',
    (profile) => {
      const config = parseDeploymentConfig(fixture(profile));
      config.phase = 2;
      expect(() => parseDeploymentConfig(config)).toThrow('applicationAuth');
      config.services.edge.access = 'application';
      config.applicationAuth = {
        issuer: 'https://identity.example.org',
        clientId: 'campus-commander',
        clientSecretRef:
          profile === 'kubernetes'
            ? {
                provider: 'kubernetes',
                name: 'application-auth',
                key: 'client-secret',
              }
            : { provider: 'file', path: '/run/secrets/oidc-secret' },
        publicOrigin: 'https://campus.example.org',
        sessionLifetimeSeconds: 28800,
        sessionIdleSeconds: 1800,
      };
      expect(parseDeploymentConfig(config).phase).toBe(2);
      config.applicationAuth.issuer = 'http://identity.example.org';
      expect(() => parseDeploymentConfig(config)).toThrow('issuer');
      config.applicationAuth.issuer = 'https://identity.example.org';
      config.applicationAuth.publicOrigin =
        'https://campus.example.org/callback';
      expect(() => parseDeploymentConfig(config)).toThrow('publicOrigin');
      config.applicationAuth.publicOrigin = 'https://campus.example.org';
      config.applicationAuth.sessionLifetimeSeconds = 86401;
      expect(() => parseDeploymentConfig(config)).toThrow(
        'sessionLifetimeSeconds',
      );
    },
  );
});
