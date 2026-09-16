import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import {
  verifyRelease,
  verifyReleaseEvidence,
  verifyReleaseFiles,
} from '../release/integrity.mjs';
import { renderAllDocker } from '../profiles/all-docker/render.mjs';
import { prepareAllDocker } from '../profiles/all-docker/prepare.mjs';
import { renderHybrid, renderWorkerHost } from '../profiles/hybrid/render.mjs';
import { prepareHybrid } from '../profiles/hybrid/prepare.mjs';
import { renderKubernetes } from '../kubernetes/render.mjs';
import { preflight } from './preflight.mjs';
import { verifyBackup } from '../operations/index.mjs';
import { installationSecretPath, prepareSecrets } from './secrets.mjs';
import { createSupportBundle } from './support.mjs';
import { httpsStartup } from '../qualification/faults.mjs';
import { supportedUpgrade } from './upgrade-policy.mjs';
import { connectDatabase } from '../postgres/index.mjs';
import { normalizePostgresSecret } from '../postgres/secrets.mjs';
import {
  generateBootstrapCredential,
  replaceBootstrap,
} from '../bootstrap/access.mjs';

const commands = new Set([
  'validate',
  'preflight',
  'prepare',
  'install',
  'resume',
  'upgrade',
  'status',
  'stop',
  'uninstall',
  'erase',
  'support',
  'reset-bootstrap',
]);
const qualificationExceptions = new Set([
  'district-dns',
  'time-synchronization',
  'storage-capacity',
  'host-memory',
]);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
const exec = promisify(execFile);
export class InstallerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InstallerError';
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new InstallerError(code, message);
};
export async function runCommand(file, args, { input } = {}) {
  try {
    const execution = exec(file, args, {
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024,
    });
    execution.child.stdin.on('error', () => undefined);
    execution.child.stdin.end(input);
    return (await execution).stdout.trim();
  } catch {
    fail(
      'COMMAND_FAILED',
      'The installation command failed. Inspect service status and prerequisite results before resuming.',
    );
  }
}

async function recoverBootstrap(client, token, expectedGeneration) {
  const current = (
    await client.query(
      'SELECT generation,credential_hash FROM cc.bootstrap_access WHERE id=1',
    )
  ).rows[0];
  if (
    current &&
    BigInt(current.generation) === BigInt(expectedGeneration) + 1n &&
    current.credential_hash === createHash('sha256').update(token).digest('hex')
  )
    return { generation: current.generation };
  return replaceBootstrap(client, token, expectedGeneration);
}

// Reuse installed image modules so recovery also supports existing release images.
const composeBootstrapReset = `
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connectDatabase } from '/app/deployment/postgres/index.mjs';
import { secretPath } from '/app/deployment/redis/runtime.mjs';
import { replaceBootstrap } from '/app/deployment/bootstrap/access.mjs';
const recoverBootstrap = ${recoverBootstrap.toString()};
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { token, expectedGeneration } = JSON.parse(input);
const config = JSON.parse(await readFile('/run/config/profile.json', 'utf8'));
const client = await connectDatabase(config.services.applicationDatabase, ref => readFile(secretPath(ref)));
try {
  const result = await recoverBootstrap(client, token, expectedGeneration);
  process.stdout.write(JSON.stringify(result));
} finally {
  await client.end();
}
`;

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function privateRoot(root) {
  if (resolve(root) !== root)
    fail('DIRECTORY', 'Use an absolute installation directory.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (await realpath(root)) !== root
  )
    fail(
      'DIRECTORY',
      'Use a private installation directory without symbolic links.',
    );
}
async function atomic(path, value) {
  if (await exists(path)) {
    const previous = await protectedJson(path);
    if (canonical(previous) === canonical(value)) return;
  }
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function protectedJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
    fail('INPUT', 'Use a regular configuration file without symbolic links.');
  return JSON.parse(await readFile(path, 'utf8'));
}

