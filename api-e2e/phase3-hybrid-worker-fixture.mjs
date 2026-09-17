import assert from 'node:assert/strict';
import { readFile, writeFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';

/** Qualify shared credential renewal across the installed worker daemons. */
export async function qualifyHybridWorkerCredentials({
  hosts,
  controller,
  workers,
  compose,
  controllerFile,
  project,
}) {
  assert.match(project, /^cc-phase3-hybrid-[a-f0-9]{12}$/);
  assert.equal(workers.length, 2);
  assert.equal(
    new Set([controller, ...workers].map((host) => host.daemonId)).size,
    3,
  );
  for (const host of [controller, ...workers])
    assert.ok(host.root.startsWith(`/tmp/${project}-`));
  const started = Date.now();
  const observations = [];
  const database = async (expire = false) =>
    JSON.parse(
      await hosts.run(
        controller,
        [
          'docker',
          'compose',
          '-f',
          controllerFile,
          '-p',
          project,
          'run',
          '--rm',
          '--no-deps',
          '--interactive',
          '--no-tty',
          'database-migrate',
          'node',
          '--input-type=module',
        ],
        {
          input: `import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {connectDatabase} from '/app/deployment/postgres/index.mjs';
const config=JSON.parse(await fs.readFile('/run/config/profile.json'));
const operator=JSON.parse(await fs.readFile('/run/config/operator.json'));
const client=await connectDatabase({...config.services.applicationDatabase,role:operator.migrationRole,passwordSecretRef:operator.migrationPasswordSecretRef},reference=>fs.readFile(reference.path));
try {
const connection=(await client.query('SELECT customer_id,generation,credential_id FROM cc.google_connection WHERE singleton')).rows[0];
assert.equal(connection.customer_id,'C0123456');assert.equal(connection.generation,2);
if(${expire}){
const changed=await client.query("UPDATE cc.google_access_tokens SET expires_at=clock_timestamp()+interval '30 seconds' WHERE singleton AND credential_id=$1 AND generation=$2 AND customer_id=$3 AND envelope IS NOT NULL",[connection.credential_id,connection.generation,connection.customer_id]);
assert.equal(changed.rowCount,1);
}
const renewals=(await client.query("SELECT count(*)::int AS count FROM cc.security_events WHERE event='connection-token-renewed'")).rows[0].count;
const tokens=(await client.query("SELECT count(*)::int AS count,coalesce(bool_and(cc.google_envelope_valid(envelope) AND envelope::text NOT LIKE '%synthetic-connection-token%'),false) AS encrypted FROM cc.google_access_tokens WHERE singleton AND generation=$1 AND customer_id=$2",[connection.generation,connection.customer_id])).rows[0];
console.log(JSON.stringify({customerId:connection.customer_id,generation:connection.generation,renewals,tokens}));
} finally { await client.end(); }`,
        },
      ),
    );
  const dispatch = async (host, mode = 'current', timeoutMs = 70000) => {
    const ids = (await compose(host, ['ps', '--quiet', 'workers']))
      .split('\n')
      .filter(Boolean);
    assert.equal(ids.length, 1);
    const result = JSON.parse(
      await hosts.run(
        host,
        ['docker', 'exec', '-i', ids[0], 'node', '--input-type=module'],
        {
          input: `import assert from 'node:assert/strict';
import fs from 'node:fs';import https from 'node:https';import {randomUUID} from 'node:crypto';
const mode=${JSON.stringify(mode)},config=JSON.parse(fs.readFileSync(process.env.CC_CONFIG_FILE));
const endpoint=new URL(config.services.workers.endpoint.url);
const data={customerId:'C0123456',generation:mode==='retired'?1:2,correlationId:randomUUID(),executionId:randomUUID(),...(mode==='credential-field'?{accessToken:'forbidden'}:{})};
const body=JSON.stringify(data),secret=fs.readFileSync('/run/secrets/worker-dispatch','utf8').trim();
const expected=mode==='unauthorized'?401:mode==='credential-field'?400:mode==='retired'?503:200;
const response=await new Promise((resolve,reject)=>{
 const request=https.request({signal:AbortSignal.timeout(${timeoutMs}),hostname:'127.0.0.1',port:Number(endpoint.port||443),servername:endpoint.hostname,ca:fs.readFileSync('/run/secrets/district-ca'),path:'/dispatch/google-customer',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),...(mode==='unauthorized'?{}:{authorization:'Bearer '+secret})}},response=>{let text='';response.on('data',chunk=>{text+=chunk;if(text.length>65536)request.destroy(Error('Response exceeds the fixture limit.'));});response.on('end',()=>resolve({status:response.statusCode,value:JSON.parse(text)}));});
 request.on('error',reject);request.end(body);
});
assert.equal(response.status,expected);
const value=response.value;
if(expected===200){assert.equal(value.status,'completed');assert.equal(value.customerId,data.customerId);assert.equal(value.generation,data.generation);assert.equal(value.observation.primaryDomain,'fixture.invalid');assert.equal(value.executionId,data.executionId);assert.equal(value.correlationId,data.correlationId);assert.equal(JSON.stringify(value).includes('synthetic-connection-token'),false);assert.equal('envelope' in value,false);}
else assert.deepEqual(value,{error:mode==='unauthorized'?'unauthorized':mode==='credential-field'?'invalid-payload':'credential-changed'});
console.log(JSON.stringify({status:response.status,generation:data.generation,mode,completed:expected===200}));`,
        },
      ),
    );
    observations.push({ host: host.role, daemonId: host.daemonId, ...result });
    return result;
  };
  for (const host of workers) {
    await dispatch(host, 'unauthorized');
    await dispatch(host, 'credential-field');
    await dispatch(host, 'retired');
    await dispatch(host);
  }
  const before = await database();
  assert.deepEqual(before.tokens, { count: 1, encrypted: true });
  const marker = (host, name) =>
    join(host.root, 'qualification-observation', `${name}.json`);
  const hold = async (host, value) => {
    const target = marker(host, 'hold');
    await writeFile(`${target}.tmp`, JSON.stringify({ hold: value }), {
      mode: 0o600,
    });
    await rename(`${target}.tmp`, target);
  };
  for (const host of workers) {
    for (const name of ['pending', 'renewal-started'])
      await rm(marker(host, name), { force: true });
    await hold(host, true);
  }
  let concurrent;
  let contention;
  try {
    await database(true);
    concurrent = Promise.allSettled(workers.map((host) => dispatch(host)));
    const heldAt = Date.now();
    while (Date.now() - heldAt < 9000) {
      const observed = async (host, name) => {
        try {
          return (
            JSON.parse(await readFile(marker(host, name), 'utf8')).observed ===
            true
          );
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      };
      const owners = [];
      const waiters = [];
      for (const host of workers) {
        if (await observed(host, 'renewal-started')) owners.push(host.daemonId);
        if (await observed(host, 'pending')) waiters.push(host.daemonId);
      }
      if (
        owners.length === 1 &&
        waiters.length === 1 &&
        owners[0] !== waiters[0]
      ) {
        contention = {
          renewalDaemonId: owners[0],
          pendingDaemonId: waiters[0],
          observedWithinMs: Date.now() - heldAt,
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(
      contention,
      'A second worker must observe the pending renewal lease.',
    );
  } finally {
    for (const host of workers) await hold(host, false);
    if (concurrent) {
      const settled = await concurrent;
      assert.ok(
        settled.every((entry) => entry.status === 'fulfilled'),
        'Both contending workers must complete their reads.',
      );
    }
  }
  const renewed = await database();
  assert.equal(renewed.renewals, before.renewals + 1);
  assert.deepEqual(renewed.tokens, { count: 1, encrypted: true });
  const restartStarted = Date.now();
  await Promise.all(
    workers.map((host) => compose(host, ['restart', 'workers'])),
  );
  for (const host of workers) {
    let completed = false;
    while (Date.now() - restartStarted < 30000) {
      try {
        await dispatch(
          host,
          'current',
          Math.max(1, 30000 - (Date.now() - restartStarted)),
        );
        completed = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(completed, 'Each worker must recover within 30 seconds.');
  }
  const restartRecoveryMs = Date.now() - restartStarted;
  assert.ok(restartRecoveryMs <= 30000);
  const restarted = await database();
  assert.equal(restarted.renewals, renewed.renewals);
  assert.deepEqual(restarted.tokens, { count: 1, encrypted: true });
  return {
    status: 'passed',
    durationMs: Date.now() - started,
    durationScope:
      'Worker dispatch boundaries, concurrent credential renewal, and worker restart after browser closure.',
    customerId: before.customerId,
    generation: before.generation,
    workerHosts: workers.map(({ role, daemonId }) => ({ role, daemonId })),
    observations,
    contention,
    renewalEvents: {
      before: before.renewals,
      afterConcurrentReads: renewed.renewals,
      afterRestart: restarted.renewals,
    },
    restartRecoveryMs,
    restartRecoveryBoundSeconds: 30,
    checks: {
      readsAfterBrowserClosure: true,
      unauthorizedDispatchRejected: true,
      credentialFieldsRejected: true,
      retiredGenerationRejected: true,
      sharedRenewal: true,
      encryptedStoredToken: true,
      restartReusesToken: true,
    },
    limits: [
      'The fixture advances the owned token expiry to exercise renewal without a one-hour wait.',
      'Worker-only preload instrumentation holds synthetic renewal and observes the real pending-lease result without changing it.',
      'Two worker daemons share one physical host and synthetic Google transport.',
      'This report does not establish live Google privileges, independent physical failure domains, or complete hybrid fault recovery.',
    ],
  };
}
