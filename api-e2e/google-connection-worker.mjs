import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Qualify independent processes against the real database and synthetic Google transport. */
export async function qualifyGoogleWorker({
  fixture,
  migrator,
  directory,
  evidenceDirectory,
  restartApi,
}) {
  const dispatch = await readFile(
    join(directory, 'secrets/worker-dispatch'),
    'utf8',
  );
  const payload = () => ({
    customerId: 'C0123456',
    generation: 1,
    correlationId: randomUUID(),
    executionId: randomUUID(),
  });
  const send = (origin, data = payload(), authorized = true) =>
    fetch(`${origin}/dispatch/google-customer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorized ? { authorization: `Bearer ${dispatch}` } : {}),
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(70_000),
    });
  const count = async () =>
    (
      await migrator.query(
        "SELECT count(*)::int AS count FROM cc.security_events WHERE event='connection-token-renewed'",
      )
    ).rows[0].count;
  const checked = async (origin) => {
    const response = await send(origin);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.customerId, 'C0123456');
    assert.equal(result.generation, 1);
    assert.equal(result.status, 'completed');
    assert.equal(result.observation.primaryDomain, 'fixture.invalid');
    assert.equal(
      JSON.stringify(result).includes('synthetic-connection-token'),
      false,
    );
    assert.equal('envelope' in result, false);
  };
  assert.equal(
    (await send(fixture.workerOrigin, payload(), false)).status,
    401,
  );
  assert.equal(
    (
      await send(fixture.workerOrigin, {
        ...payload(),
        accessToken: 'forbidden',
      })
    ).status,
    400,
  );
  assert.equal(
    (await send(fixture.workerOrigin, { ...payload(), generation: 2 })).status,
    503,
  );
  const before = await count();
  await checked(fixture.workerOrigin);
  await restartApi();
  await fixture.rotateWorker(dispatch);
  await checked(fixture.workerOrigin);
  assert.equal(
    await count(),
    before,
    'Process restart must reuse the encrypted database token.',
  );
  const replica = await fixture.startWorkerReplica();
  await migrator.query(
    "UPDATE cc.google_access_tokens SET expires_at=clock_timestamp()+interval '30 seconds'",
  );
  await Promise.all([checked(fixture.workerOrigin), checked(replica)]);
  assert.equal(
    await count(),
    before + 1,
    'Worker replicas must share one renewal.',
  );
  const stored = (
    await migrator.query('SELECT envelope FROM cc.google_access_tokens')
  ).rows[0].envelope;
  assert.equal(
    JSON.stringify(stored).includes('synthetic-connection-token'),
    false,
  );
  const keyPath = join(directory, 'secrets/google-credential-key');
  const key = await readFile(keyPath);
  try {
    await writeFile(keyPath, randomBytes(32));
    assert.equal((await send(fixture.workerOrigin)).status, 503);
  } finally {
    await writeFile(keyPath, key);
    key.fill(0);
  }
  await migrator.query(
    'REVOKE EXECUTE ON FUNCTION cc.acquire_google_access(text,integer,uuid) FROM "cc-app"',
  );
  try {
    const denied = await send(fixture.workerOrigin);
    assert.equal(denied.status, 503);
    assert.deepEqual(await denied.json(), {
      error: 'connection-store-unavailable',
    });
  } finally {
    await migrator.query(
      'GRANT EXECUTE ON FUNCTION cc.acquire_google_access(text,integer,uuid) TO "cc-app"',
    );
  }
  await checked(fixture.workerOrigin);
  await writeFile(
    join(evidenceDirectory, 'google-connection-worker.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        fixture: 'real-postgresql-two-workers-synthetic-google-transport',
        checks: [
          'worker reads succeed after browser logout and closure',
          'API and worker restarts reuse the encrypted database token',
          'two independent worker processes share one renewal',
          'dispatch accepts identifiers and rejects credential fields',
          'wrong encryption key and denied database access fail closed',
          'worker response and stored envelope omit plaintext tokens',
        ],
      },
      null,
      2,
    ),
  );
}