export function generatedManifestRecord(filename, value, project) {
  const worker = /^docker-compose\.worker-([1-9][0-9]*)\.json$/.exec(filename);
  let inventory;
  if (filename === 'kubernetes.json') {
    if (
      value.kind !== 'List' ||
      !Array.isArray(value.items) ||
      value.items.some((item) =>
        item.kind === 'Namespace'
          ? item.metadata?.name !== project
          : item.metadata?.namespace !== project,
      )
    )
      fail(
        'MANIFEST_OWNERSHIP',
        'Generated Kubernetes resources must remain inside the owned namespace.',
      );
    inventory = {
      kind: 'kubernetes',
      namespace: project,
      ownedClaims: value.items
        .filter((item) => item.kind === 'PersistentVolumeClaim')
        .map((item) => item.metadata.name)
        .sort(),
    };
  } else if (filename === 'docker-compose.json' || worker) {
    const owner = worker ? `${project}-worker-${worker[1]}` : project;
    if (value.name !== owner)
      fail(
        'MANIFEST_OWNERSHIP',
        'Generated Compose projects must match installation ownership.',
      );
    const ownedVolumes = [];
    for (const [name, volume] of Object.entries(value.volumes ?? {})) {
      if (volume?.external) continue;
      const expected = `${owner}_${name}`;
      if (volume?.name && volume.name !== expected)
        fail(
          'MANIFEST_OWNERSHIP',
          'Installer-owned volumes must use their project-scoped names.',
        );
      ownedVolumes.push(expected);
    }
    inventory = {
      kind: 'compose',
      project: owner,
      ownedVolumes: ownedVolumes.sort(),
    };
  } else fail('MANIFEST_BINDING', 'Generated manifest filename is invalid.');
  return { sha256: hash(canonical(value)), inventory };
}

export async function archiveKubernetesManifest({
  root,
  state,
  project,
  next,
}) {
  const path = join(root, 'kubernetes.json');
  if (!(await exists(path))) return;
  const previous = await protectedJson(path);
  const record = generatedManifestRecord('kubernetes.json', previous, project);
  const matches = (bound) => bound && canonical(bound) === canonical(record);
  if (!matches(state.generatedManifests?.['kubernetes.json'])) {
    if (matches(state.pendingGeneratedManifests?.['kubernetes.json'])) return;
    fail(
      'MANIFEST_BINDING',
      'Only a verified Kubernetes manifest can enter installation history.',
    );
  }
  if (
    record.sha256 ===
    generatedManifestRecord('kubernetes.json', next, project).sha256
  )
    return;
  const filename = `kubernetes-history-${record.sha256}.json`;
  await atomic(join(root, filename), previous);
  state.kubernetesHistory = { ...state.kubernetesHistory, [filename]: record };
}

async function kubernetesHistory({ root, state, project }) {
  const manifests = [];
  for (const [filename, record] of Object.entries(
    state.kubernetesHistory ?? {},
  )) {
    if (!/^kubernetes-history-[a-f0-9]{64}\.json$/.test(filename))
      fail(
        'MANIFEST_BINDING',
        'Archived Kubernetes manifest filename is invalid.',
      );
    const value = await protectedJson(join(root, filename));
    const actual = generatedManifestRecord('kubernetes.json', value, project);
    if (
      canonical(actual) !== canonical(record) ||
      filename !== `kubernetes-history-${actual.sha256}.json`
    )
      fail(
        'MANIFEST_BINDING',
        'An archived Kubernetes manifest changed. Restore its verified content before lifecycle actions.',
      );
    manifests.push(value);
  }
  return manifests;
}

export async function kubernetesLifecycleItems({
  root,
  state,
  project,
  current,
  command,
}) {
  const currentRecord = generatedManifestRecord(
    'kubernetes.json',
    current,
    project,
  );
  if (
    canonical(currentRecord) !==
    canonical(state.generatedManifests?.['kubernetes.json'])
  )
    fail(
      'MANIFEST_BINDING',
      'Resume interrupted Kubernetes rendering before stopping or removing resources.',
    );
  const manifests = [
    current,
    ...(await kubernetesHistory({ root, state, project })),
  ];
  const items = new Map();
  for (const manifest of manifests) {
    generatedManifestRecord('kubernetes.json', manifest, project);
    for (const item of manifest.items) {
      const selected =
        command === 'erase'
          ? item.kind === 'PersistentVolumeClaim'
          : !['Namespace', 'PersistentVolumeClaim', 'Secret'].includes(
              item.kind,
            );
      const key = `${item.apiVersion}/${item.kind}/${item.metadata.name}`;
      if (selected && !items.has(key)) items.set(key, item);
    }
  }
  return [...items.values()];
}

