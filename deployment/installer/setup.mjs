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
  mkdtemp,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

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
    !['install', 'resume', 'status'].includes(options.command)
  )
    fail('Select install, resume, or status.');
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
    let value = Object.hasOwn(answers, key)
      ? answers[key]
      : ask
        ? await ask(
            `${label}${fallback === undefined ? '' : ` [${fallback}]`}: `,
          )
        : fallback;
    if (value === '' || value === undefined) value = fallback;
    if (!validate(value)) fail(`Provide a valid answer for ${key}.`);
    return value;
  };
  question.reserve = (key) => used.add(key);
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
  const temporary = `${path}.${randomUUID()}`;
  try {
    await createPrivate(temporary, bytes);
    await link(temporary, path);
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
  } else await createPrivate(target, bytes);
}

export async function configure({
  releaseRoot,
  root,
  profile,
  qualification = false,
  questions: q,
  manifest,
}) {
  const config = await readJson(
    join(releaseRoot, 'deployment/examples', `${profile}.json`),
  );
  config.images = manifest.images;
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
    value.location = await q(
      `${key}.location`,
      `${key} storage path or managed storage identifier`,
      required ? undefined : join(root, 'data', key.replaceAll('.', '-')),
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
      const source = await q(
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

export async function runSetup(
  options,
  {
    answers = {},
    ask,
    installer,
    validate,
    run = execute,
    output = (line) => process.stdout.write(`${line}\n`),
  } = {},
) {
  const q = createQuestions(answers, ask);
  for (const key of ['profile', 'root']) {
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
  let operator,
    config,
    qualification = Boolean(options.qualification),
    command = options.command;
  if (await exists(operatorPath)) {
    const stat = await lstat(operatorPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
      fail('Use a private regular operator file.');
    operator = await readJson(operatorPath);
    if (
      operator.installationRoot !== root ||
      operator.configurationPath !== join(root, 'deployment.json')
    )
      fail('Use the authoritative installation directory.');
    config = await readJson(operator.configurationPath);
    const setup = await readJson(join(root, 'setup-record.json'));
    qualification = setup.qualification;
    if (
      (options.profile && config.profile !== options.profile) ||
      (options.qualification && !qualification)
    )
      fail('Use the existing installation profile and acceptance mode.');
    command ??= await q(
      'command',
      'Existing installation command (resume/status)',
      'status',
      (v) => ['resume', 'status'].includes(v),
    );
    if (command === 'install') command = 'resume';
    if (config.profile === 'hybrid' && command !== 'status')
      q.reserve('workersReady');
    q.finish();
  } else {
    if (
      command === 'status' ||
      (command === 'resume' &&
        !(await exists(join(root, 'setup-pending.json'))))
    )
      fail('Install this directory before requesting resume or status.');
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
      const pending = await readJson(pendingPath);
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
    if (plan.lab) {
      const cert = join(root, 'private/edge-certificate'),
        key = join(root, 'private/edge-private-key');
      const hostname = new URL(plan.config.services.edge.endpoint.url).hostname;
      if (!/^[a-zA-Z0-9.-]+$/.test(hostname) || isIP(hostname))
        fail('Use a DNS hostname for the lab certificate.');
      await privateDirectory(join(root, 'private'));
      if (!(await exists(cert)) && !(await exists(key))) {
        const temporary = await mkdtemp(join(root, 'private/.certificate-'));
        const temporaryCert = join(temporary, 'certificate'),
          temporaryKey = join(temporary, 'key');
        try {
          await run(
            'openssl',
            [
              'req',
              '-x509',
              '-newkey',
              'rsa:2048',
              '-nodes',
              '-days',
              '30',
              '-subj',
              `/CN=${hostname}`,
              '-addext',
              `subjectAltName=DNS:${hostname}`,
              '-keyout',
              temporaryKey,
              '-out',
              temporaryCert,
            ],
            { timeout: 30000 },
          );
          const { chmod } = await import('node:fs/promises');
          await chmod(temporaryCert, 0o600);
          await chmod(temporaryKey, 0o600);
          await copyPrivate(temporaryCert, cert);
          await copyPrivate(temporaryKey, key);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      } else if (!(await exists(cert)) || !(await exists(key)))
        fail(
          'Preserve the incomplete certificate pair and restore both files before resuming.',
        );
    }
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
  output(
    `Running ${command} for ${config.profile}. Configuration: ${operatorPath}`,
  );
  if (config.profile === 'hybrid' && command !== 'status') {
    const prepared = await installer({
      command: 'prepare',
      operator,
      qualification,
    });
    output(`Worker preparation: ${prepared.status}.`);
    output(
      'Mount the configured shared storage on every declared worker host. Preserve identical paths and permissions.',
    );
    output(
      `Securely copy ${join(root, 'runtime/profile.json')} and ${join(root, 'private')} to the same paths on each worker host.`,
    );
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
  const result = await installer({ command, operator, qualification });
  output(
    `Readiness: ${result.readiness?.status ?? result.status ?? result.state?.phase ?? 'unknown'}. URL: ${config.services.edge.endpoint.url}`,
  );
  output(
    `Bootstrap credential file: ${refPath(join(root, 'private'), config.services.edge.bootstrapSecretRef)}`,
  );
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
      ? await readJson(options.answersPath)
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
      `Setup failed. ${error.code ? `${error.code}: ` : ''}${error instanceof SetupError || error.name === 'InstallerError' ? error.message : 'Check protected configuration and installer-state.json.'}\n`,
    );
    process.exitCode = 1;
  } finally {
    prompt?.close();
  }
}
