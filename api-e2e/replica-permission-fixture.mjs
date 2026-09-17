import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Verify permission changes and school boundaries on every API replica. */
export async function verifyReplicaRecipientAccess(
  { replicas, readReplica },
  { cookies, principalId, schoolId, hiddenSchoolId, expectedStatus, stage },
) {
  assert.ok(['grants-changed', 'scoped-access', 'revoked'].includes(stage));
  assert.equal(expectedStatus, stage === 'scoped-access' ? 200 : 401);
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
      const result = await readReplica({
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
