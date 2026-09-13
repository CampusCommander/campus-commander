import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function checksums(root, relative = '') {
  const result = [];
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) result.push(...(await checksums(root, path)));
    else {
      assert.ok(entry.isFile());
      result.push({
        path,
        sha256: createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

/** Verify the distributed CLI upgrade with a real encrypted recovery backup. */
export async function upgradeDistributedHybrid({
  hosts,
  controller,
  workers,
  compose,
  cli,
  transfer,
  config,
  configPath,
  releasePath,
  operator,
  operatorPath,
  databaseOperator,
  target,
  baseline,
  auth,
  json,
}) {
  const started = Date.now();
  const root = controller.root;
  const verifyImages = async (images) => {
    const records = [];
    for (const [host, services] of [
      [controller, ['api', 'frontend']],
      ...workers.map((host) => [host, ['workers']]),
    ]) {
      for (const service of services) {
        const ids = (await compose(host, ['ps', '--quiet', service]))
          .split('\n')
          .filter(Boolean);
        assert.equal(ids.length, service === 'api' ? 2 : 1);
        const expected = JSON.parse(
          await hosts.run(host, [
            'docker',
            'image',
            'inspect',
            images[service],
          ]),
        )[0].Id;
        for (const id of ids) {
          const actual = JSON.parse(
            await hosts.run(host, ['docker', 'inspect', id]),
          )[0];
          assert.equal(actual.Image, expected);
          records.push({
            host: host.daemonId,
            service,
            container: id,
            image: images[service],
            imageId: actual.Image,
          });
        }
      }
    }
    return records;
  };
  const beforeImages = await verifyImages(baseline.images);
  const probe = async (script) => {
    const id = (await compose(controller, ['ps', '--quiet', 'api'])).split(
      '\n',
    )[0];
    return JSON.parse(
      await hosts.run(
        controller,
        ['docker', 'exec', '-i', id, 'node', '--input-type=module'],
        { input: script },
      ),
    );
  };
  const common = `import fs from 'node:fs/promises';import crypto from 'node:crypto';import https from 'node:https';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const secret=r=>fs.readFile(secretPath(r));
const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,secret));
const store=await createArtifactStore({pool,root:c.artifacts.location});
const auth=JSON.parse(await secret(c.services.kestra.authSecretRef));
const ca=await secret(c.services.kestra.endpoint.tls.caSecretRef);
const request=(method,path,body,contentType)=>new Promise((resolve,reject)=>{
const r=https.request(new URL(path,c.services.kestra.endpoint.url),{method,ca,headers:{authorization:'Basic '+Buffer.from(auth.username+':'+auth.password).toString('base64'),...(contentType?{'content-type':contentType}:{}),...(body?{'content-length':Buffer.byteLength(body)}:{})}},response=>{const chunks=[];response.on('data',b=>chunks.push(b));response.on('end',()=>{const text=Buffer.concat(chunks).toString();if(response.statusCode<200||response.statusCode>=300)return reject(Error('Synthetic Kestra request failed: '+response.statusCode));try{resolve(JSON.parse(text))}catch{resolve(text)}})});r.on('error',reject);r.setTimeout(5000,()=>r.destroy(Error('Synthetic Kestra request timed out.')));r.end(body);
});`;
  const flow = await readFile(
    new URL('../deployment/kestra/cc11-external-worker.yaml', import.meta.url),
    'utf8',
  );
  const internalMarker = 'Phase 1 hybrid internal storage École 学校';
  const internalPath =
    '/api/v1/main/namespaces/campus.validation/files?path=/phase2-upgrade.txt';
  const seeded = await probe(
    common +
      `
const bytes=Buffer.from('Phase 1 distributed hybrid upgrade École 学校');
const artifact=await store.stage({schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes]);
await store.publish(artifact);await store.close();await pool.end();
await request('POST','/api/v1/main/flows',${JSON.stringify(flow)},'application/x-yaml');
const boundary='cc-'+crypto.randomUUID();const fields={correlationId:crypto.randomUUID(),marker:'phase1-hybrid-upgrade',delayMilliseconds:'0'};
const body=Object.entries(fields).map(([key,value])=>'--'+boundary+'\\r\\nContent-Disposition: form-data; name="'+key+'"\\r\\n\\r\\n'+value+'\\r\\n').join('')+'--'+boundary+'--\\r\\n';
const execution=await request('POST','/api/v1/main/executions/campus.validation/cc11_external_worker',body,'multipart/form-data; boundary='+boundary);
let result;for(let index=0;index<50;index++){result=await request('GET','/api/v1/main/executions/'+execution.id);if(['SUCCESS','FAILED','KILLED','CANCELLED'].includes(result.state.current))break;await new Promise(done=>setTimeout(done,1000));}
if(result.state.current!=='SUCCESS')throw Error('The baseline worker execution did not pass.');
const upload='--'+boundary+'\\r\\nContent-Disposition: form-data; name="fileContent"; filename="phase2-upgrade.txt"\\r\\nContent-Type: text/plain\\r\\n\\r\\n'+${JSON.stringify(internalMarker)}+'\\r\\n--'+boundary+'--\\r\\n';
await request('POST',${JSON.stringify(internalPath)},upload,'multipart/form-data; boundary='+boundary);
process.stdout.write(JSON.stringify({artifact,executionId:execution.id}));`,
  );
  const inspectState = () =>
    probe(
      common +
        `
const id=${JSON.stringify(seeded.artifact.artifactId)},hash=crypto.createHash('sha256');
for await(const bytes of await store.openRead(id))hash.update(bytes);
const metadata=(await pool.query('SELECT to_jsonb(a) AS value FROM cc.artifacts a WHERE id=$1',[id])).rows;
const ledger=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const authTable=(await pool.query("SELECT to_regclass('cc.application_principals')::text AS name")).rows[0].name;
await store.close();await pool.end();const execution=await request('GET','/api/v1/main/executions/'+${JSON.stringify(seeded.executionId)});
const internal=await request('GET',${JSON.stringify(internalPath)});
process.stdout.write(JSON.stringify({metadata,ledger,authTable,sha256:hash.digest('hex'),execution,internal}));`,
    );
  const before = await inspectState();
  assert.equal(before.authTable, null);
  assert.deepEqual(
    before.ledger.map((row) => row.id),
    ['001-foundation'],
  );
  assert.equal(before.internal, internalMarker);
  const internalBefore = await checksums(
    config.services.kestra.internalStorage.location,
  );
  assert.ok(internalBefore.length > 0);
  await compose(controller, ['stop', 'api', 'kestra']);
  for (const worker of workers) await compose(worker, ['stop', 'workers']);
  const backupOperator = join(root, 'qualification-backup-operator.json');
  await json(backupOperator, {
    ...operator,
    migrationCredentials: {
      role: databaseOperator.migrationRole,
      passwordSecretRef: databaseOperator.migrationPasswordSecretRef,
    },
  });
  const backup = JSON.parse(
    await hosts.run(controller, [
      'node',
      '--input-type=module',
      '-e',
      `import {createBackup} from '/release/deployment/installer/hybrid-lifecycle-probes.mjs';console.log(JSON.stringify(await createBackup(${JSON.stringify(backupOperator)})));`,
    ]),
  );
  assert.equal(backup.status, 'verified');
  const state = JSON.parse(await readFile(join(root, 'installer-state.json')));
  operator.upgradeFromReleaseHash = state.releaseHash;
  operator.backupManifestSha256 = backup.manifestSha256;
  operator.upgradeBackup = backup.upgradeBackup;
  await json(operatorPath, operator);
  config.phase = 2;
  config.images = target.images;
  config.applicationAuth = auth;
  config.services.edge.access = 'application';
  await json(configPath, config);
  await json(releasePath, target);
  for (const worker of workers) await compose(worker, ['start', 'workers']);
  assert.equal((await cli('upgrade')).status, 'ready');
  await transfer();
  for (const worker of workers)
    await compose(worker, ['up', '-d', '--wait', '--wait-timeout', '120']);
  assert.equal((await cli('resume')).status, 'ready');
  const afterImages = await verifyImages(target.images);
  const after = await inspectState();
  assert.deepEqual(after.metadata, before.metadata);
  assert.equal(after.sha256, before.sha256);
  assert.deepEqual(after.execution, before.execution);
  assert.equal(after.internal, before.internal);
  assert.deepEqual(
    after.ledger.filter((row) => row.id === '001-foundation'),
    before.ledger,
  );
  assert.deepEqual(
    after.ledger.map((row) => row.id),
    ['001-foundation', '002-application-auth'],
  );
  assert.equal(after.authTable, 'cc.application_principals');
  const internalAfter = await checksums(
    config.services.kestra.internalStorage.location,
  );
  assert.deepEqual(internalAfter, internalBefore);
  return {
    status: 'passed',
    durationMs: Date.now() - started,
    baselineImages: baseline.images,
    images: target.images,
    beforeImages,
    afterImages,
    baselineMigrations: before.ledger,
    upgradedMigrations: after.ledger,
    artifact: seeded.artifact,
    executionId: seeded.executionId,
    internalStorageFiles: internalAfter,
    encryptedBackup: {
      status: backup.status,
      manifestSha256: backup.manifestSha256,
    },
    limits: [
      'The current installer CLI upgrades published baseline images on three synthetic Docker hosts.',
      'Final source, district infrastructure, isolated restore, and fault acceptance require separate evidence.',
    ],
  };
}
