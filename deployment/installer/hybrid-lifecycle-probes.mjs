export async function probeApi(seed = false) {
  const { default: fs } = await import('node:fs/promises');
  const { default: crypto } = await import('node:crypto');
  const { default: assert } = await import('node:assert/strict');
  const { default: pg } = await import('pg');
  const { connectionOptions } = await import(
    '/app/deployment/postgres/index.mjs'
  );
  const { createArtifactStore } = await import(
    '/app/deployment/storage/index.mjs'
  );
  const { secretPath } = await import('/app/deployment/redis/runtime.mjs');
  const config = JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
  const resolveSecret = (ref) => fs.readFile(secretPath(ref));
  const pool = new pg.Pool(
    await connectionOptions(config.services.applicationDatabase, resolveSecret),
  );
  const store = await createArtifactStore({
    pool,
    root: config.artifacts.location,
  });
  const fixturePath = `${config.artifacts.location}/.cc16-lifecycle.json`;
  try {
    if (seed) {
      const bytes = Buffer.from(
        'Hosted installer durability fixture: École 学校',
      );
      const artifact = await store.stage(
        {
          schemaVersion: 1,
          expectedSizeBytes: bytes.length,
          expectedSha256: crypto
            .createHash('sha256')
            .update(bytes)
            .digest('hex'),
        },
        [bytes],
      );
      await store.publish(artifact);
      await fs.writeFile(fixturePath, JSON.stringify(artifact), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    const artifact = JSON.parse(await fs.readFile(fixturePath));
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for await (const chunk of await store.openRead(artifact.artifactId)) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    assert.equal(bytes, artifact.sizeBytes);
    assert.equal(hash.digest('hex'), artifact.sha256);
    const migrations = (
      await pool.query(
        'SELECT id,checksum FROM cc.schema_migrations ORDER BY id',
      )
    ).rows;
    const bootstrap = (
      await pool.query(
        'SELECT id,generation,expires_at,revoked_at FROM cc.bootstrap_access ORDER BY id',
      )
    ).rows;
    assert.equal(migrations.length, 1);
    assert.equal(bootstrap.length, 1);
    return { artifact, migrations, bootstrap };
  } finally {
    await store.close();
    await pool.end();
  }
}

export async function probeKestra(operatorPath, mode) {
  const { default: fs } = await import('node:fs/promises');
  const { default: https } = await import('node:https');
  const { execFileSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const op = JSON.parse(await fs.readFile(operatorPath));
  const c = JSON.parse(await fs.readFile(op.configurationPath));
  const root = op.installationRoot;
  const read = (r) =>
    fs.readFile(root + '/private/' + r.path.split('/').at(-1));
  const auth = JSON.parse(await read(c.services.kestra.authSecretRef));
  const ca = await read(c.services.kestra.endpoint.tls.caSecretRef);
  const id = execFileSync(
    'docker',
    [
      'compose',
      '-f',
      root + '/docker-compose.json',
      '-p',
      op.project,
      'ps',
      '-q',
      'kestra',
    ],
    { encoding: 'utf8' },
  ).trim();
  const address = Object.values(
    JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' }))[0]
      .NetworkSettings.Networks,
  )[0].IPAddress;
  const endpoint = new URL(c.services.kestra.endpoint.url);
  const base = '/api/v1/main/namespaces/campus.validation/files';
  const request = (method, path, body, contentType) =>
    new Promise((done, reject) => {
      const req = https.request(
        {
          hostname: endpoint.hostname,
          port: endpoint.port,
          lookup: (_h, _o, cb) => cb(null, [{ address, family: 4 }]),
          path,
          method,
          ca,
          headers: {
            authorization:
              'Basic ' +
              Buffer.from(auth.username + ':' + auth.password).toString(
                'base64',
              ),
            ...(body
              ? {
                  'content-type': contentType,
                  'content-length': Buffer.byteLength(body),
                }
              : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (x) => chunks.push(x));
          res.on('end', () =>
            done({ status: res.statusCode, body: Buffer.concat(chunks) }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  for (const name of ['api', 'frontend']) {
    const id = execFileSync(
      'docker',
      [
        'compose',
        '-f',
        root + '/docker-compose.json',
        '-p',
        op.project,
        'ps',
        '-q',
        name,
      ],
      { encoding: 'utf8' },
    ).trim();
    const actual = execFileSync(
      'docker',
      ['inspect', '--format', '{{.Config.Image}}', id],
      { encoding: 'utf8' },
    ).trim();
    if (actual !== c.images[name])
      throw Error('Controller image differs from active release.');
  }
  const path = base + '?path=/cc16-lifecycle.txt';
  const expected = Buffer.from('CC16 Kestra durable internal file École 学校');
  if (mode === 'seed') {
    const dir = await request('POST', base + '/directory?path=/');
    if (![200, 201, 204, 409].includes(dir.status))
      throw Error('Kestra directory preparation failed.');
    const boundary = 'cc16fixtureboundary';
    const body = Buffer.concat([
      Buffer.from(
        '--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="fileContent"; filename="cc16-lifecycle.txt"\r\nContent-Type: text/plain\r\n\r\n',
      ),
      expected,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    const upload = await request(
      'POST',
      path,
      body,
      'multipart/form-data; boundary=' + boundary,
    );
    if (upload.status < 200 || upload.status >= 300)
      throw Error('Kestra internal upload failed.');
  }
  const downloaded = await request('GET', path);
  if (downloaded.status !== 200 || !downloaded.body.equals(expected))
    throw Error('Kestra internal file changed.');
  return {
    sha256: createHash('sha256').update(downloaded.body).digest('hex'),
    sizeBytes: downloaded.body.length,
  };
}

export async function probeExternal(operatorPath, mode) {
  const bundle = JSON.parse(
    await (await import('node:fs/promises')).readFile(operatorPath),
  ).releaseRoot;
  const { default: fs } = await import('node:fs/promises');
  const { default: assert } = await import('node:assert/strict');
  const { createHash } = await import('node:crypto');
  const { default: pg } = await import(
    bundle + '/node_modules/pg/lib/index.js'
  );
  const { connectionOptions } = await import(
    bundle + '/deployment/postgres/index.mjs'
  );
  const { installationSecretPath } = await import(
    bundle + '/deployment/installer/secrets.mjs'
  );
  const op = JSON.parse(await fs.readFile(operatorPath));
  const c = JSON.parse(await fs.readFile(op.configurationPath));
  const secret = (r) =>
    fs.readFile(installationSecretPath(op.installationRoot + '/private', r));
  const tree = async (root, path = '') => {
    const result = [];
    for (const e of await fs.readdir(root + '/' + path, {
      withFileTypes: true,
    })) {
      const p = path ? path + '/' + e.name : e.name;
      if (e.isDirectory()) result.push(...(await tree(root, p)));
      else if (e.isFile())
        result.push({
          path: p,
          sha256: createHash('sha256')
            .update(await fs.readFile(root + '/' + p))
            .digest('hex'),
        });
      else throw Error('Unexpected storage entry.');
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  };
  const clients = [];
  try {
    const records = {};
    for (const name of ['applicationDatabase', 'kestraDatabase']) {
      const client = new pg.Client(
        await connectionOptions(c.services[name], secret),
      );
      clients.push(client);
      await client.connect();
      records[name] = (
        await client.query('SELECT current_database() AS name')
      ).rows;
      if (name === 'applicationDatabase') {
        records.artifacts = (
          await client.query(
            "SELECT id,attempt_id,sha256,size_bytes FROM cc.artifacts WHERE publication_state='ready' ORDER BY id",
          )
        ).rows;
        records.migrations = (
          await client.query(
            'SELECT id,checksum FROM cc.schema_migrations ORDER BY id',
          )
        ).rows;
        records.bootstrap = (
          await client.query(
            'SELECT id,generation,expires_at,revoked_at FROM cc.bootstrap_access ORDER BY id',
          )
        ).rows;
      }
    }
    assert.equal(records.artifacts.length, 1);
    records.artifactFiles = await tree(c.artifacts.location);
    records.kestraFiles = await tree(
      c.services.kestra.internalStorage.location,
    );
    assert.ok(records.kestraFiles.length > 0);
    const path = op.installationRoot + '/external-before-erase.json';
    if (mode === 'seed')
      await fs.writeFile(path, JSON.stringify(records), { mode: 0o600 });
    else
      assert.deepEqual(
        JSON.parse(JSON.stringify(records)),
        JSON.parse(await fs.readFile(path)),
      );
    return {
      preserved: true,
      baselineSha256: createHash('sha256')
        .update(JSON.stringify(JSON.parse(await fs.readFile(path))))
        .digest('hex'),
      recoveredSha256: createHash('sha256')
        .update(JSON.stringify(records))
        .digest('hex'),
      artifactFileCount: records.artifactFiles.length,
      kestraFileCount: records.kestraFiles.length,
    };
  } finally {
    for (const c of clients) await c.end();
  }
}

export async function createBackup(operatorPath) {
  const bundle = JSON.parse(
    await (await import('node:fs/promises')).readFile(operatorPath),
  ).releaseRoot;
  const { default: fs } = await import('node:fs/promises');
  const { createReadStream } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const { pipeline } = await import('node:stream/promises');
  const { Writable } = await import('node:stream');
  const { randomBytes, createHash } = await import('node:crypto');
  const { backupFoundation, verifyBackup, postgresToolArguments } =
    await import(bundle + '/deployment/operations/index.mjs');
  const { installationSecretPath } = await import(
    bundle + '/deployment/installer/secrets.mjs'
  );
  const { normalizePostgresSecret } = await import(
    bundle + '/deployment/postgres/secrets.mjs'
  );
  const op = JSON.parse(await fs.readFile(operatorPath));
  const root = op.installationRoot;
  const config = JSON.parse(await fs.readFile(op.configurationPath));
  const release = JSON.parse(await fs.readFile(op.releasePath));
  const resolveSecret = (r) =>
    fs.readFile(installationSecretPath(root + '/private', r));
  const keyRecovery = {
    id: 'cc16-hybrid-backup',
    version: 1,
    reference: { provider: 'file', path: '/run/secrets/backup-key' },
  };
  await fs.writeFile(root + '/private/backup-key', randomBytes(32), {
    flag: 'wx',
    mode: 0o600,
  });
  const backupDirectory = root + '/upgrade-backup';
  const runTool = async (tool, { service, input, output }) => {
    const u = new URL(service.endpoint.url);
    const child = spawn(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'host',
        '-e',
        'PGPASSWORD',
        '-e',
        `PGUSER=${service.role}`,
        '-e',
        `PGDATABASE=${service.database}`,
        '-e',
        `PGHOST=${u.hostname}`,
        '-e',
        `PGPORT=${u.port || 5432}`,
        '-e',
        'PGSSLMODE=verify-full',
        '-e',
        `PGSSLROOTCERT=${service.endpoint.tls.caSecretRef.path}`,
        '-v',
        `${root}/private:/run/secrets:ro`,
        'postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280',
        tool,
        ...postgresToolArguments(tool, service),
      ],
      {
        env: {
          ...process.env,
          PGPASSWORD: normalizePostgresSecret(
            await resolveSecret(service.passwordSecretRef),
          ),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stderr.resume();
    const done = new Promise((r, j) => {
      child.on('error', j);
      child.on('close', (c) =>
        c === 0 ? r() : j(Error('PostgreSQL backup tool failed.')),
      );
    });
    const tasks = [
      done,
      pipeline(
        child.stdout,
        output ??
          new Writable({
            write(_b, _e, cb) {
              cb();
            },
          }),
      ),
    ];
    if (input) tasks.push(pipeline(createReadStream(input), child.stdin));
    else child.stdin.end();
    await Promise.all(tasks);
  };
  await backupFoundation({
    config,
    release,
    backupDirectory,
    keyRecovery,
    resolveSecret,
    sourceRoots: {
      artifacts: config.artifacts.location,
      kestraInternal: config.services.kestra.internalStorage.location,
    },
    quiesce: {
      operator: 'cc16-hybrid-fixture',
      stoppedAt: new Date().toISOString(),
      stoppedServices: ['api', 'workers', 'kestra'],
    },
    applicationCredentials: op.migrationCredentials,
    runTool,
  });
  await verifyBackup({ backupDirectory, keyRecovery, resolveSecret });
  return {
    status: 'verified',
    manifestSha256: createHash('sha256')
      .update(await fs.readFile(backupDirectory + '/manifest.json'))
      .digest('hex'),
    upgradeBackup: { backupDirectory, keyRecovery },
  };
}
