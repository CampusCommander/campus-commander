import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

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
            result = JSON.parse(
              await kube(
                [
                  'exec',
                  '-i',
                  pod.metadata.name,
                  '--container',
                  'api',
                  '--',
                  'node',
                  '--input-type=module',
                ],
                `import fs from 'node:fs/promises';import https from 'node:https';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));const endpoint=new URL(c.services.api.endpoint.url);
const ca=await fs.readFile(secretPath(c.services.api.endpoint.tls.caSecretRef));
const response=await new Promise((resolve,reject)=>{
const request=https.get({hostname:'127.0.0.1',port:endpoint.port,servername:endpoint.hostname,path:'/api/auth/session',ca,rejectUnauthorized:true,
headers:{cookie:${JSON.stringify(cookie)},host:new URL(c.applicationAuth.publicOrigin).host,'x-forwarded-proto':'https'}},response=>{
const chunks=[];response.on('data',bytes=>chunks.push(bytes));response.on('end',()=>{let body;try{body=JSON.parse(Buffer.concat(chunks).toString())}catch{}resolve({status:response.statusCode,principalId:body?.identity?.id});});
});request.setTimeout(10000,()=>request.destroy(Error('Replica session request timed out.')));request.on('error',reject);
});console.log(JSON.stringify(response));`,
              ),
            );
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
