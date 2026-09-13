#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  link,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { configureApplication } from './application-setup.mjs';
import { withProgress } from './progress.mjs';
import { OnboardingError, parseGoogleClient } from './google-client.mjs';
import { startSetupUpload } from './setup-upload.mjs';
import { enrollAdministrator } from './application-enrollment.mjs';
import { privateTerminalOutput } from './private-output.mjs';
import {
  pendingUpdate,
  updateOperator,
  updateInstallation,
} from './maintenance.mjs';

const profiles = ['all-docker', 'hybrid', 'kubernetes'];
const exceptionNames = [
  'district-dns',
  'time-synchronization',
  'storage-capacity',
  'host-memory',
];
const execute = promisify(execFile);
const absolute = (value) =>
  typeof value === 'string' && resolve(value) === value;
export class SetupError extends Error {}
const fail = (message) => {
  throw new SetupError(message);
};
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function protectedJson(path) {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.size > 4 * 1024 * 1024 ||
    (await realpath(path)) !== path
  )
    fail('Use a private regular setup file without symbolic links.');
  return readJson(path);
}

const exists = async (path) =>
  lstat(path).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
const refPath = (root, ref) =>
  ref.provider === 'file'
    ? join(root, ref.path.split('/').at(-1))
    : join(root, ref.name, ref.key);

export function parseArguments(args) {
  const options = {};
  const names = new Map([
    ['--release-root', 'releaseRoot'],
    ['--answers', 'answersPath'],
    ['--profile', 'profile'],
    ['--root', 'root'],
    ['--command', 'command'],
  ]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--qualification') {
      if (options.qualification) fail('Do not repeat arguments.');
      options.qualification = true;
      continue;
    }
    const name = names.get(flag);
    if (
      !name ||
      options[name] !== undefined ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      fail('Use documented setup arguments without duplicates.');
    options[name] = args[++i];
  }
  if (!absolute(options.releaseRoot))
    fail('Provide an absolute verified release directory with --release-root.');
  for (const key of ['answersPath', 'root'])
    if (options[key] && !absolute(options[key]))
      fail('Use absolute file and installation paths.');
  if (options.profile && !profiles.includes(options.profile))
    fail('Select all-docker, hybrid, or kubernetes.');
  if (
    options.command &&
    !['install', 'resume', 'status', 'update', 'uninstall'].includes(
      options.command,
    )
  )
    fail('Select install, resume, status, update, or uninstall.');
  return options;
}

export function createQuestions(answers = {}, ask) {
  if (!answers || Array.isArray(answers) || typeof answers !== 'object')
    fail('Answers must contain a JSON object.');
  const used = new Set();
  const question = async (
    key,
    label,
    fallback,
    validate = (value) => typeof value === 'string' && value.length > 0,
  ) => {
    used.add(key);
    let retry = false;
    for (;;) {
      let value = Object.hasOwn(answers, key)
        ? answers[key]
        : ask
          ? await ask(
              `${retry ? 'That answer is invalid. Try again.\n' : ''}${label}${fallback === undefined ? '' : ` [${fallback}]`}: `,
            )
          : fallback;
      if (value === '' || value === undefined) value = fallback;
      if (validate(value)) return value;
      if (!ask || Object.hasOwn(answers, key))
        fail(`Provide a valid answer for ${key}.`);
      retry = true;
    }
  };
  question.reserve = (key) => used.add(key);
  question.interactive = Boolean(ask);
  question.hasAnswer = (key) => Object.hasOwn(answers, key);
  question.finish = () => {
    if (Object.keys(answers).some((key) => !used.has(key)))
      fail('Remove unknown or inapplicable answer keys.');
  };
  return question;
}

