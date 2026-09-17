import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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

/** Verify permission changes and school boundaries on every API replica. */
export async function verifyHybridRecipientAccess(
  { hosts, controller, compose },
  { cookies, principalId, schoolId, hiddenSchoolId, expectedStatus, stage },
) {
  assert.ok(['grants-changed', 'scoped-access', 'revoked'].includes(stage));
  assert.equal(expectedStatus, stage === 'scoped-access' ? 200 : 401);
  const replicas = (await compose(controller, ['ps', '--quiet', 'api']))
    .split('\n')
    .filter(Boolean);
  assert.equal(replicas.length, 2);
  assert.equal(new Set(replicas).size, 2);
  const cookie = cookies
    .filter(({ name }) => name.startsWith('__Host-'))
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  assert.ok(
    cookie,
    'Permission checks require the previous authenticated recipient cookie.',
  );
  const observations = [];
  for (const replica of replicas) {
    const read = async (path, kind, status) => {
      const result = await readHybridReplica({
        hosts,
        controller,
        replica,
        path,
        cookie,
      });
      assert.equal(result.status, status);
      if (kind === 'session')
        assert.equal(
          result.principalId,
          status === 200 ? principalId : undefined,
        );
      else if (status === 200) assert.equal(result.schoolId, schoolId);
      if (status === 404) assert.equal(result.hiddenSchoolResponse, true);
      observations.push({ replica, stage, resource: kind, status });
    };
    await read('/api/auth/session', 'session', expectedStatus);
    await read(`/api/schools/${schoolId}`, 'granted-school', expectedStatus);
    if (expectedStatus === 200) {
      await read(`/api/schools/${hiddenSchoolId}`, 'ungranted-school', 404);
      await read(`/api/schools/${randomUUID()}`, 'unknown-school', 404);
    }
  }
  return observations;
}
