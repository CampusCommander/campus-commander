import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { createKubernetesDurableProbe } from './kubernetes-durable-fixture.mjs';
import { faultRecoveryTimeoutSeconds } from '../deployment/qualification/faults.mjs';

/** Verify authenticated ENOSPC recovery on the capped shared Kubernetes artifact volume. */
export async function qualifyKubernetesCapacity({
  root,
  project,
  kube,
  volume,
  page,
  checks,
}) {
  assert.match(project, /^cc-capacity-kube-[a-f0-9]{12}$/);
  assert.equal(volume.name, `${project}-artifacts`);
  const config = JSON.parse(await readFile(join(root, 'runtime/config.json')));
  assert.equal(config.phase, 2);
  const pods = JSON.parse(
    await kube(['get', 'pods', '-o', 'json']),
  ).items.filter(
    (pod) =>
      ['api', 'workers'].includes(
        pod.metadata.labels['app.kubernetes.io/name'],
      ) && !pod.metadata.deletionTimestamp,
  );
  assert.equal(
    pods.filter(
      (pod) => pod.metadata.labels['app.kubernetes.io/name'] === 'api',
    ).length,
    2,
  );
  const workers = pods.filter(
    (pod) => pod.metadata.labels['app.kubernetes.io/name'] === 'workers',
  );
  assert.equal(workers.length, 2);
  assert.equal(new Set(workers.map((pod) => pod.spec.nodeName)).size, 2);
  const run = async (pod, script) =>
    JSON.parse(
      await kube(
        [
          'exec',
          '-i',
          pod.metadata.name,
          '--container',
          pod.metadata.labels['app.kubernetes.io/name'],
          '--',
          'node',
          '--input-type=module',
        ],
        script,
      ),
    );
  const api = pods.find(
    (pod) => pod.metadata.labels['app.kubernetes.io/name'] === 'api',
  );
  const common = `import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';import {secretPath} from '/app/deployment/redis/runtime.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));`;
  const artifact = await run(
    api,
    common +
      `
const store=await createArtifactStore({pool,root:c.artifacts.location}),bytes=Buffer.from('Kubernetes capacity baseline École 学校');
const artifactSha256=crypto.createHash('sha256').update(bytes).digest('hex');
const manifest=await store.stage({schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:artifactSha256},[bytes]);await store.publish(manifest);
await store.close();await pool.end();console.log(JSON.stringify({artifactId:manifest.artifactId,artifactSha256}));`,
  );
  await run(
    api,
    `import fs from 'node:fs/promises';import https from 'node:https';import crypto from 'node:crypto';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE)),secret=r=>fs.readFile(secretPath(r));
const auth=JSON.parse(await secret(c.services.kestra.authSecretRef)),ca=await secret(c.services.kestra.endpoint.tls.caSecretRef);
const path='/api/v1/main/namespaces/campus.validation/files?path=/phase2-capacity.txt',marker='Kubernetes capacity internal storage École 学校',boundary='cc-'+crypto.randomUUID();
const request=(method,body)=>new Promise((resolve,reject)=>{const r=https.request(new URL(path,c.services.kestra.endpoint.url),{method,ca,headers:{authorization:'Basic '+Buffer.from(auth.username+':'+auth.password).toString('base64'),...(body?{'content-type':'multipart/form-data; boundary='+boundary,'content-length':Buffer.byteLength(body)}:{})}},response=>{const chunks=[];response.on('data',b=>chunks.push(b));response.on('end',()=>{if(response.statusCode<200||response.statusCode>=300)return reject(Error('Synthetic internal storage request failed: '+response.statusCode));resolve(Buffer.concat(chunks).toString());});});r.on('error',reject);r.setTimeout(10000,()=>r.destroy(Error('Synthetic internal storage request timed out.')));r.end(body);});
await request('POST','--'+boundary+'\\r\\nContent-Disposition: form-data; name="fileContent"; filename="phase2-capacity.txt"\\r\\nContent-Type: text/plain\\r\\n\\r\\n'+marker+'\\r\\n--'+boundary+'--\\r\\n');
if(await request('GET')!==marker)throw Error('Synthetic internal storage readback differs.');console.log(JSON.stringify({internalStorageReadback:true}));`,
  );
  await checks();
  const verifyDurable = await createKubernetesDurableProbe({
    root,
    kube,
    config,
    artifact,
  });
  const inventory = () =>
    run(
      api,
      common +
        `
const artifacts=(await pool.query('SELECT * FROM cc.artifacts ORDER BY id')).rows;
const files=(await fs.readdir(c.artifacts.location)).filter(n=>/^[a-f0-9-]{36}\\.[a-f0-9-]{36}$/.test(n)).sort();
await pool.end();console.log(JSON.stringify({artifacts,files}));`,
    );
  const baseline = await inventory();
  assert.equal(baseline.artifacts.length, 1);
  const filesystem = (pod) =>
    run(
      pod,
      `import fs from 'node:fs/promises';const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));const s=await fs.statfs(c.artifacts.location);console.log(JSON.stringify({filesystemType:s.type,totalBytes:s.blocks*s.bsize,availableBytes:s.bavail*s.bsize}));`,
    );
  const report = {
    status: 'in-progress',
    recoveryBoundSeconds: faultRecoveryTimeoutSeconds,
    volume: volume.name,
    observations: [],
    artifact,
    limits: [
      'Three Kind nodes share one physical Docker host and a capped synthetic tmpfs volume.',
      'The capacity fixture does not qualify persistent storage, district capacity, or NetworkPolicy enforcement.',
    ],
  };
  const save = () =>
    writeFile(
      join(root, 'application-capacity-progress.json'),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
  for (const pod of pods) {
    const before = await filesystem(pod);
    assert.equal(before.filesystemType, 0x01021994);
    assert.equal(before.totalBytes, 16777216);
    report.observations.push({
      pod: pod.metadata.name,
      podUid: pod.metadata.uid,
      node: pod.spec.nodeName,
      role: pod.metadata.labels['app.kubernetes.io/name'],
      before,
    });
  }
  let filled = false;
  try {
    filled = true;
    report.fault = await run(
      workers[0],
      `import fs from 'node:fs';const c=JSON.parse(fs.readFileSync(process.env.CC_CONFIG_FILE));const before=fs.statfsSync(c.artifacts.location);
if(before.type!==0x01021994||before.blocks*before.bsize!==16777216)throw Error('Capacity requires capped tmpfs.');
const fd=fs.openSync(c.artifacts.location+'/.phase2-capacity-filler','wx',0o600),bytes=Buffer.alloc(65536,42);let writtenBytes=0,kind;
try{for(let i=0;i<300;i++)writtenBytes+=fs.writeSync(fd,bytes);}catch(error){if(error.code!=='ENOSPC')throw error;kind=error.code;}finally{fs.closeSync(fd);}
if(kind!=='ENOSPC')throw Error('Capacity did not reach ENOSPC.');console.log(JSON.stringify({kind,writtenBytes}));`,
    );
    for (const [index, pod] of pods.entries()) {
      const during = await filesystem(pod);
      assert.equal(during.availableBytes, 0);
      report.observations[index].during = during;
    }
    await save();
    const card = page.getByRole('article').filter({
      has: page.getByRole('heading', {
        name: 'Artifact storage',
        exact: true,
      }),
    });
    const pending = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/diagnostics/artifacts' &&
        response.request().method() === 'POST',
    );
    await card
      .getByRole('button', { name: 'Check Artifact storage', exact: true })
      .click();
    const response = await pending,
      body = await response.json();
    assert.equal(response.status(), 201);
    assert.equal(body.status, 'failed');
    assert.match(body.correlationId, /^[a-f0-9-]{36}$/);
    await expect(
      card.getByText(
        'The check failed. Inspect the service configuration and retry.',
      ),
    ).toBeVisible();
    report.authenticatedFailure = {
      httpStatus: response.status(),
      status: body.status,
      correlationId: body.correlationId,
    };
    await verifyDurable();
    assert.deepEqual(await inventory(), baseline);
    report.fault.publicationRejected = true;
    report.fault.readyRowsUnchanged = true;
  } finally {
    if (filled)
      await run(
        workers[0],
        `import fs from 'node:fs/promises';const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));await fs.rm(c.artifacts.location+'/.phase2-capacity-filler',{force:true});console.log('{}');`,
      );
  }
  const recoveryStarted = Date.now();
  await checks({
    recoverySeconds: faultRecoveryTimeoutSeconds,
    recoveryDeadline: recoveryStarted + faultRecoveryTimeoutSeconds * 1000,
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  report.preserved = {
    ...(await verifyDurable()),
    identityAndPreferencesPreserved: true,
    migrationsPreserved: true,
    failedDiagnosticArtifactsRemoved: true,
  };
  assert.deepEqual(await inventory(), baseline);
  for (const [index, pod] of pods.entries()) {
    const after = await filesystem(pod);
    assert.equal(
      after.availableBytes,
      report.observations[index].before.availableBytes,
    );
    report.observations[index].after = after;
  }
  report.recoveryMs = Date.now() - recoveryStarted;
  assert.ok(report.recoveryMs <= faultRecoveryTimeoutSeconds * 1000);
  report.status = 'passed';
  await save();
  return report;
}
