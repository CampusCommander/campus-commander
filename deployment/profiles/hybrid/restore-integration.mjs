import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  backupFoundation,
  restoreFoundation,
} from '../../operations/index.mjs';
import { connectionOptions, provision } from '../../postgres/index.mjs';
import { normalizePostgresSecret } from '../../postgres/secrets.mjs';
import { createArtifactStore } from '../../storage/index.mjs';
import { probeRedis } from '../../redis/probe.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
const postgresImage = (
  await json(new URL('../../postgres/qualification.json', import.meta.url))
).image;

async function treeChecksums(root, relative = '') {
  const result = [];
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) result.push(...(await treeChecksums(root, path)));
    else {
      assert.ok(entry.isFile());
      result.push({ path, sha256: hash(await readFile(join(root, path))) });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function operatorPhase(phase, inputPath) {
  const input = await json(inputPath);
  const { sourceConfig, targetConfig, root, sourceRoot, executionId } = input;
  const secret = async (ref) => {
    const name = basename(ref.path);
    return readFile(
      join(
        name.startsWith('restore-')
          ? join(root, 'private')
          : join(sourceRoot, 'private'),
        name,
      ),
    );
  };
  const credentials = (target) => ({
    role: target ? 'restore-migrator' : 'application-installer',
    passwordSecretRef: {
      provider: 'file',
      path: target
        ? '/run/secrets/restore-migrator'
        : '/run/secrets/postgres-migrator',
    },
  });
  const keyRecovery = {
    id: 'synthetic-hybrid-backup-key',
    version: 1,
    reference: { provider: 'file', path: '/run/secrets/restore-backup-key' },
  };
  const executionDigest = async (config) => {
    const client = new pg.Client(
      await connectionOptions(config.services.kestraDatabase, secret),
    );
    await client.connect();
    try {
      const rows = (
        await client.query(
          'SELECT to_jsonb(e) AS value, strip(fulltext)::text AS lexemes, (fulltext_index(namespace) || fulltext_index(flow_id) || fulltext_index(id))::text AS recomputed FROM public.executions e WHERE to_jsonb(e)::text LIKE $1 ORDER BY e.key',
          [`%${executionId}%`],
        )
      ).rows;
      assert.ok(rows.length > 0);
      assert.ok(JSON.stringify(rows).includes('SUCCESS'));
      const generated = (
        await client.query(
          "SELECT is_generated,generation_expression FROM information_schema.columns WHERE table_schema='public' AND table_name='executions' AND column_name='fulltext'",
        )
      ).rows[0];
      assert.equal(generated.is_generated, 'ALWAYS');
      const definition = (
        await client.query(
          "SELECT pg_get_functiondef('public.fulltext_replace(text,text)'::regprocedure) AS definition",
        )
      ).rows[0].definition;
      assert.match(definition, /SELECT DISTINCT/);
      assert.ok(!/ORDER BY/.test(definition));
      return {
        rows: rows.length,
        sha256: hash(JSON.stringify(rows.map((row) => row.value))),
        semanticSha256: hash(
          JSON.stringify(
            rows.map((row) => ({ ...row.value, fulltext: row.lexemes })),
          ),
        ),
        fulltextLexemesSha256: hash(
          JSON.stringify(rows.map((row) => row.lexemes)),
        ),
        recomputedFulltextSha256: hash(
          JSON.stringify(rows.map((row) => row.recomputed)),
        ),
        fulltextSchema: {
          generatedAlways: true,
          expressionSha256: hash(generated.generation_expression),
          functionSha256: hash(definition),
          unorderedDistinct: true,
        },
        columns: Object.fromEntries(
          Object.keys(rows[0].value).map((key) => [
            key,
            hash(JSON.stringify(rows.map((row) => row.value[key]))),
          ]),
        ),
      };
    } finally {
      await client.end();
    }
  };
  if (phase === 'backup') {
    const pool = new pg.Pool(
      await connectionOptions(
        sourceConfig.services.applicationDatabase,
        secret,
      ),
    );
    const store = await createArtifactStore({
      pool,
      root: sourceConfig.artifacts.location,
    });
    let artifact, ledger;
    try {
      const bytes = Buffer.from('CC17 hybrid restore École 学校');
      artifact = await store.stage(
        {
          schemaVersion: 1,
          expectedSizeBytes: bytes.length,
          expectedSha256: hash(bytes),
        },
        [bytes],
      );
      await store.publish(artifact);
      ledger = (
        await pool.query(
          'SELECT id,checksum FROM cc.schema_migrations ORDER BY id',
        )
      ).rows;
    } finally {
      await store.close();
      await pool.end();
    }
    const expected = {
      artifact,
      ledger,
      execution: await executionDigest(sourceConfig),
      kestraFiles: await treeChecksums(
        sourceConfig.services.kestra.internalStorage.location,
      ),
      sharedMarker: hash(
        await readFile(
          join(sourceConfig.artifacts.location, 'hybrid-full-marker'),
        ),
      ),
    };
    assert.ok(expected.kestraFiles.length > 0);
    await writeJson(join(root, 'expected.json'), expected);
    const manifest = await backupFoundation({
      config: sourceConfig,
      release: input.release,
      backupDirectory: join(root, 'backup'),
      sourceRoots: {
        artifacts: sourceConfig.artifacts.location,
        kestraInternal: sourceConfig.services.kestra.internalStorage.location,
      },
      keyRecovery,
      quiesce: {
        operator: 'isolated-hybrid-restore-fixture',
        stoppedAt: new Date().toISOString(),
        stoppedServices: ['api', 'workers', 'kestra'],
      },
      resolveSecret: secret,
      applicationCredentials: credentials(false),
    });
    await writeJson(join(root, 'backup-summary.json'), {
      encryptedFiles: manifest.files.length,
      durationMilliseconds: manifest.durationMilliseconds,
    });
  } else if (phase === 'restore') {
    const admin = new pg.Client(
      await connectionOptions(
        {
          ...targetConfig.services.applicationDatabase,
          database: 'postgres',
          role: 'postgres',
          passwordSecretRef: {
            provider: 'file',
            path: '/run/secrets/restore-admin',
          },
        },
        secret,
      ),
    );
    await admin.connect();
    try {
      await provision(admin, {
        application: {
          database: 'restore-app',
          role: 'restore-app',
          password: normalizePostgresSecret(
            await secret(
              targetConfig.services.applicationDatabase.passwordSecretRef,
            ),
          ),
          migrationRole: 'restore-migrator',
          migrationPassword: normalizePostgresSecret(
            await secret(credentials(true).passwordSecretRef),
          ),
        },
        kestra: {
          database: 'restore-kestra',
          role: 'restore-kestra',
          password: normalizePostgresSecret(
            await secret(
              targetConfig.services.kestraDatabase.passwordSecretRef,
            ),
          ),
        },
      });
    } finally {
      await admin.end();
    }
    const report = await restoreFoundation({
      backupDirectory: join(root, 'backup'),
      targetConfig,
      targetDirectory: join(root, 'restored'),
      keyRecovery,
      resolveSecret: secret,
      applicationCredentials: credentials(true),
    });
    const expected = await json(join(root, 'expected.json'));
    const pool = new pg.Pool(
      await connectionOptions(
        targetConfig.services.applicationDatabase,
        secret,
      ),
    );
    const store = await createArtifactStore({
      pool,
      root: targetConfig.artifacts.location,
    });
    try {
      const digest = createHash('sha256');
      for await (const bytes of await store.openRead(
        expected.artifact.artifactId,
      ))
        digest.update(bytes);
      assert.equal(digest.digest('hex'), expected.artifact.sha256);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT id,checksum FROM cc.schema_migrations ORDER BY id',
          )
        ).rows,
        expected.ledger,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM cc.bootstrap_access WHERE revoked_at IS NULL',
          )
        ).rows[0].count,
        0,
      );
    } finally {
      await store.close();
      await pool.end();
    }
    const restoredExecution = await executionDigest(targetConfig);
    await writeJson(join(root, 'execution-comparison.json'), {
      source: expected.execution,
      target: restoredExecution,
      differingColumns: Object.keys(expected.execution.columns).filter(
        (key) =>
          expected.execution.columns[key] !== restoredExecution.columns[key],
      ),
    });
    assert.equal(restoredExecution.rows, expected.execution.rows);
    assert.equal(
      restoredExecution.semanticSha256,
      expected.execution.semanticSha256,
    );
    assert.equal(
      restoredExecution.fulltextLexemesSha256,
      expected.execution.fulltextLexemesSha256,
    );
    assert.deepEqual(
      restoredExecution.fulltextSchema,
      expected.execution.fulltextSchema,
    );
    for (const column of Object.keys(expected.execution.columns)) {
      if (column !== 'fulltext')
        assert.equal(
          restoredExecution.columns[column],
          expected.execution.columns[column],
        );
    }
    assert.deepEqual(
      await treeChecksums(
        targetConfig.services.kestra.internalStorage.location,
      ),
      expected.kestraFiles,
    );
    assert.equal(
      hash(
        await readFile(
          join(targetConfig.artifacts.location, 'hybrid-full-marker'),
        ),
      ),
      expected.sharedMarker,
    );
    assert.deepEqual(
      await json(join(root, 'restored', 'target-configuration.json')),
      targetConfig,
    );
    assert.match(
      await readFile(join(root, 'restored', 'RESTORE_DISABLED'), 'utf8'),
      /stopped/,
    );
    assert.deepEqual(report.redisRecovery, {
      policy: 'discard-cache',
      releaseRequiresFreshRedis: true,
    });
    await writeJson(join(root, 'verification.json'), {
      status: report.status,
      durationMilliseconds: report.durationMilliseconds,
      artifact: {
        artifactId: expected.artifact.artifactId,
        sha256: expected.artifact.sha256,
      },
      execution: {
        source: expected.execution,
        restored: restoredExecution,
        exactStoredColumns: true,
        exactOtherGeneratedColumns: true,
        fulltextLexemesEqual: true,
      },
      kestraFiles: expected.kestraFiles.length,
      sourceMarkerPreserved: true,
      migrationLedgerPreserved: true,
      configurationPreserved: true,
      bootstrapRevoked: true,
      disabledMarkerPreserved: true,
      nativeTools: Object.fromEntries(
        ['pg_dump', 'pg_restore'].map((tool) => [
          tool,
          execFileSync(tool, ['--version'], { encoding: 'utf8' }).trim(),
        ]),
      ),
    });
  } else if (phase === 'redis') {
    assert.equal(
      (await probeRedis(targetConfig.services.redis, secret)).status,
      'ready',
    );
  } else throw new Error('Invalid isolated operator phase.');
}