export async function verifyGeneratedManifests({
  root,
  state,
  project,
  allowPending = false,
}) {
  await kubernetesHistory({ root, state, project });
  const committed = state.generatedManifests ?? {},
    pending = allowPending ? (state.pendingGeneratedManifests ?? {}) : {};
  const filenames = new Set([
    ...Object.keys(committed),
    ...Object.keys(pending),
  ]);
  if (!filenames.size) {
    if (state.phase !== 'validated' || state.steps.length)
      fail(
        'MANIFEST_BINDING',
        'Generated manifest inventory is missing. Restore verified installation state.',
      );
    if (
      (await exists(join(root, 'docker-compose.json'))) ||
      (await exists(join(root, 'kubernetes.json')))
    )
      fail(
        'MANIFEST_BINDING',
        'Existing deployment files lack a verified ownership inventory.',
      );
    return;
  }
  for (const filename of filenames) {
    if (
      !/^(?:kubernetes|docker-compose(?:\.worker-[1-9][0-9]*)?)\.json$/.test(
        filename,
      )
    )
      fail('MANIFEST_BINDING', 'Generated manifest filename is invalid.');
    const path = join(root, filename);
    if (!(await exists(path))) {
      if (pending[filename] && !committed[filename]) continue;
      fail(
        'MANIFEST_BINDING',
        'A bound deployment manifest is missing. Restore it before lifecycle actions.',
      );
    }
    const actual = generatedManifestRecord(
      filename,
      await protectedJson(path),
      project,
    );
    if (
      ![committed[filename], pending[filename]].some(
        (record) => record && canonical(record) === canonical(actual),
      )
    )
      fail(
        'MANIFEST_BINDING',
        'A deployment manifest changed. Restore its verified content before lifecycle actions.',
      );
  }
}

export async function authenticateRelease(
  operator,
  { qualification, run = runCommand },
) {
  const bytes = await readFile(operator.releasePath),
    manifest = JSON.parse(bytes);
  if (qualification) {
    if (
      manifest.schemaVersion !== 1 ||
      !/^[a-f0-9]{40}$/.test(manifest.sourceRevision) ||
      JSON.stringify(manifest.architectures) !== '["linux/amd64"]'
    )
      fail(
        'RELEASE',
        'Provide a Linux amd64 candidate inventory with a base Git revision.',
      );
    for (const image of Object.values(manifest.images ?? {}))
      if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image))
        fail(
          'RELEASE',
          'Candidate images require immutable repository digests.',
        );
    for (const name of ['frontend', 'api', 'workers'])
      if (!manifest.images?.[name])
        fail('RELEASE', 'Provide every application image digest.');
    if (manifest.files)
      await verifyReleaseFiles(operator.releaseRoot, manifest);
  } else if (operator.trust?.kind === 'ed25519') {
    await verifyRelease({
      root: operator.releaseRoot,
      manifestBytes: bytes,
      signature: await readFile(operator.trust.signaturePath),
      trustedPublicKey: await readFile(operator.trust.publicKeyPath),
    });
  } else if (operator.trust?.kind === 'cosign') {
    const { identity, issuer, bundlePath } = operator.trust;
    if (
      typeof identity !== 'string' ||
      !identity.startsWith('https://') ||
      typeof issuer !== 'string' ||
      !issuer.startsWith('https://')
    )
      fail(
        'TRUST',
        'Provide an independently trusted signing identity and issuer.',
      );
    await run('cosign', [
      'verify-blob',
      '--bundle',
      bundlePath,
      '--certificate-identity',
      identity,
      '--certificate-oidc-issuer',
      issuer,
      operator.releasePath,
    ]);
    await verifyReleaseEvidence(operator.releaseRoot, manifest);
    await verifyReleaseFiles(operator.releaseRoot, manifest);
    for (const image of Object.values(manifest.images))
      await run('cosign', [
        'verify',
        '--certificate-identity',
        identity,
        '--certificate-oidc-issuer',
        issuer,
        image,
      ]);
  } else
    fail(
      'TRUST',
      'Provide trusted Cosign identity settings or an Ed25519 public key.',
    );
  return {
    manifest,
    releaseHash: hash(bytes),
    acceptedRelease: !qualification,
  };
}

