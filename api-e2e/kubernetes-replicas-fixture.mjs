import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { verifyReplicaRecipientAccess } from './replica-permission-fixture.mjs';

/** Verify the same browser session through each named API pod. */
export function kubernetesReplicaProbe(kube) {
  let cookie, principalId;
  const observations = [];
  const verify = async (context, phase, expectedStatus = 200) => {
    if (context) {
      cookie = (await context.cookies())
        .filter((item) => item.name === '__Host-cc-session')
        .map((item) => `${item.name}=${item.value}`)
        .join('; ');
    }
    assert.ok(
      cookie,
      'Replica verification requires the saved browser session.',
    );
    const pods = JSON.parse(
      await kube([
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/name=api',
        '-o',
        'json',
      ]),
    ).items.filter((pod) => !pod.metadata.deletionTimestamp);
    assert.equal(pods.length, 2);
    for (const pod of pods) {
      assert.equal(pod.status.phase, 'Running');
      let result;
      await expect
        .poll(
          async () => {
            result = await readKubernetesReplica({
              kube,
              replica: pod.metadata.name,
              cookie,
              path: '/api/auth/session',
            });
            return result.status;
          },
          { timeout: 30000 },
        )
        .toBe(expectedStatus);
      if (expectedStatus === 200) {
        assert.match(result.principalId, /^[a-f0-9-]{36}$/);
        principalId ??= result.principalId;
        assert.equal(result.principalId, principalId);
      } else assert.equal(result.principalId, undefined);
      observations.push({
        phase,
        pod: pod.metadata.name,
        podUid: pod.metadata.uid,
        node: pod.spec.nodeName,
        ...result,
      });
    }
    return pods.map((pod) => pod.metadata.uid);
  };
  return { verify, observations };
}

/** Read a named API pod without putting browser credentials in process arguments. */
export async function readKubernetesReplica({ kube, replica, path, cookie }) {
  assert.match(replica, /^api-[a-z0-9-]+$/);
  assert.ok(
    path === '/api/auth/session' ||
      /^\/api\/schools\/[a-f0-9-]{36}$/.test(path),
  );
  assert.ok(typeof cookie === 'string' && cookie.length > 0);
  return JSON.parse(
    await kube(
      [
        'exec',
        '-i',
        replica,
        '--container',
        'api',
        '--',
        'node',
        '--input-type=module',
        '-e',
        `import fs from 'node:fs/promises';import https from 'node:https';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;const {cookie,path}=JSON.parse(input);
const config=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE)),endpoint=new URL(config.services.api.endpoint.url);
const ca=await fs.readFile(secretPath(config.services.api.endpoint.tls.caSecretRef));
const request=https.get({hostname:'127.0.0.1',port:endpoint.port,servername:endpoint.hostname,path,ca,rejectUnauthorized:true,
headers:{cookie,host:new URL(config.applicationAuth.publicOrigin).host,'x-forwarded-proto':'https'},signal:AbortSignal.timeout(10000)},response=>{
let body='';response.on('data',chunk=>{body+=chunk;if(body.length>65536)request.destroy(new Error('Replica response exceeds the fixture limit.'));});
response.on('end',()=>{const value=JSON.parse(body);console.log(JSON.stringify({status:response.statusCode,principalId:value.identity?.id,schoolId:value.id,hiddenSchoolResponse:Object.keys(value).length===1&&value.reason==='school-not-found'}));});
});request.on('error',()=>process.exit(1));`,
      ],
      JSON.stringify({ cookie, path }),
    ),
  );
}

/** Verify permission versions and school boundaries on both current API pods. */
export async function verifyKubernetesRecipientAccess(kube, input) {
  const pods = JSON.parse(
    await kube([
      'get',
      'pods',
      '-l',
      'app.kubernetes.io/name=api',
      '-o',
      'json',
    ]),
  ).items.filter((pod) => !pod.metadata.deletionTimestamp);
  for (const pod of pods) {
    assert.equal(pod.status.phase, 'Running');
    assert.ok(
      pod.status.containerStatuses.some(
        (container) => container.name === 'api' && container.ready,
      ),
    );
  }
  return verifyReplicaRecipientAccess(
    {
      replicas: pods.map((pod) => pod.metadata.name),
      readReplica: (request) => readKubernetesReplica({ kube, ...request }),
    },
    input,
  );
}
