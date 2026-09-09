import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { provision, migrate } from '../postgres/index.mjs';

const [image, reportPath] = process.argv.slice(2);
if (!/^.+@sha256:[a-f0-9]{64}$/.test(image ?? '') || !reportPath)
  throw new Error(
    'Usage: capacity-integration.mjs <pinned-api-image> <new-report.json>',
  );
const name = `cc-fault-capacity-${randomUUID()}`;
const root = await mkdtemp(join(tmpdir(), 'cc-capacity-'));
const uid = process.getuid();
const gid = process.getgid();
const password = randomBytes(32).toString('hex');
const adminPassword = randomBytes(32).toString('hex');
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  }).trim();
const postgres = JSON.parse(
  await readFile(
    new URL('../postgres/qualification.json', import.meta.url),
    'utf8',
  ),
);
let admin;
try {
  await writeFile(join(root, 'admin'), adminPassword, { mode: 0o600 });
  await writeFile(join(root, 'runtime'), password, { mode: 0o600 });
  docker('network', 'create', name);
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--network',
    name,
    '--label',
    'campus-commander.test=bounded-capacity',
    '-e',
    'POSTGRES_PASSWORD_FILE=/run/secrets/password',
    '--mount',
    `type=bind,source=${root}/admin,target=/run/secrets/password,readonly`,
    '--tmpfs',
    '/var/lib/postgresql:rw,size=128m',
    '-p',
    '127.0.0.1::5432',
    postgres.image,
  );
  const port = Number(docker('port', name, '5432/tcp').split(':').at(-1));
  const connection = {
    host: '127.0.0.1',
    port,
    password: adminPassword,
    user: 'postgres',
    database: 'postgres',
    connectionTimeoutMillis: 1000,
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    admin = new pg.Client(connection);
    try {
      await admin.connect();
      break;
    } catch {
      await admin.end();
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  await provision(admin, {
    application: {
      database: 'capacity_app',
      role: 'capacity_app',
      password,
      migrationRole: 'capacity_migrator',
      migrationPassword: password,
    },
    kestra: {
      database: 'capacity_kestra',
      role: 'capacity_kestra',
      password: randomBytes(32).toString('hex'),
    },
  });
  const migrator = new pg.Client({
    ...connection,
    database: 'capacity_app',
    user: 'capacity_migrator',
    password,
  });
  await migrator.connect();
  try {
    await migrate(migrator, { runtimeRole: 'capacity_app' });
  } finally {
    await migrator.end();
  }
  const code = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {createHash} from 'node:crypto';
    import pg from 'pg';
    import {createArtifactStore} from '/app/deployment/storage/index.mjs';
    const pool=new pg.Pool({host:process.argv[1],user:'capacity_app',database:'capacity_app',password:fs.readFileSync('/run/secrets/password','utf8')});
    const store=await createArtifactStore({pool,root:'/bounded-artifacts',backend:'local'});
    const bytes=Buffer.from('Durable bounded capacity fixture');
    const manifest=(value)=>({schemaVersion:1,expectedSizeBytes:value.length,expectedSha256:createHash('sha256').update(value).digest('hex')});
    try {
      const ready=await store.stage(manifest(bytes),(async function*(){yield bytes})());
      await store.publish(ready);
      const filler=fs.openSync('/bounded-artifacts/.capacity-filler','wx',0o600);
      let written=0;
      try {for(let i=0;i<256;i++){written+=fs.writeSync(filler,Buffer.alloc(65536))}} catch(error){assert.equal(error.code,'ENOSPC')} finally{fs.closeSync(filler)}
      assert.equal(await store.checkHealth(),false);
      const oversized=Buffer.alloc(65536,42);
      await assert.rejects(store.stage(manifest(oversized),(async function*(){yield oversized})()));
      assert.equal(Number((await pool.query("SELECT count(*) FROM cc.artifacts WHERE publication_state='ready'")).rows[0].count),1);
      fs.unlinkSync('/bounded-artifacts/.capacity-filler');
      assert.equal(await store.checkHealth(),true);
      const chunks=[];for await(const chunk of await store.openRead(ready.artifactId))chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks),bytes);
      process.stdout.write(JSON.stringify({status:'passed',scope:'bounded-artifact-adapter',qualifiesProfile:false,capacityBytes:8388608,filledBytes:written,partialPublished:false,fixtureSha256:ready.sha256}));
    } finally {await store.close();await pool.end()}
  `;
  const output = docker(
    'run',
    '--rm',
    '--network',
    name,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--user',
    `${uid}:${gid}`,
    '--tmpfs',
    `/bounded-artifacts:rw,size=8m,uid=${uid},gid=${gid},mode=0700`,
    '--mount',
    `type=bind,source=${root}/runtime,target=/run/secrets/password,readonly`,
    image,
    'node',
    '--input-type=module',
    '-e',
    code,
    name,
  );
  const result = {
    schemaVersion: 1,
    ...JSON.parse(output),
    image,
    postgresImage: postgres.image,
    recordedAt: new Date().toISOString(),
  };
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(
    'Bounded capacity fault rejected publication and preserved the ready artifact.\n',
  );
} finally {
  await admin?.end().catch(() => undefined);
  try {
    docker('rm', '--force', name);
  } catch {
    /* Preserve unrelated resources. */
  }
  try {
    docker('network', 'rm', name);
  } catch {
    /* Preserve unrelated resources. */
  }
  await rm(root, { recursive: true, force: true });
}
