import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  backupFoundation,
  postgresToolArguments,
} from '../deployment/operations/index.mjs';
import { installationSecretPath } from '../deployment/installer/secrets.mjs';

/** Stop fixture writers and create the recovery backup required by CLI upgrade. */
export async function backupKubernetesInstallation({
  root,
  project,
  kubeconfig,
  kube,
  config,
  kubernetes,
  release,
  installationRoot,
}) {
  assert.match(project, /^cc-capacity-kube-[a-f0-9]{12}$/);
  assert.ok(root.startsWith(`/tmp/${project}-`));
  assert.equal(kubernetes.namespace, project);
  const writers = ['api', 'workers', 'kestra'];
  for (const name of writers)
    await kube(['scale', `deployment/${name}`, '--replicas=0']);
  const deadline = Date.now() + 180000;
  let remaining;
  do {
    remaining = JSON.parse(
      await kube([
        'get',
        'pods',
        '-l',
        `app.kubernetes.io/name in (${writers.join(',')})`,
        '-o',
        'json',
      ]),
    ).items.length;
    if (!remaining) break;
    await new Promise((done) => setTimeout(done, 250));
  } while (Date.now() < deadline);
  assert.equal(
    remaining,
    0,
    'Stop every writer before creating the upgrade backup.',
  );
  const stoppedAt = new Date().toISOString();
  const args = [
    '--kubeconfig',
    kubeconfig,
    '--context',
    `kind-${project}`,
    '-n',
    project,
  ];
  const forwards = [];
  const forward = async (service) => {
    const child = spawn(
      'kubectl',
      [
        ...args,
        'port-forward',
        `service/${service}`,
        ':5432',
        '--address=127.0.0.1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    forwards.push(child);
    child.stderr.resume();
    return new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Database port forwarding timed out.')),
        30000,
      );
      child.stdout.on('data', (bytes) => {
        const match = String(bytes).match(/Forwarding from 127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          done(Number(match[1]));
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Database port forwarding stopped.'));
      });
    });
  };
  try {
    const backupConfig = structuredClone(config);
    const targets = new Map();
    for (const [key, service] of [
      ['applicationDatabase', 'application-postgres'],
      ['kestraDatabase', 'kestra-postgres'],
    ]) {
      backupConfig.services[key].endpoint.url =
        `postgresql://localhost:${await forward(service)}`;
      targets.set(backupConfig.services[key].database, service);
    }
    const sourceRoots = {
      artifacts: join(root, 'shared', 'campus-artifacts', 'artifacts'),
      kestraInternal: join(root, 'shared', 'kestra-internal', 'kestra'),
    };
    backupConfig.artifacts.location = sourceRoots.artifacts;
    backupConfig.services.kestra.internalStorage.location =
      sourceRoots.kestraInternal;
    const keyRecovery = {
      id: 'phase2-kubernetes-upgrade',
      version: 1,
      reference: { provider: 'file', path: '/run/secrets/upgrade-backup-key' },
    };
    const privateRoot = join(installationRoot, 'private');
    await writeFile(
      installationSecretPath(privateRoot, keyRecovery.reference),
      randomBytes(32),
      { mode: 0o600, flag: 'wx' },
    );
    const resolveSecret = (reference) =>
      readFile(installationSecretPath(privateRoot, reference));
    const runTool = async (tool, { service, output }) => {
      assert.equal(tool, 'pg_dump');
      assert.ok(output);
      assert.ok(targets.has(service.database));
      const child = spawn(
        'kubectl',
        [
          ...args,
          'exec',
          `deployment/${targets.get(service.database)}`,
          '--',
          tool,
          '--username',
          service.role,
          '--dbname',
          service.database,
          ...postgresToolArguments(tool, service),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stderr.resume();
      const completion = new Promise((done, reject) => {
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0
            ? done()
            : reject(new Error('Kubernetes database backup failed.')),
        );
      });
      try {
        await Promise.all([completion, pipeline(child.stdout, output)]);
      } catch (error) {
        child.kill('SIGTERM');
        throw error;
      }
    };
    const backupDirectory = join(installationRoot, 'upgrade-backup');
    const manifest = await backupFoundation({
      config: backupConfig,
      release,
      backupDirectory,
      sourceRoots,
      keyRecovery,
      quiesce: {
        operator: 'synthetic-phase2-kubernetes-upgrade',
        stoppedAt,
        stoppedServices: writers,
      },
      resolveSecret,
      applicationCredentials: {
        role: kubernetes.migrationRole,
        passwordSecretRef: kubernetes.migrationPasswordSecretRef,
      },
      runTool,
    });
    const backupManifestSha256 = createHash('sha256')
      .update(await readFile(join(backupDirectory, 'manifest.json')))
      .digest('hex');
    return {
      backupDirectory,
      keyRecovery,
      backupManifestSha256,
      profile: manifest.profile,
      sourceRevision: release.sourceRevision,
      images: release.images,
      writersStopped: true,
    };
  } finally {
    for (const child of forwards) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const ended = once(child, 'exit');
      child.kill('SIGTERM');
      await ended;
    }
  }
}
