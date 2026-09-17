import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Qualify stored credential renewal across two isolated worker pods. */
export async function qualifyKubernetesWorkerCredentials({
  root,
  project,
  kube,
}) {
  assert.match(project, /^cc-capacity-kube-[a-f0-9]{12}$/);
  assert.ok(root.startsWith(`/tmp/${project}-`));
  const config = JSON.parse(
    await readFile(join(root, 'runtime/config.json'), 'utf8'),
  );
  assert.equal(config.phase, 3);
  assert.equal(config.profile, 'kubernetes');
  const started = Date.now();
  const observations = [];
  const workers = async () => {
    const pods = JSON.parse(
      await kube([
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/name=workers',
        '-o',
        'json',
      ]),
    ).items.filter((pod) => !pod.metadata.deletionTimestamp);
    assert.equal(pods.length, 2);
    assert.equal(new Set(pods.map((pod) => pod.spec.nodeName)).size, 2);
    for (const pod of pods) {
      assert.equal(pod.metadata.namespace, project);
      assert.ok(
        pod.status.containerStatuses.some(
          (container) => container.name === 'workers' && container.ready,
        ),
      );
    }
    return pods.map((pod) => ({
      pod: pod.metadata.name,
      uid: pod.metadata.uid,
      node: pod.spec.nodeName,
    }));
  };
  const executeWorker = async (worker, script) =>
    JSON.parse(
      await kube(
        [
          'exec',
          '-i',
          worker.pod,
          '--container',
          'workers',
          '--',
          'node',
          '--input-type=module',
        ],
        script,
      ),
    );
  const psql = (sql) =>
    kube([
      'exec',
      'deployment/application-postgres',
      '--',
      'psql',
      '-U',
      'postgres',
      '-d',
      config.services.applicationDatabase.database,
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      sql,
    ]);
  const database = async (expire = false) => {
    if (expire)
      assert.equal(
        (
          await psql(
            "WITH changed AS (UPDATE cc.google_access_tokens SET expires_at=clock_timestamp()+interval '30 seconds' WHERE singleton AND generation=2 AND customer_id='C0123456' AND envelope IS NOT NULL RETURNING 1) SELECT count(*) FROM changed;",
          )
        ).trim(),
        '1',
      );
    const result = JSON.parse(
      await psql(`SELECT json_build_object(
      'customerId',c.customer_id,'generation',c.generation,
      'renewals',(SELECT count(*) FROM cc.security_events WHERE event='connection-token-renewed'),
      'tokens',(SELECT json_build_object('count',count(*),'encrypted',coalesce(bool_and(cc.google_envelope_valid(envelope) AND envelope::text NOT LIKE '%synthetic-connection-token%'),false)) FROM cc.google_access_tokens WHERE singleton AND generation=c.generation AND customer_id=c.customer_id)
    ) FROM cc.google_connection c WHERE singleton;`),
    );
    assert.equal(result.customerId, 'C0123456');
    assert.equal(result.generation, 2);
    return result;
  };
  const dispatch = async (worker, mode = 'current') => {
    assert.ok(
      ['current', 'unauthorized', 'credential-field', 'retired'].includes(mode),
    );
    const result = await executeWorker(
      worker,
      `import assert from 'node:assert/strict';import fs from 'node:fs';import https from 'node:https';import {randomUUID} from 'node:crypto';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const mode=${JSON.stringify(mode)},config=JSON.parse(fs.readFileSync(process.env.CC_CONFIG_FILE)),service=config.services.workers,endpoint=new URL(service.endpoint.url);
const data={customerId:'C0123456',generation:mode==='retired'?1:2,correlationId:randomUUID(),executionId:randomUUID(),...(mode==='credential-field'?{accessToken:'forbidden'}:{})};
const body=JSON.stringify(data),secret=fs.readFileSync(secretPath(service.dispatchSecretRef),'utf8').trim();
const expected=mode==='unauthorized'?401:mode==='credential-field'?400:mode==='retired'?503:200;
const response=await new Promise((resolve,reject)=>{
const request=https.request({signal:AbortSignal.timeout(70000),hostname:'127.0.0.1',port:Number(endpoint.port||443),servername:endpoint.hostname,ca:fs.readFileSync(secretPath(service.endpoint.tls.caSecretRef)),path:'/dispatch/google-customer',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),...(mode==='unauthorized'?{}:{authorization:'Bearer '+secret})}},response=>{let text='';response.on('data',chunk=>{text+=chunk;if(text.length>65536)request.destroy(Error('Response exceeds the fixture limit.'));});response.on('end',()=>resolve({status:response.statusCode,value:JSON.parse(text)}));});request.on('error',reject);request.end(body);});
assert.equal(response.status,expected);const value=response.value;
if(expected===200){assert.equal(value.status,'completed');assert.equal(value.customerId,data.customerId);assert.equal(value.generation,data.generation);assert.equal(value.observation.primaryDomain,'fixture.invalid');assert.equal(value.executionId,data.executionId);assert.equal(value.correlationId,data.correlationId);assert.equal(JSON.stringify(value).includes('synthetic-connection-token'),false);assert.equal('envelope' in value,false);}
else assert.deepEqual(value,{error:mode==='unauthorized'?'unauthorized':mode==='credential-field'?'invalid-payload':'credential-changed'});
console.log(JSON.stringify({status:response.status,generation:data.generation,mode,completed:expected===200}));`,
    );
    observations.push({ ...worker, ...result });
    return result;
  };
  const initial = await workers();
  for (const worker of initial)
    for (const mode of [
      'unauthorized',
      'credential-field',
      'retired',
      'current',
    ])
      await dispatch(worker, mode);
  const before = await database();
  assert.deepEqual(before.tokens, { count: 1, encrypted: true });
  const marker = (worker, mode) =>
    executeWorker(
      worker,
      `import fs from 'node:fs';const root='/run/qualification-observation',mode=${JSON.stringify(mode)};
if(mode==='hold'||mode==='release'){
if(mode==='hold')for(const name of ['pending','renewal-started'])fs.rmSync(root+'/'+name+'.json',{force:true});
fs.writeFileSync(root+'/hold.tmp',JSON.stringify({hold:mode==='hold'}),{mode:0o600});fs.renameSync(root+'/hold.tmp',root+'/hold.json');console.log('{}');
}else{const result={};for(const name of ['pending','renewal-started']){try{result[name]=JSON.parse(fs.readFileSync(root+'/'+name+'.json')).observed===true;}catch(error){if(error.code!=='ENOENT')throw error;result[name]=false;}}console.log(JSON.stringify(result));}`,
    );
  let concurrent, contention;
  try {
    for (const worker of initial) await marker(worker, 'hold');
    await database(true);
    concurrent = Promise.allSettled(initial.map((worker) => dispatch(worker)));
    const heldAt = Date.now();
    while (Date.now() - heldAt < 9000) {
      const readings = await Promise.all(
        initial.map(async (worker) => ({
          ...worker,
          ...(await marker(worker, 'read')),
        })),
      );
      const owners = readings.filter((item) => item['renewal-started']);
      const pending = readings.filter((item) => item.pending);
      if (
        owners.length === 1 &&
        pending.length === 1 &&
        owners[0].uid !== pending[0].uid
      ) {
        contention = {
          renewalPod: owners[0].pod,
          pendingPod: pending[0].pod,
          observedWithinMs: Date.now() - heldAt,
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      contention,
      'A second worker must observe the pending renewal lease.',
    );
  } finally {
    const releases = await Promise.allSettled(
      initial.map((worker) => marker(worker, 'release')),
    );
    if (concurrent)
      assert.ok(
        (await concurrent).every((entry) => entry.status === 'fulfilled'),
        'Both contending workers must complete their reads.',
      );
    assert.ok(
      releases.every((entry) => entry.status === 'fulfilled'),
      'Both workers must release the synthetic renewal barrier.',
    );
  }
  const renewed = await database();
  assert.equal(renewed.renewals, before.renewals + 1);
  assert.deepEqual(renewed.tokens, { count: 1, encrypted: true });
  const restartedAt = Date.now();
  await kube(['rollout', 'restart', 'deployment/workers']);
  await kube(['rollout', 'status', 'deployment/workers', '--timeout=180s']);
  const replacements = await workers();
  assert.ok(
    replacements.every(
      (worker) => !initial.some((previous) => previous.uid === worker.uid),
    ),
  );
  for (const worker of replacements) await dispatch(worker);
  const restartRecoveryMs = Date.now() - restartedAt;
  assert.ok(
    restartRecoveryMs <= 180000,
    'Replacement workers must recover within 180 seconds.',
  );
  const restarted = await database();
  assert.equal(restarted.renewals, renewed.renewals);
  assert.deepEqual(restarted.tokens, { count: 1, encrypted: true });
  return {
    status: 'passed',
    durationMs: Date.now() - started,
    durationScope:
      'Worker dispatch boundaries, concurrent credential renewal, and pod replacement after browser closure.',
    customerId: before.customerId,
    generation: before.generation,
    workers: initial,
    replacements,
    observations,
    contention,
    renewalEvents: {
      before: before.renewals,
      afterConcurrentReads: renewed.renewals,
      afterReplacement: restarted.renewals,
    },
    restartRecoveryMs,
    restartRecoveryBoundSeconds: 180,
    checks: {
      readsAfterBrowserClosure: true,
      unauthorizedDispatchRejected: true,
      credentialFieldsRejected: true,
      retiredGenerationRejected: true,
      sharedRenewal: true,
      encryptedStoredToken: true,
      replacementReusesToken: true,
    },
    limits: [
      'The fixture advances the owned token expiry to exercise renewal without a one-hour wait.',
      'Worker-only preload instrumentation holds synthetic renewal and observes the real pending-lease result without changing it.',
      'Two worker nodes share one physical Docker host and synthetic Google transport.',
      'This report does not establish live Google privileges, physical failure domains, or complete Kubernetes fault recovery.',
    ],
  };
}
