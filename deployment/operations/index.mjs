import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { PassThrough, Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  parseDeploymentConfig,
  secretReferenceSchema,
} from '../../dist/deployment/lib/deployment.js';
import { connectDatabase, migrate } from '../postgres/index.mjs';
import { secretPath } from '../redis/runtime.mjs';

const databaseIdentity = (service) => {
  const url = new URL(service.endpoint.url);
  return `${url.protocol}//${url.hostname}:${url.port || 5432}/${service.database}`;
};
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const beneath = (path, parent) =>
  path === parent || path.startsWith(`${parent}${sep}`);
const safeRelative = (path) =>
  typeof path === 'string' &&
  path.length < 4096 &&
  !path.startsWith('/') &&
  path
    .split('/')
    .every(
      (part) => part && part !== '.' && part !== '..' && !part.includes('\\'),
    );
const sink = () =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
const secretReferences = (value) => {
  const refs = [];
  if (value && typeof value === 'object') {
    if (value.provider === 'file' || value.provider === 'kubernetes')
      refs.push(secretReferenceSchema.parse(value));
    else
      for (const item of Object.values(value))
        refs.push(...secretReferences(item));
  }
  return [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()];
};
async function checkSecrets(config, keyRecovery, resolveSecret) {
  if (
    !/^[a-zA-Z0-9_-]+$/.test(keyRecovery?.id ?? '') ||
    !Number.isInteger(keyRecovery?.version) ||
    keyRecovery.version < 1
  )
    throw new Error('Recovery key identity is required.');
  secretReferenceSchema.parse(keyRecovery.reference);
  const key = Buffer.from(await resolveSecret(keyRecovery.reference));
  if (key.length !== 32)
    throw new Error(
      'Backup encryption requires a separately protected 32-byte key.',
    );
  for (const reference of secretReferences(config))
    if (!Buffer.from(await resolveSecret(reference)).length)
      throw new Error('Required runtime recovery material is absent.');
  return key;
}
async function regularFile(path) {
  const details = await lstat(path);
  if (!details.isFile() || details.nlink !== 1)
    throw new Error(
      'Backup material must contain regular files without links.',
    );
  return details;
}
async function fileDigest(path) {
  await regularFile(path);
  const digest = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path, {
    flags: constants.O_RDONLY | constants.O_NOFOLLOW,
  })) {
    digest.update(chunk);
    sizeBytes += chunk.length;
  }
  return { sha256: digest.digest('hex'), sizeBytes };
}
async function privateDirectory(path) {
  if (
    resolve(path) !== path ||
    (await realpath(path)) !== path ||
    !(await lstat(path)).isDirectory()
  )
    throw new Error(
      'Use an existing absolute directory without symbolic links.',
    );
}
async function tree(root, prefix) {
  await privateDirectory(root);
  const files = [],
    directories = [prefix];
  async function walk(directory, relative) {
    for (const name of (await readdir(directory)).sort()) {
      const source = join(directory, name),
        path = `${relative}/${name}`,
        details = await lstat(source);
      if (!safeRelative(path) || details.isSymbolicLink())
        throw new Error('Storage trees cannot contain unsafe paths or links.');
      if (details.isDirectory()) {
        directories.push(path);
        await walk(source, path);
      } else {
        await regularFile(source);
        files.push({ path, source, ...(await fileDigest(source)) });
      }
    }
  }
  await walk(root, prefix);
  return { files, directories };
}
async function syncFile(path) {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function encryptFile(source, destination, key, path) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  const digest = createHash('sha256');
  let sizeBytes = 0;
  const tap = new Transform({
    transform(chunk, _encoding, done) {
      digest.update(chunk);
      sizeBytes += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(
    typeof source === 'string'
      ? createReadStream(source, {
          flags: constants.O_RDONLY | constants.O_NOFOLLOW,
        })
      : source,
    tap,
    cipher,
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
  );
  const file = await open(destination, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  return {
    path,
    sha256: digest.digest('hex'),
    sizeBytes,
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    cipherSha256: (await fileDigest(destination)).sha256,
  };
}
async function decryptFile(root, entry, key, destination) {
  if (
    !safeRelative(entry.encryptedPath) ||
    !/^files\/[0-9]{6}\.enc$/.test(entry.encryptedPath) ||
    !safeRelative(entry.path)
  )
    throw new Error('Backup inventory path is invalid.');
  const source = join(root, entry.encryptedPath);
  await regularFile(source);
  if ((await fileDigest(source)).sha256 !== entry.cipherSha256)
    throw new Error('Encrypted backup checksum differs.');
  if (!/^[a-f0-9]{24}$/.test(entry.iv) || !/^[a-f0-9]{32}$/.test(entry.tag))
    throw new Error('Backup encryption metadata is invalid.');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(entry.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
  const digest = createHash('sha256');
  let sizeBytes = 0;
  const tap = new Transform({
    transform(chunk, _encoding, done) {
      digest.update(chunk);
      sizeBytes += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(
    createReadStream(source, {
      flags: constants.O_RDONLY | constants.O_NOFOLLOW,
    }),
    decipher,
    tap,
    destination
      ? createWriteStream(destination, { flags: 'wx', mode: 0o600 })
      : sink(),
  );
  if (sizeBytes !== entry.sizeBytes || digest.digest('hex') !== entry.sha256)
    throw new Error('Restored backup integrity differs.');
  if (destination) {
    const file = await open(destination, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
}

export function postgresToolArguments(tool, service) {
  if (!['pg_dump', 'pg_restore'].includes(tool))
    throw new Error('Invalid PostgreSQL backup command.');
  return tool === 'pg_dump'
    ? ['--format=custom', '--no-owner', '--no-privileges']
    : [
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        '--single-transaction',
        '--dbname',
        service.database,
      ];
}
export async function runPostgresTool(
  tool,
  { service, resolveSecret, input, output },
) {
  const args = postgresToolArguments(tool, service);
  const version = await promisify(execFile)(tool, ['--version']);
  if (!/\(PostgreSQL\) 18\.6(?:\s|$)/.test(version.stdout))
    throw new Error('Backup tools must match PostgreSQL 18.6.');
  const url = new URL(service.endpoint.url);
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: service.database,
    PGUSER: service.role,
    PGPASSWORD: String(await resolveSecret(service.passwordSecretRef)),
    PGCONNECT_TIMEOUT: '5',
    PGSSLMODE:
      service.endpoint.tls.mode === 'disabled' ? 'disable' : 'verify-full',
    PGSSLROOTCERT:
      service.endpoint.tls.mode === 'private-ca'
        ? secretPath(service.endpoint.tls.caSecretRef)
        : '/etc/ssl/certs/ca-certificates.crt',
  };
  const child = spawn(tool, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const completed = new Promise((done, reject) => {
    child.once('error', () =>
      reject(new Error('PostgreSQL backup tooling is unavailable.')),
    );
    child.once('close', (code) =>
      code === 0
        ? done()
        : reject(new Error('PostgreSQL backup command failed.')),
    );
  });
  const streams = [completed];
  if (input) streams.push(pipeline(createReadStream(input), child.stdin));
  else child.stdin.end();
  streams.push(
    pipeline(
      child.stdout,
      output
        ? typeof output === 'string'
          ? createWriteStream(output, { flags: 'wx', mode: 0o600 })
          : output
        : sink(),
    ),
  );
  try {
    await Promise.all(streams);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}
async function tableInventory(client) {
  const result = await client.query(
    "SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' ORDER BY n.nspname,c.relname",
  );
  const tables = [];
  for (const row of result.rows)
    tables.push({
      ...row,
      count: (
        await client.query(
          `SELECT count(*)::text AS count FROM ${quote(row.schema)}.${quote(row.name)}`,
        )
      ).rows[0].count,
    });
  return tables;
}
async function noOtherConnections(client) {
  if (
    (
      await client.query(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
      )
    ).rows[0].count
  )
    throw new Error(
      'Stop every application and Kestra database connection before backup or restore.',
    );
}
async function lockTables(client) {
  await noOtherConnections(client);
  await client.query('BEGIN');
  const tables = await tableInventory(client);
  if (tables.length)
    await client.query(
      `LOCK TABLE ${tables.map((row) => `${quote(row.schema)}.${quote(row.name)}`).join(',')} IN SHARE MODE NOWAIT`,
    );
  return tableInventory(client);
}
function validRelease(config, release) {
  if (
    release?.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(release.sourceRevision) ||
    JSON.stringify(release.architectures) !== '["linux/amd64"]'
  )
    throw new Error('A pinned release inventory is required.');
  for (const name of ['frontend', 'api', 'workers'])
    if (config.images[name] !== release.images?.[name])
      throw new Error('Backup images differ from the release inventory.');
}
async function verifyArtifacts(client, inventory) {
  const rows = (
    await client.query(
      "SELECT id,attempt_id,locator,sha256,size_bytes FROM cc.artifacts WHERE publication_state='ready'",
    )
  ).rows;
  for (const row of rows) {
    if (
      row.locator !== `${row.id}.${row.attempt_id}` ||
      !safeRelative(row.locator) ||
      row.locator.includes('/')
    )
      throw new Error('Artifact locator is invalid.');
    const file = inventory.find(
      (file) => file.path === `artifacts/${row.locator}`,
    );
    if (
      !file ||
      file.sha256 !== row.sha256 ||
      file.sizeBytes !== Number(row.size_bytes)
    )
      throw new Error('A ready artifact is absent or corrupt.');
  }
}

export async function backupFoundation({
  config: input,
  release,
  backupDirectory,
  sourceRoots,
  keyRecovery,
  quiesce,
  resolveSecret,
  applicationCredentials,
  runTool = runPostgresTool,
}) {
  const config = parseDeploymentConfig(input);
  validRelease(config, release);
  const started = Date.now();
  if (
    !quiesce?.operator ||
    !['api', 'workers', 'kestra'].every((name) =>
      quiesce.stoppedServices?.includes(name),
    ) ||
    !Number.isFinite(Date.parse(quiesce.stoppedAt)) ||
    Math.abs(started - Date.parse(quiesce.stoppedAt)) > 300000
  )
    throw new Error(
      'Provide a recent operator record that stops API, workers, and Kestra.',
    );
  const key = await checkSecrets(config, keyRecovery, resolveSecret);
  const destination = resolve(backupDirectory);
  if (destination !== backupDirectory)
    throw new Error('Backup destination must be absolute.');
  await privateDirectory(dirname(destination));
  const primary = [
    sourceRoots.artifacts,
    sourceRoots.kestraInternal,
    config.artifacts.location,
    ...Object.values(config.services)
      .map(
        (service) =>
          service.persistence?.location ?? service.internalStorage?.location,
      )
      .filter(Boolean),
  ];
  if (
    primary.some(
      (path) =>
        beneath(destination, resolve(path)) ||
        beneath(resolve(path), destination),
    )
  )
    throw new Error(
      'Store backups separately from every primary storage tree.',
    );
  const appService = {
    ...config.services.applicationDatabase,
    ...applicationCredentials,
  };
  let application, kestra;
  try {
    application = await connectDatabase(appService, resolveSecret);
    kestra = await connectDatabase(
      config.services.kestraDatabase,
      resolveSecret,
    );
    const applicationTables = await lockTables(application),
      kestraTables = await lockTables(kestra);
    if (
      (
        await application.query(
          'SELECT count(*)::int AS count FROM cc.artifacts WHERE active',
        )
      ).rows[0].count
    )
      throw new Error('Resolve active artifact attempts before backup.');
    const artifactTree = await tree(sourceRoots.artifacts, 'artifacts'),
      kestraTree = await tree(sourceRoots.kestraInternal, 'kestra-internal');
    await verifyArtifacts(application, artifactTree.files);
    await mkdir(destination, { mode: 0o700 });
    await mkdir(join(destination, 'files'), { mode: 0o700 });
    await writeFile(
      join(destination, 'INCOMPLETE'),
      'Backup is incomplete.\n',
      { mode: 0o600, flag: 'wx' },
    );
    const sourceFiles = [...artifactTree.files, ...kestraTree.files];
    for (const [path, value] of [
      ['configuration.json', config],
      ['release.json', release],
    ]) {
      sourceFiles.push({
        path,
        source: Readable.from([Buffer.from(JSON.stringify(value))]),
      });
    }
    const files = [];
    for (const source of sourceFiles) {
      const encryptedPath = `files/${String(files.length).padStart(6, '0')}.enc`;
      files.push({
        ...(await encryptFile(
          source.source,
          join(destination, encryptedPath),
          key,
          source.path,
        )),
        encryptedPath,
      });
    }
    for (const [path, service] of [
      ['application.dump', appService],
      ['kestra.dump', config.services.kestraDatabase],
    ]) {
      const encryptedPath = `files/${String(files.length).padStart(6, '0')}.enc`,
        stream = new PassThrough();
      const encrypted = encryptFile(
        stream,
        join(destination, encryptedPath),
        key,
        path,
      );
      const dumped = runTool('pg_dump', {
        service,
        resolveSecret,
        output: stream,
      }).catch((error) => {
        stream.destroy(error);
        throw error;
      });
      const [entry] = await Promise.all([encrypted, dumped]);
      files.push({ ...entry, encryptedPath });
    }
    const afterArtifacts = await tree(sourceRoots.artifacts, 'artifacts'),
      afterKestra = await tree(sourceRoots.kestraInternal, 'kestra-internal');
    const stable = (files) =>
      files.map(({ path, sha256, sizeBytes }) => ({ path, sha256, sizeBytes }));
    if (
      JSON.stringify(artifactTree.directories) !==
        JSON.stringify(afterArtifacts.directories) ||
      JSON.stringify(kestraTree.directories) !==
        JSON.stringify(afterKestra.directories) ||
      JSON.stringify(stable(artifactTree.files)) !==
        JSON.stringify(stable(afterArtifacts.files)) ||
      JSON.stringify(stable(kestraTree.files)) !==
        JSON.stringify(stable(afterKestra.files))
    )
      throw new Error('Storage changed during backup.');
    if (
      JSON.stringify(applicationTables) !==
        JSON.stringify(await tableInventory(application)) ||
      JSON.stringify(kestraTables) !==
        JSON.stringify(await tableInventory(kestra))
    )
      throw new Error('Database inventory changed during backup.');
    await noOtherConnections(application);
    await noOtherConnections(kestra);
    const body = {
      schemaVersion: 1,
      profile: config.profile,
      createdAt: new Date().toISOString(),
      recoveryPoint: quiesce.stoppedAt,
      durationMilliseconds: Date.now() - started,
      keyRecovery,
      quiesce,
      postgresVersion: '18.6',
      redisRecovery: 'discard-cache',
      release,
      sourceDatabases: {
        application: databaseIdentity(config.services.applicationDatabase),
        kestra: databaseIdentity(config.services.kestraDatabase),
      },
      requiredSecretReferences: secretReferences(config),
      applicationTables,
      kestraTables,
      directories: [...artifactTree.directories, ...kestraTree.directories],
      files,
    };
    const manifest = {
      ...body,
      authentication: createHmac('sha256', key)
        .update(JSON.stringify(body))
        .digest('hex'),
    };
    const { unlink } = await import('node:fs/promises');
    await writeFile(
      join(destination, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    const manifestFile = await open(join(destination, 'manifest.json'), 'r');
    try {
      await manifestFile.sync();
    } finally {
      await manifestFile.close();
    }
    await syncDirectory(join(destination, 'files'));
    await unlink(join(destination, 'INCOMPLETE'));
    await syncDirectory(destination);
    return manifest;
  } finally {
    for (const client of [application, kestra])
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    key.fill(0);
  }
}

export async function verifyBackup({
  backupDirectory,
  keyRecovery,
  resolveSecret,
}) {
  await privateDirectory(backupDirectory);
  await privateDirectory(join(backupDirectory, 'files'));
  try {
    await lstat(join(backupDirectory, 'INCOMPLETE'));
    throw new Error('Backup is incomplete.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await regularFile(join(backupDirectory, 'manifest.json'));
  const manifest = JSON.parse(
    await readFile(join(backupDirectory, 'manifest.json'), 'utf8'),
  );
  const key = await checkSecrets({}, keyRecovery, resolveSecret);
  try {
    const { authentication, ...body } = manifest;
    const expected = createHmac('sha256', key)
      .update(JSON.stringify(body))
      .digest();
    if (
      !/^[a-f0-9]{64}$/.test(authentication ?? '') ||
      !timingSafeEqual(expected, Buffer.from(authentication, 'hex')) ||
      manifest.schemaVersion !== 1 ||
      JSON.stringify(manifest.keyRecovery) !== JSON.stringify(keyRecovery)
    )
      throw new Error('Backup authentication failed.');
    if (
      !Array.isArray(manifest.files) ||
      manifest.files.length < 4 ||
      new Set(manifest.files.map((file) => file.path)).size !==
        manifest.files.length
    )
      throw new Error('Backup component inventory is invalid.');
    for (const required of [
      'configuration.json',
      'release.json',
      'application.dump',
      'kestra.dump',
    ])
      if (!manifest.files.some((file) => file.path === required))
        throw new Error('A required backup component is absent.');
    for (const directory of manifest.directories)
      if (!safeRelative(directory))
        throw new Error('Backup directory inventory is invalid.');
    for (const file of manifest.files)
      await decryptFile(backupDirectory, file, key);
    return manifest;
  } finally {
    key.fill(0);
  }
}

export async function restoreFoundation({
  backupDirectory,
  targetConfig: input,
  targetDirectory,
  keyRecovery,
  resolveSecret,
  applicationCredentials,
  runTool = runPostgresTool,
}) {
  const targetConfig = parseDeploymentConfig(input),
    started = Date.now();
  const manifest = await verifyBackup({
    backupDirectory,
    keyRecovery,
    resolveSecret,
  });
  validRelease(targetConfig, manifest.release);
  if (
    targetConfig.profile !== manifest.profile ||
    targetConfig.artifacts.location !== join(targetDirectory, 'artifacts') ||
    targetConfig.services.kestra.internalStorage.location !==
      join(targetDirectory, 'kestra-internal')
  )
    throw new Error(
      'Restore requires matching profile and new isolated storage locations.',
    );
  if (
    resolve(targetDirectory) !== targetDirectory ||
    beneath(targetDirectory, backupDirectory) ||
    beneath(backupDirectory, targetDirectory)
  )
    throw new Error('Restore target must be separate from backup material.');
  await privateDirectory(dirname(targetDirectory));
  const key = await checkSecrets(targetConfig, keyRecovery, resolveSecret);
  let application, kestra;
  try {
    const appService = {
      ...targetConfig.services.applicationDatabase,
      ...applicationCredentials,
    };
    for (const [key, service] of [
      ['application', appService],
      ['kestra', targetConfig.services.kestraDatabase],
    ])
      if (manifest.sourceDatabases[key] === databaseIdentity(service))
        throw new Error('Restore must not target a source database.');
    application = await connectDatabase(appService, resolveSecret);
    kestra = await connectDatabase(
      targetConfig.services.kestraDatabase,
      resolveSecret,
    );
    for (const client of [application, kestra]) {
      await noOtherConnections(client);
      if ((await tableInventory(client)).length)
        throw new Error('Restore databases must be empty.');
    }
    await mkdir(targetDirectory, { mode: 0o700 });
    await writeFile(
      join(targetDirectory, 'RESTORE_DISABLED'),
      'Keep application, workers, and Kestra stopped until operator acceptance.\n',
      { mode: 0o600, flag: 'wx' },
    );
    await syncFile(join(targetDirectory, 'RESTORE_DISABLED'));
    await syncDirectory(targetDirectory);
    for (const directory of manifest.directories)
      await mkdir(join(targetDirectory, directory), {
        mode: 0o700,
        recursive: true,
      });
    for (const file of manifest.files) {
      const destination = join(targetDirectory, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await decryptFile(backupDirectory, file, key, destination);
    }
    for (const [path, service] of [
      ['application.dump', appService],
      ['kestra.dump', targetConfig.services.kestraDatabase],
    ])
      await runTool('pg_restore', {
        service,
        resolveSecret,
        input: join(targetDirectory, path),
      });
    if (
      JSON.stringify(await tableInventory(application)) !==
        JSON.stringify(manifest.applicationTables) ||
      JSON.stringify(await tableInventory(kestra)) !==
        JSON.stringify(manifest.kestraTables)
    )
      throw new Error('Restored database inventory differs.');
    await migrate(application, {
      runtimeRole: targetConfig.services.applicationDatabase.role,
    });
    const restoredArtifacts = await tree(
      join(targetDirectory, 'artifacts'),
      'artifacts',
    );
    await verifyArtifacts(application, restoredArtifacts.files);
    await application.query(
      'UPDATE cc.bootstrap_access SET revoked_at=clock_timestamp()',
    );
    await writeFile(
      join(targetDirectory, 'target-configuration.json'),
      JSON.stringify(targetConfig, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    const report = {
      schemaVersion: 1,
      status: 'verified-services-disabled',
      profile: targetConfig.profile,
      durationMilliseconds: Date.now() - started,
      redisRecovery: {
        policy: 'discard-cache',
        releaseRequiresFreshRedis: true,
      },
      backupCreatedAt: manifest.createdAt,
      applicationTables: manifest.applicationTables,
      kestraTables: manifest.kestraTables,
      artifactFiles: restoredArtifacts.files.map(
        ({ path, sha256, sizeBytes }) => ({ path, sha256, sizeBytes }),
      ),
    };
    await writeFile(
      join(targetDirectory, 'restore-report.json'),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    await syncFile(join(targetDirectory, 'target-configuration.json'));
    await syncFile(join(targetDirectory, 'restore-report.json'));
    for (const file of ['application.dump', 'kestra.dump'])
      await rm(join(targetDirectory, file));
    for (const directory of [...manifest.directories].reverse())
      await syncDirectory(join(targetDirectory, directory));
    await syncDirectory(targetDirectory);
    return report;
  } finally {
    await application?.end();
    await kestra?.end();
    key.fill(0);
  }
}