async function qualify() {
  if (process.env.CC_HYBRID_RESTORE_SOURCE_RELEASED !== 'yes')
    throw new Error(
      'Obtain the hybrid fixture owner release before stopping its writers.',
    );
  const sourceRoot = resolve(process.env.CC_HYBRID_RESTORE_SOURCE_ROOT ?? '');
  if (!sourceRoot.startsWith('/tmp/cc-hybrid-full-'))
    throw new Error('Use a dedicated retained hybrid fixture.');
  const executionId = process.env.CC_HYBRID_RESTORE_EXECUTION_ID;
  if (!/^[a-zA-Z0-9]+$/.test(executionId ?? ''))
    throw new Error('Provide the successful synthetic execution identity.');
  const prefix = basename(sourceRoot).match(
    /^(cc-hybrid-full-\d+-[a-f0-9]+)-/,
  )?.[1];
  assert.match(prefix, /^cc-hybrid-full-\d+-[a-f0-9]+$/);
  const sourceNetwork = `${prefix}-district`;
  const sourcePg = `${prefix}-district-postgres`;
  const sourceRedis = `${prefix}-district-redis`;
  const name = `cc-hybrid-restore-${randomUUID()}`;
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  const targetNetwork = `${name}-network`,
    targetPg = `${name}-postgres`,
    targetRedis = `${name}-redis`,
    targetVolume = `${name}-data`;
  const docker = (args, options = {}) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    }).trim();
  const sourceProject = (file) =>
    `${prefix}-${file.includes('controller') ? 'controller' : file.includes('worker-1') ? 'worker-1' : 'worker-2'}`;
  const compose = (file, args) =>
    docker([
      'compose',
      '-p',
      sourceProject(file),
      '-f',
      join(sourceRoot, file),
      ...args,
    ]);
  const sourceContainers = [];
  const created = {
    network: false,
    volume: false,
    postgres: false,
    redis: false,
  };
  let stage = 'inputs';
  try {
    const sourceConfig = await json(
      join(sourceRoot, 'runtime', 'profile.json'),
    );
    assert.equal(sourceConfig.profile, 'hybrid');
    for (const key of ['applicationDatabase', 'kestraDatabase', 'redis'])
      assert.equal(sourceConfig.services[key].placement.kind, 'external');
    const release = {
      ...(await json(join(sourceRoot, 'release.json'))),
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    };
    const images = {
      ...sourceConfig.images,
      postgres: postgresImage,
      redis: JSON.parse(docker(['inspect', sourceRedis]))[0].Config.Image,
    };
    const actualPostgres = JSON.parse(docker(['inspect', sourcePg]))[0].Config
      .Image;
    assert.ok(actualPostgres.endsWith(postgresImage.split('@')[1]));
    images.postgres = actualPostgres;
    const sourcePrivate = join(sourceRoot, 'private');
    await mkdir(join(root, 'private'), { mode: 0o700 });
    for (const key of [
      'restore-admin',
      'restore-app',
      'restore-kestra',
      'restore-migrator',
    ])
      await writeFile(
        join(root, 'private', key),
        randomBytes(32).toString('base64url'),
        { mode: 0o600 },
      );
    await writeFile(
      join(root, 'private', 'restore-backup-key'),
      randomBytes(32),
      { mode: 0o600 },
    );
    const targetConfig = structuredClone(sourceConfig);
    for (const [key, role] of [
      ['applicationDatabase', 'restore-app'],
      ['kestraDatabase', 'restore-kestra'],
    ])
      Object.assign(targetConfig.services[key], {
        database: role,
        role,
        passwordSecretRef: { provider: 'file', path: `/run/secrets/${role}` },
      });
    targetConfig.artifacts.location = join(root, 'restored', 'artifacts');
    targetConfig.services.kestra.internalStorage.location = join(
      root,
      'restored',
      'kestra-internal',
    );
    await writeJson(join(root, 'input.json'), {
      sourceRoot,
      root,
      sourceConfig,
      targetConfig,
      release,
      executionId,
    });
    const redisCommand = (network, ...args) =>
      docker(
        [
          'run',
          '--rm',
          '--network',
          network,
          '-e',
          'REDISCLI_AUTH',
          '-v',
          `${join(sourcePrivate, 'district-ca')}:/run/ca:ro`,
          images.redis,
          'redis-cli',
          '--tls',
          '--cacert',
          '/run/ca',
          '-h',
          'district-redis',
          '--raw',
          ...args,
        ],
        { env: { ...process.env, REDISCLI_AUTH: awaitPassword } },
      );
    const awaitPassword = await readFile(
      join(sourcePrivate, 'redis-password'),
      'utf8',
    );
    const sentinel = `cc:restore:${name}`;
    assert.equal(
      redisCommand(sourceNetwork, 'SET', sentinel, 'source-only-cache'),
      'OK',
    );
    assert.equal(
      redisCommand(sourceNetwork, 'GET', sentinel),
      'source-only-cache',
    );
    stage = 'stop-source-writers';
    for (const file of [
      'docker-compose.controller.yml',
      'docker-compose.worker-1.yml',
      'docker-compose.worker-2.yml',
    ]) {
      const containers = compose(file, ['ps', '-a', '-q'])
        .split('\n')
        .filter(Boolean);
      assert.ok(containers.length > 0);
      for (const container of containers) {
        const inspected = JSON.parse(docker(['inspect', container]))[0];
        assert.equal(
          inspected.Config.Labels['com.docker.compose.project'],
          sourceProject(file),
        );
        const service = inspected.Config.Labels['com.docker.compose.service'];
        if (['frontend', 'api', 'workers'].includes(service))
          assert.equal(inspected.Config.Image, images[service]);
        if (service === 'kestra') images.kestra = inspected.Config.Image;
      }
      sourceContainers.push(...containers);
      compose(file, ['stop', '--timeout', '5']);
    }
    const checkStopped = () => {
      for (const container of sourceContainers)
        assert.equal(
          JSON.parse(docker(['inspect', container]))[0].State.Running,
          false,
        );
    };
    checkStopped();
    const runOperator = (phase, network) =>
      docker([
        'run',
        '--rm',
        '--network',
        network,
        '--user',
        '1000:1000',
        '--read-only',
        '--tmpfs',
        '/tmp:uid=1000,gid=1000,mode=0700',
        '-v',
        `${process.execPath}:/opt/cc-node:ro`,
        '-v',
        `${fileURLToPath(new URL('../../../', import.meta.url))}:/workspace:ro`,
        '-v',
        `${root}:${root}`,
        '-v',
        `${sourcePrivate}:${sourcePrivate}:ro`,
        '-v',
        `${join(sourcePrivate, 'district-ca')}:/run/secrets/district-ca:ro`,
        ...(phase === 'backup'
          ? [
              '-v',
              `${sourceConfig.artifacts.location}:${sourceConfig.artifacts.location}`,
              '-v',
              `${sourceConfig.services.kestra.internalStorage.location}:${sourceConfig.services.kestra.internalStorage.location}:ro`,
            ]
          : []),
        '-w',
        '/workspace',
        '--entrypoint',
        '/opt/cc-node',
        postgresImage,
        'deployment/profiles/hybrid/restore-integration.mjs',
        phase,
        join(root, 'input.json'),
      ]);
    stage = 'native-backup';
    runOperator('backup', sourceNetwork);
    docker(['stop', '--time', '5', sourcePg, sourceRedis]);
    sourceContainers.push(sourcePg, sourceRedis);
    checkStopped();
    stage = 'fresh-target';
    docker(['network', 'create', targetNetwork]);
    created.network = true;
    docker(['volume', 'create', targetVolume]);
    created.volume = true;
    docker([
      'run',
      '-d',
      '--name',
      targetPg,
      '--network',
      targetNetwork,
      '--network-alias',
      'district-postgres',
      '-e',
      'POSTGRES_PASSWORD_FILE=/run/admin',
      '-v',
      `${join(root, 'private', 'restore-admin')}:/run/admin:ro`,
      '-v',
      `${targetVolume}:/var/lib/postgresql`,
      '-v',
      `${join(sourcePrivate, 'district-postgres-certificate')}:/input/server.crt:ro`,
      '-v',
      `${join(sourcePrivate, 'district-postgres-private-key')}:/input/server.key:ro`,
      '--tmpfs',
      '/run/postgres-tls:mode=0700',
      '--entrypoint',
      '/bin/sh',
      postgresImage,
      '-ec',
      'cp /input/server.* /run/postgres-tls/; chown -R postgres:postgres /run/postgres-tls; chmod 700 /run/postgres-tls; chmod 600 /run/postgres-tls/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/run/postgres-tls/server.crt -c ssl_key_file=/run/postgres-tls/server.key',
    ]);
    created.postgres = true;
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        docker(['exec', targetPg, 'pg_isready', '-U', 'postgres']);
        started = true;
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    assert.ok(started);
    stage = 'native-restore-with-source-offline';
    runOperator('restore', targetNetwork);
    checkStopped();
    docker([
      'run',
      '-d',
      '--name',
      targetRedis,
      '--network',
      targetNetwork,
      '--network-alias',
      'district-redis',
      '--user',
      '1000:1000',
      '--read-only',
      '--tmpfs',
      '/data:uid=1000,gid=1000,mode=0700',
      '-v',
      `${join(sourceRoot, 'redis.conf')}:/run/redis.conf:ro`,
      '-v',
      `${join(sourcePrivate, 'district-redis-certificate')}:/run/tls/server.crt:ro`,
      '-v',
      `${join(sourcePrivate, 'district-redis-private-key')}:/run/tls/server.key:ro`,
      images.redis,
      'redis-server',
      '/run/redis.conf',
    ]);
    created.redis = true;
    stage = 'fresh-redis';
    assert.equal(redisCommand(targetNetwork, 'GET', sentinel), '');
    assert.equal(
      redisCommand(
        targetNetwork,
        'SET',
        'cc:restore-target-check',
        'fresh-cache',
      ),
      'OK',
    );
    assert.equal(
      redisCommand(targetNetwork, 'GET', 'cc:restore-target-check'),
      'fresh-cache',
    );
    runOperator('redis', targetNetwork);
    checkStopped();
    const verification = await json(join(root, 'verification.json'));
    const result = {
      schemaVersion: 1,
      status: 'passed',
      profile: 'hybrid',
      acceptedRelease: false,
      sourceState: {
        baseGitRevision: release.sourceRevision,
        workingTree: 'uncommitted-candidate',
      },
      images,
      backup: await json(join(root, 'backup-summary.json')),
      verification,
      freshRedis: {
        sourceSentinelAbsent: true,
        authenticatedTargetWriteRead: true,
        persistence: 'new tmpfs',
      },
      sourceOfflineDuringVerification: true,
      targetNetworkIsolated: true,
      targetServicesReleased: false,
      fixtureDirectory: root,
      limits: [
        'One Docker host simulates district dependencies and worker hosts.',
        'Separate temporary paths do not prove independent backup media.',
        'No district shared-filesystem or operator recovery-key custody qualification.',
      ],
    };
    await writeJson(
      process.env.CC_HYBRID_RESTORE_EVIDENCE ?? join(root, 'result.json'),
      result,
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'failed',
        stage,
        fixtureDirectory: root,
        sourceWritersRemainStopped: true,
        operatorDiagnostic: String(error.stderr ?? '')
          .split('\n')
          .find((line) => line.startsWith('{"phase"')),
      }),
    );
    throw new Error(
      'Hybrid restore qualification failed. Inspect protected fixture state.',
    );
  } finally {
    if (created.redis) docker(['rm', '-f', targetRedis]);
    if (created.postgres) docker(['rm', '-f', targetPg]);
    if (created.volume) docker(['volume', 'rm', targetVolume]);
    if (created.network) docker(['network', 'rm', targetNetwork]);
  }
}

if (['backup', 'restore', 'redis'].includes(process.argv[2])) {
  try {
    await operatorPhase(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(
      JSON.stringify({
        phase: process.argv[2],
        errorType: error.name,
        code: error.code,
        frames: error.stack?.split('\n').filter((line) => /^\s+at /.test(line)),
      }),
    );
    process.exitCode = 1;
  }
} else await qualify();
