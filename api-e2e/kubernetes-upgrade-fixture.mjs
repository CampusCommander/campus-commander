import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function configureKubernetesProvider(resources, application) {
  const pod = resources.items.find(
    (item) => item.kind === 'Deployment' && item.metadata.name === 'api',
  ).spec.template.spec;
  pod.hostAliases = [
    { ip: application.hostGateway, hostnames: ['host.docker.internal'] },
  ];
  pod.volumes.push({
    name: 'qualification-provider',
    secret: { secretName: 'qualification-provider' },
  });
  const api = pod.containers.find((container) => container.name === 'api');
  api.env.push({ name: 'NODE_EXTRA_CA_CERTS', value: '/run/qualification/ca' });
  api.volumeMounts.push({
    name: 'qualification-provider',
    mountPath: '/run/qualification',
    readOnly: true,
  });
}

async function checksums(root, relative = '') {
  const entries = [];
  for (const item of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    const path = join(relative, item.name);
    if (item.isDirectory()) entries.push(...(await checksums(root, path)));
    else {
      assert.ok(item.isFile());
      entries.push({
        path,
        sha256: createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Verify migration and durable state across the Kubernetes installer upgrade. */
export async function qualifyKubernetesUpgrade({
  root,
  kube,
  baseline,
  release,
  application,
  installer,
  startForward,
}) {
  const started = Date.now();
  const runtime = join(root, 'runtime');
  const config = JSON.parse(
    await readFile(join(runtime, 'config.json'), 'utf8'),
  );
  const operator = JSON.parse(
    await readFile(join(runtime, 'operator.json'), 'utf8'),
  );
  const pods = async (name) =>
    JSON.parse(
      await kube([
        'get',
        'pods',
        '-l',
        `app.kubernetes.io/name=${name}`,
        '-o',
        'json',
      ]),
    ).items.filter((pod) => !pod.metadata.deletionTimestamp);
  const verifyImages = async (images) => {
    const verified = [];
    for (const name of ['frontend', 'api', 'workers']) {
      const current = await pods(name);
      assert.equal(current.length, name === 'frontend' ? 1 : 2);
      for (const pod of current) {
        const container = pod.spec.containers.find(
          (item) => item.name === name,
        );
        const status = pod.status.containerStatuses.find(
          (item) => item.name === name,
        );
        assert.equal(container.image, images[name]);
        assert.ok(status.ready);
        assert.ok(
          status.imageID.endsWith(images[name].split('@')[1]),
          'The running container must match its immutable image digest.',
        );
        verified.push({
          service: name,
          pod: pod.metadata.name,
          image: container.image,
          imageId: status.imageID,
        });
      }
    }
    return verified;
  };
  const beforeImages = await verifyImages(baseline.images);
  const runApi = async (script) =>
    JSON.parse(
      await kube(
        ['exec', '-i', 'deployment/api', '--', 'node', '--input-type=module'],
        script,
      ),
    );
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
const r=https.request(new URL(path,c.services.kestra.endpoint.url),{method,ca,headers:{authorization:'Basic '+Buffer.from(auth.username+':'+auth.password).toString('base64'),...(contentType?{'content-type':contentType}:{}),...(body?{'content-length':Buffer.byteLength(body)}:{})}},response=>{const chunks=[];response.on('data',b=>chunks.push(b));response.on('end',()=>{const text=Buffer.concat(chunks).toString();if(response.statusCode!==200)return reject(Error('Synthetic Kestra request failed: '+response.statusCode));try{resolve(JSON.parse(text))}catch{resolve(text)}})});r.on('error',reject);r.setTimeout(5000,()=>r.destroy(Error('Synthetic Kestra request timed out.')));r.end(body);
});`;
  const seeded = await runApi(
    common +
      `
const bytes=Buffer.from('Phase 1 Kubernetes upgrade École 学校');
const artifact=await store.stage({schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes]);
await store.publish(artifact);await store.close();await pool.end();
await request('POST','/api/v1/main/flows',${JSON.stringify(await readFile(new URL('../deployment/kestra/cc11-external-worker.yaml', import.meta.url), 'utf8'))},'application/x-yaml');
const boundary='cc-'+crypto.randomUUID();const fields={correlationId:crypto.randomUUID(),marker:'phase1-kubernetes-upgrade',delayMilliseconds:'0'};
const body=Object.entries(fields).map(([key,value])=>'--'+boundary+'\\r\\nContent-Disposition: form-data; name="'+key+'"\\r\\n\\r\\n'+value+'\\r\\n').join('')+'--'+boundary+'--\\r\\n';
const execution=await request('POST','/api/v1/main/executions/campus.validation/cc11_external_worker',body,'multipart/form-data; boundary='+boundary);
let result;for(let index=0;index<50;index++){result=await request('GET','/api/v1/main/executions/'+execution.id);if(['SUCCESS','FAILED','KILLED','CANCELLED'].includes(result.state.current))break;await new Promise(done=>setTimeout(done,1000));}
if(result.state.current!=='SUCCESS')throw Error('The baseline worker execution did not pass.');
process.stdout.write(JSON.stringify({artifact,executionId:execution.id}));`,
  );
  const inspectState = () =>
    runApi(
      common +
        `
const id=${JSON.stringify(seeded.artifact.artifactId)},hash=crypto.createHash('sha256');
for await(const bytes of await store.openRead(id))hash.update(bytes);
const metadata=(await pool.query('SELECT to_jsonb(a) AS value FROM cc.artifacts a WHERE id=$1',[id])).rows;
const ledger=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const authTable=(await pool.query("SELECT to_regclass('cc.application_principals')::text AS name")).rows[0].name;
await store.close();await pool.end();const execution=await request('GET','/api/v1/main/executions/'+${JSON.stringify(seeded.executionId)});
process.stdout.write(JSON.stringify({metadata,ledger,authTable,sha256:hash.digest('hex'),execution}));`,
    );
  const before = await inspectState();
  assert.equal(before.authTable, null);
  const filesBefore = await checksums(
    join(root, 'shared', 'kestra-internal', 'kestra'),
  );
  assert.ok(filesBefore.length > 0);
  process.stdout.write(
    'Preserve the baseline state and apply the Phase 2 migration.\n',
  );
  assert.ok(
    installer,
    'Kubernetes upgrade must use the prepared installer CLI.',
  );
  config.phase = 2;
  config.images = release.images;
  config.applicationAuth = application.auth;
  config.services.edge.access = 'application';
  config.services.edge.endpoint.url = application.auth.publicOrigin;
  operator.release = release;
  const lifecycle = await installer.upgrade({ config, release, startForward });
  const resources = installer.resources();
  await kube(['rollout', 'status', 'deployment', '--timeout=300s']);
  const afterImages = await verifyImages(release.images);
  const after = await inspectState();
  assert.equal(after.authTable, 'cc.application_principals');
  assert.deepEqual(after.ledger.slice(0, before.ledger.length), before.ledger);
  assert.equal(after.ledger.length, before.ledger.length + 1);
  assert.deepEqual(after.metadata, before.metadata);
  assert.equal(after.sha256, before.sha256);
  assert.deepEqual(after.execution, before.execution);
  assert.deepEqual(
    await checksums(join(root, 'shared', 'kestra-internal', 'kestra')),
    filesBefore,
  );
  for (const [name, value] of Object.entries({ config, operator, resources }))
    await writeFile(
      join(runtime, `${name}.json`),
      JSON.stringify(value, null, 2),
      { mode: 0o600 },
    );
  return {
    status: 'passed',
    recordedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    baselineImages: baseline.images,
    images: release.images,
    runtimeImageContentVerified: true,
    installer: lifecycle,
    beforeImages,
    afterImages,
    baselineMigrations: before.ledger,
    upgradedMigrations: after.ledger,
    preserved: {
      artifactId: seeded.artifact.artifactId,
      artifactSha256: before.sha256,
      artifactMetadata: true,
      executionId: seeded.executionId,
      executionState: 'SUCCESS',
      kestraFiles: filesBefore.length,
    },
    limits: [
      'Three Kind nodes share one Docker host and synthetic shared storage.',
      'The real installer CLI verifies the encrypted baseline backup and applies the Phase 2 upgrade.',
      'This report does not establish district infrastructure, network policy enforcement, or signed release acceptance.',
    ],
  };
}