export async function executeInstaller({
  command,
  operator,
  qualification = false,
  dependencies = {},
}) {
  const run = dependencies.run ?? runCommand;
  try {
    if (!commands.has(command))
      fail('COMMAND', 'Select a documented installation command.');
    const config = parseDeploymentConfig(
      await protectedJson(operator.configurationPath),
    );
    const project =
      config.profile === 'kubernetes'
        ? operator.kubernetes?.namespace
        : operator.project;
    if (
      typeof project !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/.test(project)
    )
      fail(
        'OWNERSHIP',
        'Provide an explicit installation project or namespace.',
      );
    if (qualification && !/^cc-[a-z0-9-]+$/.test(project))
      fail(
        'QUALIFICATION',
        'Qualification requires a dedicated disposable cc- project or namespace.',
      );
    if (!qualification && operator.preflightExceptions?.length)
      fail(
        'PREREQUISITES',
        'Accepted installation cannot exempt prerequisite checks.',
      );
    if (
      (operator.preflightExceptions ?? []).some(
        (item) =>
          !qualificationExceptions.has(item.name) ||
          typeof item.reason !== 'string' ||
          item.reason.length < 10,
      )
    )
      fail(
        'PREREQUISITES',
        'Qualification exceptions require a permitted check and a specific fixture reason.',
      );
    const localLifecycle = [
      'status',
      'support',
      'stop',
      'uninstall',
      'erase',
      'reset-bootstrap',
    ].includes(command);
    let release;
    if (localLifecycle) {
      await privateRoot(operator.installationRoot);
      const saved = await protectedJson(
        join(operator.installationRoot, 'installer-state.json'),
      );
      const bytes = await readFile(operator.releasePath);
      if (
        saved.releaseHash !== hash(bytes) ||
        saved.qualification !== qualification ||
        (!qualification && !saved.acceptedRelease)
      )
        fail(
          'STATE_MISMATCH',
          'Lifecycle commands require the previously verified local release and installation state.',
        );
      release = {
        manifest: JSON.parse(bytes),
        releaseHash: hash(bytes),
        acceptedRelease: saved.acceptedRelease,
      };
    } else
      release = await authenticateRelease(operator, { qualification, run });
    if (canonical(config.images) !== canonical(release.manifest.images))
      fail(
        'RELEASE',
        'Configuration images must match the verified release inventory.',
      );
    if (command === 'validate')
      return {
        status: 'valid',
        profile: config.profile,
        acceptedRelease: release.acceptedRelease,
      };
    const root = operator.installationRoot;
    await privateRoot(root);
    for (const marker of [
      join(root, 'RESTORE_DISABLED'),
      ...(operator.restoreDirectories ?? []).map((path) =>
        join(path, 'RESTORE_DISABLED'),
      ),
    ])
      if (
        ['prepare', 'install', 'resume', 'upgrade'].includes(command) &&
        (await exists(marker))
      )
        fail(
          'RESTORE_DISABLED',
          'Complete restore acceptance before running installation commands.',
        );
    const lock = join(root, '.installer-lock');
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      fail(
        'BUSY',
        'Another installer holds the lock. Confirm it stopped before removing a stale lock.',
      );
    }
    try {
      const statePath = join(root, 'installer-state.json');
      let state = (await exists(statePath))
        ? await protectedJson(statePath)
        : undefined;
      const configurationHash = hash(canonical(config));
      const ownershipHash = hash(
        canonical({
          project,
          profile: config.profile,
          cluster: operator.cluster,
          kubernetes: operator.kubernetes,
          qualification,
          preflightExceptions: operator.preflightExceptions,
          restoreDirectories: operator.restoreDirectories,
          bindAddress: operator.bindAddress,
          connectAddress: operator.connectAddress,
          localRegistryHttp: operator.localRegistryHttp,
          workerBindAddresses: operator.workerBindAddresses,
        }),
      );
      if (
        state &&
        (state.ownershipHash !== ownershipHash ||
          state.qualification !== qualification)
      )
        fail(
          'STATE_MISMATCH',
          'Installation ownership changed. Restore the original operator inputs.',
        );
      if (
        state &&
        command !== 'upgrade' &&
        (state.configurationHash !== configurationHash ||
          state.releaseHash !== release.releaseHash)
      )
        fail(
          'STATE_MISMATCH',
          'Resume requires the original configuration and release inventory.',
        );
      if (command === 'upgrade') {
        if (!state || state.phase !== 'ready')
          fail(
            'UPGRADE',
            'Upgrade requires a ready installation and a verified recovery backup.',
          );
        if (
          operator.upgradeFromReleaseHash !== state.releaseHash ||
          !operator.backupManifestSha256 ||
          !/^[a-f0-9]{64}$/.test(operator.backupManifestSha256)
        )
          fail(
            'UPGRADE',
            'Bind upgrade to the current release hash and verified backup manifest checksum.',
          );
        const old = await protectedJson(join(root, 'runtime/profile.json'));
        if (
          !operator.upgradeBackup?.backupDirectory ||
          !operator.upgradeBackup?.keyRecovery
        )
          fail(
            'UPGRADE',
            'Provide the protected recovery backup and key reference before upgrade.',
          );
        const backup = await verifyBackup({
          ...operator.upgradeBackup,
          resolveSecret: (ref) =>
            readFile(installationSecretPath(join(root, 'private'), ref)),
        });
        const backupBytes = await readFile(
          join(operator.upgradeBackup.backupDirectory, 'manifest.json'),
        );
        if (
          hash(backupBytes) !== operator.backupManifestSha256 ||
          backup.profile !== old.profile ||
          canonical(backup.release.images) !== canonical(old.images)
        )
          fail(
            'UPGRADE',
            'Recovery backup differs from the current installation release.',
          );
        if (!supportedUpgrade(old, config))
          fail(
            'UPGRADE',
            'Upgrade must preserve deployment settings except images and Phase 2 authentication.',
          );
        state = {
          ...state,
          previousReleaseHash: state.releaseHash,
          releaseHash: release.releaseHash,
          configurationHash,
          phase: 'prepared',
          steps: [],
          backupManifestSha256: operator.backupManifestSha256,
        };
      }
      if (!state) {
        if (
          [
            'resume',
            'upgrade',
            'status',
            'stop',
            'uninstall',
            'erase',
            'support',
            'reset-bootstrap',
          ].includes(command)
        )
          fail(
            'STATE_MISSING',
            'Initialize this installation before using lifecycle commands.',
          );
        state = {
          schemaVersion: 1,
          project,
          profile: config.profile,
          configurationHash,
          releaseHash: release.releaseHash,
          ownershipHash,
          qualification,
          acceptedRelease: release.acceptedRelease,
          phase: 'validated',
          steps: [],
        };
      }
      const save = async () => {
        state.updatedAt = new Date().toISOString();
        await atomic(statePath, state);
      };
      const secretRoot = join(root, 'private'),
        resolveSecret = (ref) =>
          readFile(installationSecretPath(secretRoot, ref));
      const readiness = () =>
        dependencies.readiness
          ? dependencies.readiness(config, operator)
          : httpsStartup({
              url: config.services.edge.endpoint.url,
              caFile:
                config.services.edge.endpoint.tls.mode === 'private-ca'
                  ? installationSecretPath(
                      secretRoot,
                      config.services.edge.endpoint.tls.caSecretRef,
                    )
                  : qualification
                    ? installationSecretPath(
                        secretRoot,
                        config.services.edge.serverTls.certificateSecretRef,
                      )
                    : undefined,
              bootstrapFile: installationSecretPath(
                secretRoot,
                config.services.edge.bootstrapSecretRef,
              ),
              connectAddress: operator.connectAddress,
            });
      if (
        [
          'prepare',
          'install',
          'resume',
          'upgrade',
          'stop',
          'uninstall',
          'erase',
        ].includes(command)
      )
        await verifyGeneratedManifests({
          root,
          state,
          project,
          allowPending:
            Boolean(state.pendingGeneratedManifests) &&
            (config.profile !== 'kubernetes' ||
              !['stop', 'uninstall', 'erase'].includes(command)),
        });
      const composeFile = join(root, 'docker-compose.json'),
        kubernetesFile = join(root, 'kubernetes.json');
      const compose = (...args) =>
        run('docker', ['compose', '-f', composeFile, '-p', project, ...args]);
      const kube = (...args) => {
        if (!operator.cluster?.context)
          fail('CONTEXT', 'Provide an explicit Kubernetes context.');
        return run('kubectl', ['--context', operator.cluster.context, ...args]);
      };
      if (command === 'status') return { state, readiness: await readiness() };
      if (command === 'support')
        return createSupportBundle({
          directory: operator.supportDirectory,
          config,
          readiness: await readiness(),
        });
      if (command === 'reset-bootstrap') {
        if (!/^[1-9][0-9]*$/.test(String(operator.expectedBootstrapGeneration)))
          fail(
            'BOOTSTRAP',
            'Provide the current bootstrap generation for controlled replacement.',
          );
        if (config.profile === 'all-docker')
          await verifyGeneratedManifests({ root, state, project });
        let client;
        try {
          const path = installationSecretPath(
              secretRoot,
              config.services.edge.bootstrapSecretRef,
            ),
            pending = `${path}.pending`;
          if (!(await exists(pending))) {
            const file = await open(pending, 'wx', 0o600);
            try {
              await file.writeFile(generateBootstrapCredential());
              await file.sync();
            } finally {
              await file.close();
            }
            const directory = await open(dirname(path), 'r');
            try {
              await directory.sync();
            } finally {
              await directory.close();
            }
          }
          const pendingStat = await lstat(pending);
          if (
            !pendingStat.isFile() ||
            pendingStat.isSymbolicLink() ||
            pendingStat.mode & 0o077
          )
            fail(
              'BOOTSTRAP',
              'Inspect the protected pending bootstrap credential before recovery.',
            );
          const token = await readFile(pending, 'utf8');
          let result;
          if (config.profile === 'all-docker') {
            result = JSON.parse(
              await run(
                'docker',
                [
                  'compose',
                  '-f',
                  composeFile,
                  '-p',
                  project,
                  'run',
                  '--rm',
                  '--no-deps',
                  '-T',
                  '--entrypoint',
                  'node',
                  'bootstrap-initialize',
                  '--input-type=module',
                  '-e',
                  composeBootstrapReset,
                ],
                {
                  input: JSON.stringify({
                    token,
                    expectedGeneration: String(
                      operator.expectedBootstrapGeneration,
                    ),
                  }),
                },
              ),
            );
            if (
              String(result.generation) !==
              String(BigInt(operator.expectedBootstrapGeneration) + 1n)
            )
              fail(
                'BOOTSTRAP',
                'The recovery command returned an unexpected bootstrap generation.',
              );
          } else {
            client = await connectDatabase(
              {
                ...config.services.applicationDatabase,
                ...operator.migrationCredentials,
              },
              resolveSecret,
            );
            result = await recoverBootstrap(
              client,
              token,
              operator.expectedBootstrapGeneration,
            );
          }
          await rename(pending, path);
          const directory = await open(dirname(path), 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          return { status: 'replaced', generation: result.generation };
        } finally {
          await client?.end();
        }
      }
      if (['stop', 'uninstall', 'erase'].includes(command)) {
        if (command === 'erase' && operator.confirmErase !== project)
          fail(
            'ERASURE',
            'Explicit erasure requires the exact owned installation project name.',
          );
        if (config.profile === 'kubernetes') {
          if (
            command === 'erase' &&
            !['stopped', 'uninstalled'].includes(state.phase)
          )
            fail(
              'ERASURE',
              'Stop or uninstall Kubernetes workloads before erasing owned claims.',
            );
          const list = await protectedJson(kubernetesFile);
          if (command === 'stop') {
            for (const item of list.items.filter(
              (item) => item.kind === 'Deployment',
            ))
              await kube(
                '-n',
                project,
                'scale',
                'deployment',
                item.metadata.name,
                '--replicas=0',
              );
          } else {
            const items = await kubernetesLifecycleItems({
              root,
              state,
              project,
              current: list,
              command,
            });
            const path = join(root, `kubernetes-${command}.json`);
            await atomic(path, { apiVersion: 'v1', kind: 'List', items });
            await kube('delete', '-f', path, '--ignore-not-found=true');
          }
        } else
          await compose(
            ...(command === 'stop'
              ? ['stop']
              : ['down', ...(command === 'erase' ? ['--volumes'] : [])]),
          );
        state.phase =
          command === 'erase'
            ? 'erased'
            : command === 'stop'
              ? 'stopped'
              : 'uninstalled';
        await save();
        return {
          status: state.phase,
          dataPreserved: command !== 'erase',
          externalResourcesPreserved: true,
          remoteWorkerActionRequired:
            config.profile === 'hybrid' && config.host.workerHosts > 1,
        };
      }
      let ownedHttpsPort = false;
      if (config.profile !== 'kubernetes' && (await exists(composeFile))) {
        const id = await compose('ps', '-q', 'edge');
        if (id) {
          const owner = await run('docker', [
            'inspect',
            '--format',
            '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}',
            id,
          ]);
          ownedHttpsPort = owner === `${project}|edge`;
        }
      }
      const preflightRun = async (file, args) => {
        if (
          qualification &&
          operator.localRegistryHttp === true &&
          file === 'docker' &&
          args[0] === 'manifest' &&
          args[1] === 'inspect'
        ) {
          if (!/^(?:localhost|127\.0\.0\.1):[0-9]+\//.test(args[2]))
            fail(
              'REGISTRY',
              'HTTP fixture registries must use a loopback address.',
            );
          return run(file, [...args.slice(0, 2), '--insecure', args[2]]);
        }
        return run(file, args);
      };
      const prerequisites = await (dependencies.preflight ?? preflight)(
        config,
        {
          installationRoot: root,
          cluster: operator.cluster,
          ownedHttpsPort,
          run: preflightRun,
          resolveSecret,
        },
      );
      const allowed = new Set(
        (operator.preflightExceptions ?? []).map((item) => item.name),
      );
      const failures = prerequisites.checks.filter(
        (item) => item.status !== 'passed' && !allowed.has(item.name),
      );
      state.prerequisites = prerequisites;
      state.qualificationExceptions = operator.preflightExceptions ?? [];
      await save();
      if (command === 'preflight')
        return {
          ...prerequisites,
          status: failures.length
            ? 'failed'
            : qualification
              ? 'qualification-prerequisites'
              : 'passed',
          exceptions: state.qualificationExceptions,
        };
      if (failures.length)
        fail(
          'PREREQUISITES',
          [
            'Complete these prerequisites, then repeat the installer:',
            ...failures.map((item) => `  ${item.name}: ${item.instruction}`),
            'Your installation directory retains configuration and prerequisite results.',
          ].join('\n'),
        );
      if (config.profile === 'all-docker')
        await prepareAllDocker(operator.configurationPath, root);
      else if (
        config.profile === 'hybrid' &&
        config.services.kestra.placement.kind === 'local'
      )
        await prepareHybrid(operator.configurationPath, root);
      else await prepareSecrets(config, secretRoot);
      await mkdir(join(root, 'runtime'), { recursive: true, mode: 0o700 });
      await atomic(join(root, 'runtime/profile.json'), config);
      const generated = new Map();
      if (config.profile === 'kubernetes') {
        const list = renderKubernetes(config, {
          ...operator.kubernetes,
          release: release.manifest,
        });
        const required = new Map();
        const collect = (value) => {
          if (!value || typeof value !== 'object') return;
          if (value.secretKeyRef) {
            const ref = value.secretKeyRef;
            if (!required.has(ref.name)) required.set(ref.name, new Set());
            required.get(ref.name).add(ref.key);
          }
          if (value.secret?.secretName) {
            const ref = value.secret;
            if (!required.has(ref.secretName))
              required.set(ref.secretName, new Set());
            for (const item of ref.items ?? [])
              required.get(ref.secretName).add(item.key);
          }
          for (const child of Object.values(value)) collect(child);
        };
        collect(list);
        for (const [name, keys] of required) {
          const secret = JSON.parse(
            await kube('-n', project, 'get', 'secret', name, '-o', 'json'),
          );
          if ([...keys].some((key) => !secret.data?.[key]))
            fail(
              'SECRETS',
              'Create every required Kubernetes Secret key before installation.',
            );
          for (const database of ['applicationDatabase', 'kestraDatabase']) {
            if (config.services[database].placement.kind !== 'local') continue;
            const ref = operator.kubernetes.databaseAdmins[database];
            if (ref.name !== name) continue;
            const bytes = Buffer.from(secret.data[ref.key], 'base64');
            if (bytes.includes(10) || bytes.includes(13))
              fail(
                'SECRETS',
                'Local PostgreSQL administrator Secrets require exact UTF-8 password bytes without CR or LF.',
              );
            try {
              normalizePostgresSecret(bytes);
            } catch {
              fail(
                'SECRETS',
                'Local PostgreSQL administrator Secrets require non-empty UTF-8 password bytes.',
              );
            }
          }
        }
        generated.set('kubernetes.json', list);
      } else {
        const topology =
          config.profile === 'all-docker'
            ? renderAllDocker(config, release.manifest)
            : renderHybrid(config, release.manifest);
        topology.name = project;
        topology.services.edge.ports = [
          `${operator.bindAddress ?? '0.0.0.0'}:${new URL(config.services.edge.endpoint.url).port || 443}:8443`,
        ];
        generated.set('docker-compose.json', topology);
        if (config.profile === 'hybrid' && config.host.workerHosts > 1) {
          if (
            !Array.isArray(operator.workerBindAddresses) ||
            operator.workerBindAddresses.length !== config.host.workerHosts ||
            new Set(operator.workerBindAddresses).size !==
              config.host.workerHosts
          )
            fail(
              'WORKER_HOSTS',
              'Provide a distinct district bind address for each worker host.',
            );
          for (const [
            hostIndex,
            bindAddress,
          ] of operator.workerBindAddresses.entries()) {
            const worker = renderWorkerHost(config, release.manifest, {
              hostIndex,
              bindAddress,
            });
            worker.name = `${project}-worker-${hostIndex + 1}`;
            generated.set(
              `docker-compose.worker-${hostIndex + 1}.json`,
              worker,
            );
          }
        }
      }
      if (generated.has('kubernetes.json'))
        await archiveKubernetesManifest({
          root,
          state,
          project,
          next: generated.get('kubernetes.json'),
        });
      state.pendingGeneratedManifests = Object.fromEntries(
        [...generated].map(([filename, value]) => [
          filename,
          generatedManifestRecord(filename, value, project),
        ]),
      );
      state.phase = 'rendering';
      await save();
      for (const [filename, value] of generated)
        await atomic(join(root, filename), value);
      state.generatedManifests = state.pendingGeneratedManifests;
      delete state.pendingGeneratedManifests;
      state.phase = 'prepared';
      if (!state.steps.includes('prepared')) state.steps.push('prepared');
      await save();
      if (command === 'prepare')
        return { status: 'prepared', acceptedRelease: state.acceptedRelease };
      if (config.profile === 'kubernetes')
        await kube('apply', '-f', kubernetesFile);
      else
        await compose(
          'up',
          '-d',
          ...(command === 'upgrade' ? ['--force-recreate'] : []),
        );
      state.phase = 'started';
      if (!state.steps.includes('started')) state.steps.push('started');
      await save();
      let ready;
      for (
        let attempt = 0;
        attempt < (dependencies.readinessAttempts ?? 90);
        attempt++
      ) {
        ready = await readiness();
        if (
          ready.status === 'ready' &&
          ready.checks?.length === 8 &&
          ready.checks.every((check) => check.status === 'ready')
        )
          break;
        await new Promise((done) =>
          setTimeout(done, dependencies.pollMilliseconds ?? 1000),
        );
      }
      if (
        ready.status !== 'ready' ||
        ready.checks?.length !== 8 ||
        ready.checks.some((check) => check.status !== 'ready')
      )
        fail(
          'READINESS',
          'Installation started but checks failed. Preserve state and resume after correcting prerequisites.',
        );
      state.phase = 'ready';
      state.steps.push('ready');
      await save();
      return {
        status: 'ready',
        acceptedRelease: state.acceptedRelease,
        readiness: ready,
      };
    } finally {
      await rm(lock, { recursive: true });
    }
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      'INSTALLATION_FAILED',
      'Installation failed. Check configuration, release trust, secret mounts, and protected prerequisite results.',
    );
  }
}
