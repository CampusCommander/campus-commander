import assert from 'node:assert/strict';
import { verifyReplicaRecipientAccess } from './replica-permission-fixture.mjs';

/** Read one installed API replica without retaining browser credentials. */
export async function readHybridReplica({
  hosts,
  controller,
  replica,
  path,
  cookie,
}) {
  assert.match(replica, /^[a-f0-9]{12,64}$/);
  assert.ok(
    path === '/api/auth/session' ||
      /^\/api\/schools\/[a-f0-9-]{36}$/.test(path),
  );
  assert.ok(typeof cookie === 'string' && cookie.length > 0);
  return JSON.parse(
    await hosts.run(
      controller,
      [
        'docker',
        'exec',
        '-i',
        replica,
        'node',
        '--input-type=module',
        '-e',
        `import fs from 'node:fs';import https from 'node:https';let input='';for await(const chunk of process.stdin)input+=chunk;const {cookie,path}=JSON.parse(input);const request=https.get({hostname:'127.0.0.1',port:3000,servername:'api',ca:fs.readFileSync('/run/secrets/district-ca'),path,headers:{cookie},signal:AbortSignal.timeout(10000)},response=>{let body='';response.on('data',chunk=>{body+=chunk;if(body.length>65536)request.destroy(new Error('Replica response exceeds the fixture limit.'));});response.on('end',()=>{const value=JSON.parse(body);console.log(JSON.stringify({status:response.statusCode,principalId:value.identity?.id,schoolId:value.id,hiddenSchoolResponse:Object.keys(value).length===1&&value.reason==='school-not-found'}));});});request.on('error',()=>process.exit(1));`,
      ],
      { input: JSON.stringify({ cookie, path }) },
    ),
  );
}

/** Verify permission changes through the controller's two API containers. */
export async function verifyHybridRecipientAccess(
  { hosts, controller, compose },
  input,
) {
  const replicas = (await compose(controller, ['ps', '--quiet', 'api']))
    .split('\n')
    .filter(Boolean);
  return verifyReplicaRecipientAccess(
    {
      replicas,
      readReplica: (request) =>
        readHybridReplica({ hosts, controller, ...request }),
    },
    input,
  );
}