async function privateDirectory(path) {
  if (!absolute(path)) fail('Use an absolute private directory.');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (await realpath(path)) !== path
  )
    fail('Use a private directory without symbolic links.');
}
async function createPrivate(path, bytes) {
  await privateDirectory(dirname(path));
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function persistJson(path, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (await exists(path)) {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      !(await readFile(path)).equals(bytes)
    )
      fail(
        'Preserve existing configuration. Its contents differ from the pending setup.',
      );
    return;
  }
  await atomicPrivate(path, bytes);
}
async function atomicPrivate(path, bytes) {
  const temporary = `${path}.${randomUUID()}`;
  try {
    await createPrivate(temporary, bytes);
    await link(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
async function copyPrivate(source, target) {
  if (!absolute(source)) fail('Provide an absolute credential file path.');
  const stat = await lstat(source);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.size === 0 ||
    stat.size > 4 * 1024 * 1024 ||
    (await realpath(source)) !== source
  )
    fail(
      'Credential sources must be private regular files without symbolic links.',
    );
  const bytes = await readFile(source);
  if (await exists(target)) {
    const existing = await lstat(target);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.mode & 0o077 ||
      !(await readFile(target)).equals(bytes)
    )
      fail(
        'Preserve existing credentials. The supplied file differs or has unsafe permissions.',
      );
  } else await atomicPrivate(target, bytes);
}

export async function prepareLabCertificate(root, hostname, run = execute) {
  if (!/^[a-zA-Z0-9.-]+$/.test(hostname) || isIP(hostname))
    fail('Use a DNS hostname for the lab certificate.');
  const privateRoot = join(root, 'private');
  const cert = join(privateRoot, 'edge-certificate'),
    key = join(privateRoot, 'edge-private-key');
  await privateDirectory(privateRoot);
  const stage = join(privateRoot, '.setup-certificate');
  if ((await exists(cert)) && (await exists(key))) {
    await copyPrivate(cert, cert);
    await copyPrivate(key, key);
    return;
  }
  if (!(await exists(stage)) && ((await exists(cert)) || (await exists(key))))
    fail('Restore the existing certificate pair before resuming.');
  await privateDirectory(stage);
  const stagedCert = join(stage, 'certificate'),
    stagedKey = join(stage, 'key');
  const readyPath = join(stage, 'ready.json');
  if (!(await exists(readyPath))) {
    if ((await exists(cert)) || (await exists(key)))
      fail('Restore the protected certificate stage before resuming.');
    await rm(stagedCert, { force: true });
    await rm(stagedKey, { force: true });
    await run(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        stagedKey,
        '-days',
        '30',
        '-subj',
        `/CN=${hostname}`,
        '-addext',
        `subjectAltName=DNS:${hostname}`,
        '-out',
        stagedCert,
      ],
      { timeout: 30000 },
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(stagedCert, 0o600);
    await chmod(stagedKey, 0o600);
    await persistJson(readyPath, { hostname });
  } else if ((await protectedJson(readyPath)).hostname !== hostname)
    fail('Use the hostname recorded in the pending certificate stage.');
  await copyPrivate(stagedCert, cert);
  await copyPrivate(stagedKey, key);
  await rm(stage, { recursive: true });
}

export async function verifyClusterSecrets(config, operator, run = execute) {
  const references = new Map();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.provider === 'kubernetes') {
      references.set(`${value.name}/${value.key}`, value);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(config.services);
  visit(config.applicationAuth);
  const secrets = new Map();
  try {
    for (const ref of references.values()) {
      if (!secrets.has(ref.name)) {
        const result = await run(
          'kubectl',
          [
            '--context',
            operator.cluster.context,
            '-n',
            operator.kubernetes.namespace,
            'get',
            'secret',
            ref.name,
            '-o',
            'json',
          ],
          { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
        );
        secrets.set(
          ref.name,
          JSON.parse(typeof result === 'string' ? result : result.stdout),
        );
      }
      const value = secrets.get(ref.name).data?.[ref.key];
      const path = refPath(join(operator.installationRoot, 'private'), ref);
      await copyPrivate(path, path);
      if (
        typeof value !== 'string' ||
        !Buffer.from(value, 'base64').equals(await readFile(path))
      )
        fail(
          'Match every protected credential file to its existing Kubernetes Secret before installation.',
        );
    }
  } catch (error) {
    if (error instanceof SetupError) throw error;
    fail(
      'Verify cluster Secret access and matching protected credential files before installation.',
    );
  }
}

export async function configure({
  releaseRoot,
  root,
  profile,
  qualification = false,
  questions: q,
  manifest,
  importGoogle,
}) {
  const config = await readJson(
    join(releaseRoot, 'deployment/examples', `${profile}.json`),
  );
  config.images = manifest.images;
  config.phase = manifest.phase ?? config.phase;
  const project = await q(
    'project',
    'Installation project or namespace',
    qualification ? 'cc-lab' : 'campus-commander',
    (v) =>
      typeof v === 'string' &&
      /^[a-z0-9][a-z0-9-]{1,62}$/.test(v) &&
      (!qualification || v.startsWith('cc-')),
  );
  const operator = {
    installationRoot: root,
    configurationPath: join(root, 'deployment.json'),
    releasePath: join(releaseRoot, 'release-manifest.json'),
    releaseRoot,
    project,
    restoreDirectories: [],
  };
  const trust = (
    await readJson(
      join(releaseRoot, 'deployment/installer/operator.example.json'),
    )
  ).trust;
  operator.trust = {
    ...trust,
    ...(manifest.phase === 2
      ? {
          identity:
            'https://github.com/CampusCommander/campus-commander/.github/workflows/phase-2-candidate.yml@refs/heads/implementation/phase-2-cc-22',
        }
      : {}),
    bundlePath: join(releaseRoot, 'release-manifest.sigstore.json'),
  };
  const files = new Map();
  const lab =
    qualification &&
    profile === 'all-docker' &&
    (await q(
      'labCertificate',
      'Generate a self-signed lab certificate (yes/no)',
      'no',
      (v) => ['yes', 'no'].includes(v),
    )) === 'yes';
  const url = await q(
    'publicUrl',
    'Public HTTPS URL',
    lab ? 'https://localhost:8443' : undefined,
    (v) => {
      try {
        const u = new URL(v);
        return (
          u.protocol === 'https:' &&
          !u.username &&
          !u.password &&
          u.pathname === '/' &&
          !u.search &&
          !u.hash
        );
      } catch {
        return false;
      }
    },
  );
  config.services.edge.endpoint.url = url;
  if (!lab) {
    const mode = await q(
      'edgeTrust',
      'Public HTTPS certificate trust (system-ca/private-ca)',
      'system-ca',
      (v) => ['system-ca', 'private-ca'].includes(v),
    );
    config.services.edge.endpoint.tls =
      mode === 'private-ca'
        ? {
            mode,
            caSecretRef:
              profile === 'kubernetes'
                ? {
                    provider: 'kubernetes',
                    name: 'campus-installation',
                    key: 'edge-ca',
                  }
                : { provider: 'file', path: '/run/secrets/edge-ca' },
          }
        : { mode };
  }
  if (profile !== 'kubernetes') {
    operator.bindAddress = await q(
      'bindAddress',
      'HTTPS bind IPv4 address',
      '127.0.0.1',
      (v) => isIP(v) === 4,
    );
    operator.connectAddress = await q(
      'connectAddress',
      'Readiness connection IPv4 address',
      operator.bindAddress === '0.0.0.0' ? '127.0.0.1' : operator.bindAddress,
      (v) => isIP(v) === 4,
    );
  }
  if (qualification) {
    const names = await q(
      'exceptions',
      'Lab prerequisite exceptions, comma-separated names, or none',
      'none',
      (v) =>
        typeof v === 'string' &&
        (v === 'none' ||
          v.split(',').every((s) => exceptionNames.includes(s.trim()))),
    );
    operator.preflightExceptions = [];
    for (const name of names === 'none'
      ? []
      : new Set(names.split(',').map((v) => v.trim()))) {
      const reason = await q(
        `exceptions.${name}.reason`,
        `Record the lab reason for ${name}`,
        undefined,
        (v) => typeof v === 'string' && v.length >= 10,
      );
      operator.preflightExceptions.push({ name, reason });
    }
  }
  const storage = async (value, key, required) => {
    if (required)
      value.location = await q(
        `${key}.location`,
        `${key} storage path or managed storage identifier`,
      );
    value.capacityGiB = Number(
      await q(
        `${key}.capacityGiB`,
        `${key} capacity GiB`,
        value.capacityGiB,
        (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0,
      ),
    );
    value.operator = await q(
      `${key}.operator`,
      `${key} responsible operator`,
      'installation-operator',
    );
  };
  if (profile !== 'all-docker') {
    config.host.workerHosts = Number(
      await q(
        'workerHosts',
        'Distinct worker host count',
        2,
        (v) =>
          Number.isSafeInteger(Number(v)) && Number(v) >= 2 && Number(v) <= 100,
      ),
    );
    config.services.workers.placement.replicas = config.host.workerHosts;
    if (profile === 'hybrid') {
      operator.workerBindAddresses = [];
      for (let i = 0; i < config.host.workerHosts; i++)
        operator.workerBindAddresses.push(
          await q(
            `workerBindAddresses.${i}`,
            `Worker host ${i + 1} bind IPv4 address`,
            undefined,
            (v) => isIP(v) === 4 && !['127.0.0.1', '0.0.0.0'].includes(v),
          ),
        );
      if (
        new Set(operator.workerBindAddresses).size !== config.host.workerHosts
      )
        fail('Provide distinct worker bind addresses.');
    }
  }
  if (profile === 'kubernetes') {
    config.services.api.placement.replicas = Number(
      await q(
        'apiReplicas',
        'API replica count',
        2,
        (v) =>
          Number.isSafeInteger(Number(v)) && Number(v) >= 2 && Number(v) <= 100,
      ),
    );
    operator.kubernetes = await readJson(
      join(releaseRoot, 'deployment/kubernetes/operator.example.json'),
    );
    delete operator.kubernetes.release;
    operator.kubernetes.namespace = project;
    operator.kubernetes.workerNodeCount = config.host.workerHosts;
    operator.cluster = {
      context: await q('cluster.context', 'Existing kubectl context'),
      storageClasses: [],
    };
    operator.kubernetes.clusterDomain = await q(
      'kubernetes.clusterDomain',
      'Cluster DNS domain',
      'cluster.local',
    );
    for (const key of Object.keys(operator.kubernetes.storageClasses)) {
      const value = await q(
        `kubernetes.storageClasses.${key}`,
        `${key} existing storage class`,
      );
      operator.kubernetes.storageClasses[key] = value;
      operator.cluster.storageClasses.push(value);
    }
    operator.kubernetes.edgeIngress.sourceRanges = (
      await q(
        'kubernetes.sourceRanges',
        'Allowed ingress source CIDRs, comma-separated',
      )
    )
      .split(',')
      .map((s) => s.trim());
    operator.kubernetes.imagePullSecrets = (
      await q(
        'kubernetes.imagePullSecrets',
        'Existing image pull Secret names, comma-separated, or none',
        'none',
      )
    )
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== 'none');
    operator.kubernetes.migrationRole = await q(
      'migrationRole',
      'Existing application migration role',
      'campus-migrator',
    );
    const refs = async (value, key) => {
      for (const [name, child] of Object.entries(value)) {
        if (name === 'provider') continue;
        if (child && typeof child === 'object')
          await refs(child, `${key}.${name}`);
        else value[name] = await q(`${key}.${name}`, `${key} ${name}`, child);
      }
    };
    for (const key of [
      'migrationPasswordSecretRef',
      'databaseAdmins',
      'kestraRuntime',
      'dns',
    ])
      await refs(operator.kubernetes[key], `kubernetes.${key}`);
  }
  for (const [name, service] of Object.entries(config.services)) {
    if (name !== 'edge' && profile !== 'all-docker') {
      const defaultUrl =
        profile === 'kubernetes'
          ? service.endpoint.url.replaceAll(
              '.campus-commander.svc.cluster.local',
              `.${project}.svc.${operator.kubernetes.clusterDomain}`,
            )
          : undefined;
      service.endpoint.url = await q(
        `services.${name}.url`,
        `${name} endpoint URL without credentials`,
        defaultUrl,
        (v) => {
          try {
            const u = new URL(v);
            return (
              !u.username &&
              !u.password &&
              !u.search &&
              !u.hash &&
              !v.includes('example.org')
            );
          } catch {
            return false;
          }
        },
      );
    }
    if (service.placement.kind === 'external')
      service.placement.operator = await q(
        `services.${name}.operator`,
        `${name} responsible operator`,
      );
    if (service.database) {
      service.database = await q(
        `services.${name}.database`,
        `${name} database name`,
        service.database,
      );
      service.role = await q(
        `services.${name}.role`,
        `${name} application role`,
        service.role,
      );
    }
    if (service.persistence)
      await storage(
        service.persistence,
        `services.${name}.persistence`,
        profile !== 'all-docker',
      );
    if (service.internalStorage)
      await storage(
        service.internalStorage,
        `services.${name}.internalStorage`,
        profile !== 'all-docker',
      );
  }
  await storage(config.artifacts, 'artifacts', profile !== 'all-docker');
  const google = await configureApplication(config, operator, q, {
    importGoogle,
  });
  const generated = new Set([
    '/run/secrets/bootstrap',
    '/run/secrets/worker-dispatch',
    '/run/secrets/kestra-auth',
  ]);
  if (profile === 'all-docker')
    for (const n of ['applicationDatabase', 'kestraDatabase', 'redis'])
      generated.add(config.services[n].passwordSecretRef.path);
  const seen = new Map();
  const visit = async (value, key = '') => {
    if (!value || typeof value !== 'object') return;
    if (value.provider === 'file' || value.provider === 'kubernetes') {
      const identity = JSON.stringify(value);
      if (seen.has(identity)) {
        Object.assign(value, seen.get(identity));
        return;
      }
      if (value.provider === 'kubernetes') {
        value.name = await q(
          `${key}.name`,
          `${key} existing Kubernetes Secret name`,
          value.name,
        );
        value.key = await q(
          `${key}.key`,
          `${key} existing Kubernetes Secret key`,
          value.key,
        );
      }
      seen.set(identity, { ...value });
      const target = refPath(join(root, 'private'), value);
      if (
        value.provider === 'file' &&
        (generated.has(value.path) ||
          (lab &&
            ['edge-certificate', 'edge-private-key'].includes(
              value.path.split('/').at(-1),
            )))
      )
        return;
      const source =
        google && value === config.applicationAuth?.clientSecretRef
          ? google.secretPath
          : await q(
              `files.${value.provider === 'file' ? value.path.split('/').at(-1) : `${value.name}.${value.key}`}`,
              `${key} protected source FILE path${profile === 'kubernetes' ? ' matching the existing cluster Secret' : ''}`,
              undefined,
              absolute,
            );
      if (files.has(target) && files.get(target) !== source)
        fail('Use one source file for each credential reference.');
      files.set(target, source);
      return;
    }
    for (const [name, child] of Object.entries(value))
      await visit(child, key ? `${key}.${name}` : name);
  };
  await visit(config.services, 'services');
  await visit(config.applicationAuth, 'applicationAuth');
  let migration;
  if (profile === 'hybrid') {
    migration = {
      migrationRole: await q(
        'migrationRole',
        'Existing application migration role',
        'application-installer',
      ),
      migrationPasswordSecretRef: {
        provider: 'file',
        path: '/run/secrets/postgres-migrator',
      },
    };
    files.set(
      join(root, 'private/postgres-migrator'),
      await q(
        'files.postgres-migrator',
        'Migration password protected FILE path',
        undefined,
        absolute,
      ),
    );
    operator.migrationCredentials = {
      role: migration.migrationRole,
      passwordSecretRef: migration.migrationPasswordSecretRef,
    };
  }
  return { config, operator, files, lab, migration };
}

export async function importGoogleClient({
  root,
  publicOrigin,
  q,
  output,
  privateOutput = privateTerminalOutput,
  upload = startSetupUpload,
}) {
  const saved = join(root, 'private/google-client.json');
  const secretPath = join(root, 'private/google-client-secret');
  let json;
  if (await exists(saved)) {
    q.reserve?.('applicationAuth.googleImport');
    q.reserve?.('applicationAuth.googleClientFile');
    json = await protectedJson(saved);
    output('Reusing the protected Google client import.');
  } else {
    const method = await q(
      'applicationAuth.googleImport',
      'Google client import (browser/file)',
      q.interactive ? 'browser' : 'file',
      (value) => ['browser', 'file'].includes(value),
    );
    if (method === 'file') {
      const path = await q(
        'applicationAuth.googleClientFile',
        'Downloaded Google Web application JSON file',
        undefined,
        absolute,
      );
      if ((await lstat(path)).size > 65536)
        throw new OnboardingError(
          'Select a Google client JSON file smaller than 64 KiB.',
        );
      json = await protectedJson(path);
    } else {
      const server = await upload({ publicOrigin });
      try {
        output(`Google setup page: ${server.origin}`);
        output(
          `For a remote server, add this SSH forwarding option: -L 127.0.0.1:8765:127.0.0.1:8765`,
        );
        privateOutput(`Private setup pairing code: ${server.pairingCode}`);
        output(
          'Open the setup page on your computer. Pair the browser and upload the Google client JSON.',
        );
        json = JSON.parse(await server.result);
      } finally {
        await server.close();
      }
    }
    parseGoogleClient(JSON.stringify(json), publicOrigin);
    await persistJson(saved, json);
  }
  const client = parseGoogleClient(JSON.stringify(json), publicOrigin);
  if (await exists(secretPath)) {
    await copyPrivate(secretPath, secretPath);
    if ((await readFile(secretPath, 'utf8')) !== client.clientSecret)
      throw new OnboardingError(
        'The saved Google secret differs from the imported client. Preserve the installation and inspect its protected configuration.',
      );
  } else await atomicPrivate(secretPath, Buffer.from(client.clientSecret));
  output(
    `Google project: ${client.projectId}. Client: ${client.clientId}. Callback validated.`,
  );
  return { clientId: client.clientId, secretPath };
}

export async function runSetup(
  options,
  {
    answers = {},
    ask,
    installer,
    validate,
    run = execute,
    output = (line) => process.stdout.write(`${line}\n`),
    privateOutput = privateTerminalOutput,
    upload = startSetupUpload,
    enroll = enrollAdministrator,
  } = {},
) {
  const q = createQuestions(answers, ask);
  for (const key of ['profile', 'root', 'command']) {
    if (options[key] !== undefined && Object.hasOwn(answers, key))
      await q(key, key, options[key], (v) => v === options[key]);
  }
  const root =
    options.root ??
    (await q(
      'root',
      'Private installation directory',
      join(homedir(), '.campus-commander'),
      absolute,
    ));
  await privateDirectory(root);
  const operatorPath = join(root, 'operator.json');
  const updateJournal = await pendingUpdate(root);
  let operator,
    config,
    qualification = Boolean(options.qualification),
    command = options.command;
  if (await exists(operatorPath)) {
    const stat = await lstat(operatorPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
      fail('Use a private regular operator file.');
    operator = await protectedJson(operatorPath);
    if (updateJournal) operator = await updateOperator(root, updateJournal);
    if (
      operator.installationRoot !== root ||
      (!updateJournal &&
        operator.configurationPath !== join(root, 'deployment.json'))
    )
      fail('Use the authoritative installation directory.');
    config = await protectedJson(operator.configurationPath);
    const setup = await protectedJson(join(root, 'setup-record.json'));
    qualification = setup.qualification;
    if (
      (options.profile && config.profile !== options.profile) ||
      (options.qualification && !qualification)
    )
      fail('Use the existing installation profile and acceptance mode.');
    command ??= await q(
      'command',
      'Existing installation command (resume/status/update/uninstall)',
      'status',
      (v) => ['resume', 'status', 'update', 'uninstall'].includes(v),
    );
    if (command === 'install') command = 'resume';
    if (command === 'uninstall') q.reserve('confirmUninstall');
    if (command === 'update' || (updateJournal && command === 'resume')) {
      q.reserve('update.backupDirectory');
      q.reserve('confirmUpdate');
      q.reserve('workersReady');
    }
    if (config.profile === 'hybrid' && command !== 'status')
      q.reserve('workersReady');
    q.finish();
  } else {
    if (
      ['status', 'update', 'uninstall'].includes(command) ||
      (command === 'resume' &&
        !(await exists(join(root, 'setup-pending.json'))))
    )
      fail('Install this directory before requesting a maintenance operation.');
    if (await exists(join(root, 'installer-state.json')))
      fail(
        'Preserve this existing installation. Use its authoritative operator file.',
      );
    let plan;
    const pendingPath = join(root, 'setup-pending.json');
    if (await exists(pendingPath)) {
      const pendingStat = await lstat(pendingPath);
      if (
        !pendingStat.isFile() ||
        pendingStat.isSymbolicLink() ||
        pendingStat.mode & 0o077
      )
        fail('Use a private regular pending setup record.');
      const pending = await protectedJson(pendingPath);
      plan = { ...pending.plan, files: new Map(pending.plan.files) };
      qualification = pending.qualification;
      if (
        plan.operator.installationRoot !== root ||
        plan.operator.configurationPath !== join(root, 'deployment.json') ||
        [...plan.files.keys()].some(
          (path) => !path.startsWith(join(root, 'private') + '/'),
        )
      )
        fail('Preserve the pending setup in its original directory.');
      if (
        (options.profile && options.profile !== plan.config.profile) ||
        (options.qualification && !qualification)
      )
        fail('Use the pending installation profile and acceptance mode.');
      output(
        'Resuming protected setup preparation. Existing credentials remain authoritative.',
      );
    } else {
      const manifest = await readJson(
        join(options.releaseRoot, 'release-manifest.json'),
      );
      if (!qualification) {
        const mode = await q(
          'releaseMode',
          'Release mode (accepted/candidate). Published candidates are for disposable testing',
          'candidate',
          (v) => ['accepted', 'candidate'].includes(v),
        );
        qualification = mode === 'candidate';
      }
      if (qualification)
        await q(
          'candidateAcknowledgement',
          'Type candidate-lab to acknowledge an unaccepted, disposable candidate installation',
          undefined,
          (v) => v === 'candidate-lab',
        );
      const profile =
        options.profile ??
        (await q(
          'profile',
          'Deployment profile (all-docker/hybrid/kubernetes)',
          'all-docker',
          (v) => profiles.includes(v),
        ));
      plan = await configure({
        ...options,
        root,
        profile,
        qualification,
        questions: q,
        manifest,
        importGoogle: (input) =>
          importGoogleClient({ ...input, root, output, privateOutput, upload }),
      });
    }
    const profile = plan.config.profile;
    const manifest = await readJson(plan.operator.releasePath);
    if (profile === 'hybrid') q.reserve('workersReady');
    q.finish();
    if (!validate)
      validate = (await import('../../dist/deployment/lib/deployment.js'))
        .parseDeploymentConfig;
    validate(plan.config);
    if (profile === 'kubernetes')
      (await import('../kubernetes/render.mjs')).renderKubernetes(plan.config, {
        ...plan.operator.kubernetes,
        release: manifest,
      });
    if (profile === 'hybrid')
      (await import('../profiles/hybrid/render.mjs')).renderHybrid(
        plan.config,
        manifest,
      );
    await persistJson(pendingPath, {
      qualification,
      plan: { ...plan, files: [...plan.files] },
    });
    for (const [target, source] of plan.files)
      await copyPrivate(source, target);
    if (plan.lab)
      await prepareLabCertificate(
        root,
        new URL(plan.config.services.edge.endpoint.url).hostname,
        run,
      );
    if (plan.migration)
      await persistJson(join(root, 'runtime/operator.json'), plan.migration);
    await persistJson(plan.operator.configurationPath, plan.config);
    await persistJson(join(root, 'setup-record.json'), {
      schemaVersion: 1,
      qualification,
      candidateAcknowledgement: qualification ? 'candidate-lab' : undefined,
      selfSignedCertificate: plan.lab,
    });
    await persistJson(operatorPath, plan.operator);
    await rm(pendingPath);
    operator = plan.operator;
    config = plan.config;
    command = 'install';
  }
  installer ??= (await import('./orchestrator.mjs')).executeInstaller;
  if (command === 'update' || (updateJournal && command === 'resume')) {
    output('5 / 5  Update application services');
    const result = await updateInstallation({
      root,
      releaseRoot: options.releaseRoot,
      operator,
      config,
      qualification,
      q,
      output,
      installer,
    });
    output(
      `Update status: ${result.status}. URL: ${config.services.edge.endpoint.url}`,
    );
    return { ...result, operatorPath };
  }
  if (command === 'uninstall') {
    output('5 / 5  Remove application services');
    const project =
      config.profile === 'kubernetes'
        ? operator.kubernetes.namespace
        : operator.project;
    output(
      `Uninstall removes application services for ${project}. It preserves application data, credentials, and external resources.`,
    );
    const confirm = await q(
      'confirmUninstall',
      `Type ${project} to uninstall, or cancel`,
      'cancel',
      (value) => [project, 'cancel'].includes(value),
    );
    if (confirm !== project) return { status: 'cancelled', operatorPath };
    const result = await withProgress(
      (onProgress) =>
        installer({ command, operator, qualification, onProgress }),
      output,
      'removing application services',
    );
    output(
      `Uninstall status: ${result.status}. Application data and credentials are preserved.`,
    );
    if (result.remoteWorkerActionRequired)
      output(
        'Uninstall each declared worker fragment on its host. Preserve its shared storage and protected mounts.',
      );
    return { ...result, operatorPath };
  }
  output('5 / 5  Check configuration and start services');
  output(
    `Running ${command} for ${config.profile}. Configuration: ${operatorPath}`,
  );
  if (config.profile === 'hybrid' && command !== 'status') {
    const prepared = await withProgress(
      (onProgress) =>
        installer({ command: 'prepare', operator, qualification, onProgress }),
      output,
      'Preparing worker configuration',
    );
    output(`Worker preparation: ${prepared.status}.`);
    output(
      'Mount the configured shared storage on every declared worker host. Preserve identical paths and permissions.',
    );
    output(
      `Securely copy ${join(root, 'runtime/profile.json')} to the same path on each worker host.`,
    );
    output(
      'Create private directories with mode 700. Copy these worker credential files with mode 600 to identical paths:',
    );
    const worker = config.services.workers,
      database = config.services.applicationDatabase;
    const references = [
      worker.dispatchSecretRef,
      worker.serverTls.certificateSecretRef,
      worker.serverTls.privateKeySecretRef,
      database.passwordSecretRef,
      database.endpoint.tls.caSecretRef,
      worker.endpoint.tls.caSecretRef,
    ].filter(Boolean);
    for (const path of new Set(
      references.map((ref) => refPath(join(root, 'private'), ref)),
    ))
      output(path);

    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    for (let i = 0; i < config.host.workerHosts; i++) {
      const fragment = join(root, `docker-compose.worker-${i + 1}.json`);
      output(
        `Copy ${fragment} to the same path on worker ${i + 1} (${operator.workerBindAddresses[i]}).`,
      );
      output(
        `Worker ${i + 1}: docker compose -f ${quote(fragment)} -p ${quote(`${operator.project}-worker-${i + 1}`)} up -d`,
      );
    }
    output(
      `Resume: node ${quote(join(operator.releaseRoot, 'deployment/installer/setup.mjs'))} --release-root ${quote(operator.releaseRoot)} --root ${quote(root)} --command resume`,
    );
    const workersReady = await q(
      'workersReady',
      'Have all declared workers started with shared storage and credential mounts (yes/no)',
      'no',
      (v) => ['yes', 'no'].includes(v),
    );
    if (workersReady !== 'yes') {
      output(
        'Installation paused with prepared configuration. Start the declared workers, then resume.',
      );
      return { status: 'prepared-workers-pending', operatorPath };
    }
  }
  if (config.profile === 'kubernetes' && command !== 'status')
    await withProgress(
      () => verifyClusterSecrets(config, operator, run),
      output,
      'Checking Kubernetes credentials',
    );
  const result = await withProgress(
    (onProgress) => installer({ command, operator, qualification, onProgress }),
    output,
    command === 'status'
      ? 'Checking installation status'
      : 'Checking configuration and release',
  );
  output(
    `Readiness: ${result.readiness?.status ?? result.status ?? result.state?.phase ?? 'unknown'}. URL: ${config.services.edge.endpoint.url}`,
  );
  if (config.phase === 2) {
    output(
      `OIDC callback URL: ${config.applicationAuth.publicOrigin}/api/auth/callback`,
    );
    if (
      command !== 'status' &&
      (result.readiness?.status ?? result.status) === 'ready'
    )
      await enroll({ config, operator, ask, output, privateOutput });
    else
      output(
        'Resume the installer in a terminal to inspect or complete administrator enrollment.',
      );
    output(
      'Follow deployment/bootstrap/APPLICATION-ACCESS.md for enrollment, recovery, and credential rotation.',
    );
  } else {
    output(
      `Bootstrap credential file: ${refPath(join(root, 'private'), config.services.edge.bootstrapSecretRef)}`,
    );
  }
  if (config.profile === 'hybrid')
    output(
      `Deploy docker-compose.worker-*.json on the declared worker hosts. Preserve shared storage paths and private credential mounts.`,
    );
  if (qualification)
    output(
      'This candidate installation has no release acceptance. The setup record preserves laboratory exceptions.',
    );
  return { ...result, operatorPath };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let prompt;
  try {
    const options = parseArguments(process.argv.slice(2));
    const answers = options.answersPath
      ? await protectedJson(options.answersPath)
      : {};
    if (!options.answersPath && !process.stdin.isTTY)
      fail(
        'Use a terminal for guided questions or provide --answers with a protected answers file.',
      );
    if (!options.answersPath)
      prompt = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
    await runSetup(options, {
      answers,
      ask: prompt ? (label) => prompt.question(label) : undefined,
    });
  } catch (error) {
    process.stderr.write(
      `Setup failed. ${error.code ? `${error.code}: ` : ''}${error instanceof SetupError || error instanceof OnboardingError || error.name === 'InstallerError' ? error.message : 'Check protected configuration and installer-state.json.'}\n`,
    );
    process.exitCode = 1;
  } finally {
    prompt?.close();
  }
}
