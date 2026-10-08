import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CredentialCipher } from '../../libs/google-connection/src/lib/credential.ts';
import { GoogleConnectionProvider } from '../../libs/google-connection/src/lib/coordinator.ts';
import { GoogleConnectionError } from '../../libs/google-connection/src/lib/provider.ts';

export async function qualifyGoogleTokens({
  runtime,
  migrator,
  connect,
  key,
  cipher,
  credential,
  customerId,
  binding,
  actor,
  observation,
}) {
  const second = await connect('cc-app', 'cc-app');
  const correlation = randomUUID();
  const context = {
    recordId: binding.credential_id,
    customerId,
    generation: 1,
  };
  const access = (lease, client = runtime, generation = 1) =>
    client.query('SELECT cc.acquire_google_access($1,$2,$3) AS result', [
      customerId,
      generation,
      lease,
    ]);
  const complete = (lease, envelope, expiry, failure = null, generation = 1) =>
    runtime.query('SELECT cc.finish_google_access($1,$2,$3,$4,$5,$6,$7)', [
      customerId,
      generation,
      lease,
      envelope && JSON.stringify(envelope),
      expiry && new Date(expiry).toISOString(),
      failure,
      correlation,
    ]);
  const reset = (generation = 1, version = 1) =>
    runtime.query('SELECT cc.reset_google_access($1,$2,$3,$4,$5)', [
      actor,
      version,
      customerId,
      generation,
      correlation,
    ]);
  const changed = (error) => error.detail === 'credential-changed';
  const rollback = async (event, action) => {
    assert.ok(
      [
        'connection-token-renewed',
        'connection-token-failed',
        'connection-checked',
      ].includes(event),
    );
    const state = async () =>
      (
        await migrator.query(`
          SELECT 'token' AS relation, md5(row_to_json(item)::text) AS state FROM cc.google_access_tokens item
          UNION ALL SELECT 'connection', md5(row_to_json(item)::text) FROM cc.google_connection item
          UNION ALL SELECT 'credential', md5(row_to_json(item)::text) FROM cc.google_credentials item
          UNION ALL SELECT 'event', md5(row_to_json(item)::text) FROM cc.security_events item
          ORDER BY relation, state
        `)
      ).rows;
    const before = await state();
    await migrator.query(
      `ALTER TABLE cc.security_events ADD CONSTRAINT token_audit_failure CHECK(event<>'${event}') NOT VALID`,
    );
    try {
      await assert.rejects(
        action(),
        (error) =>
          error.code === '23514' && error.constraint === 'token_audit_failure',
      );
      assert.deepEqual(await state(), before);
    } finally {
      await migrator.query(
        'ALTER TABLE cc.security_events DROP CONSTRAINT token_audit_failure',
      );
    }
  };
  await assert.rejects(
    runtime.query('SELECT * FROM cc.google_access_tokens'),
    (error) => error.code === '42501',
  );
  await assert.rejects(
    runtime.query('SELECT cc.google_current_generation($1,1)', [customerId]),
    (error) => error.code === '42501',
  );
  const leases = [randomUUID(), randomUUID()];
  const claims = await Promise.all([
    access(leases[0]),
    access(leases[1], second),
  ]);
  const winnerIndex = claims.findIndex(
    ({ rows }) => rows[0].result.status === 'renew',
  );
  assert.equal(
    claims.filter(({ rows }) => rows[0].result.status === 'renew').length,
    1,
  );
  assert.equal(
    claims.filter(({ rows }) => rows[0].result.status === 'pending').length,
    1,
  );
  const winner = leases[winnerIndex];
  const token = {
    accessToken: 'ya29.synthetic-token',
    expiresAt: Date.now() + 3_500_000,
    scopeProfile: 'customer-domain-v1',
  };
  const envelope = cipher.sealAccessToken(token, context);
  await rollback('connection-token-renewed', () =>
    complete(winner, envelope, token.expiresAt),
  );
  assert.equal((await access(randomUUID())).rows[0].result.status, 'pending');
  await complete(winner, envelope, token.expiresAt);
  await assert.rejects(complete(winner, envelope, token.expiresAt), changed);
  const cached = (await access(randomUUID(), second)).rows[0].result;
  assert.equal(cached.status, 'cached');
  assert.deepEqual(
    new CredentialCipher('integration-key-1', key).openAccessToken(
      cached.envelope,
      context,
    ),
    token,
  );
  assert.throws(() => cipher.open(cached.envelope, context));
  assert.equal(JSON.stringify(cached).includes(token.accessToken), false);
  await rollback('connection-token-failed', () =>
    runtime.query('SELECT cc.reject_google_access($1,1,$2,$3,$4)', [
      customerId,
      cached.tokenId,
      'credential-rejected',
      correlation,
    ]),
  );
  await runtime.query('SELECT cc.reject_google_access($1,1,$2,$3,$4)', [
    customerId,
    randomUUID(),
    'credential-rejected',
    correlation,
  ]);
  assert.equal((await access(randomUUID())).rows[0].result.status, 'cached');

  await migrator.query(
    "UPDATE cc.google_access_tokens SET expires_at=clock_timestamp()+interval '30 seconds'",
  );
  let renewals = 0;
  const verifier = {
    async renew() {
      renewals += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ...token, expiresAt: Date.now() + 3_500_000 };
    },
    async observe() {
      return observation(customerId);
    },
  };
  const input = { customerId, generation: 1, correlationId: correlation };
  const providers = [
    new GoogleConnectionProvider(runtime, cipher, verifier),
    new GoogleConnectionProvider(
      second,
      new CredentialCipher('integration-key-1', key),
      verifier,
    ),
  ];
  const reads = await Promise.all(
    providers.map((provider) => provider.read(input)),
  );
  assert.equal(renewals, 1);
  assert.equal(
    reads.every(
      (read) => read.customerId === customerId && read.generation === 1,
    ),
    true,
  );
  await new GoogleConnectionProvider(
    second,
    new CredentialCipher('integration-key-1', key),
    verifier,
  ).read(input);
  assert.equal(renewals, 1);

  await rollback('connection-checked', () =>
    runtime.query('SELECT cc.record_google_observation($1,1,$2,$3)', [
      customerId,
      JSON.stringify(observation(customerId)),
      correlation,
    ]),
  );
  const beforeObservation = (
    await migrator.query('SELECT observed_at FROM cc.google_connection')
  ).rows[0].observed_at;
  const beforeAudit = (
    await migrator.query(
      "SELECT count(*)::int AS count FROM cc.security_events WHERE event='connection-checked'",
    )
  ).rows[0].count;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delayed = new GoogleConnectionProvider(runtime, cipher, {
    renew: verifier.renew,
    async observe() {
      entered.resolve();
      await release.promise;
      return observation(customerId);
    },
  });
  const stale = assert.rejects(
    delayed.read(input, undefined, { actorId: actor, permissionVersion: 1 }),
    { code: 'forbidden' },
  );
  await entered.promise;
  try {
    await migrator.query(
      'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
      [actor],
    );
    release.resolve();
    await stale;
    assert.deepEqual(
      (await migrator.query('SELECT observed_at FROM cc.google_connection'))
        .rows[0].observed_at,
      beforeObservation,
    );
    assert.equal(
      (
        await migrator.query(
          "SELECT count(*)::int AS count FROM cc.security_events WHERE event='connection-checked'",
        )
      ).rows[0].count,
      beforeAudit,
    );
    await providers[1].read(input);
  } finally {
    release.resolve();
    await migrator.query(
      'UPDATE cc.application_principals SET permission_version=1 WHERE id=$1',
      [actor],
    );
  }
  const rejected = new GoogleConnectionProvider(runtime, cipher, {
    renew: verifier.renew,
    async observe() {
      throw new GoogleConnectionError('credential-rejected');
    },
  });
  await assert.rejects(rejected.read(input), { code: 'credential-rejected' });
  await assert.rejects(providers[1].read(input), {
    code: 'credential-rejected',
  });
  assert.equal(renewals, 1);
  await assert.rejects(reset(1, 999), (error) => error.code === '42501');
  await rollback('connection-checked', () => reset());
  await reset();
  await providers[0].read(input);
  assert.equal(renewals, 2);

  await migrator.query(
    "UPDATE cc.google_access_tokens SET expires_at=clock_timestamp()+interval '30 seconds'",
  );
  const expiredLease = randomUUID();
  assert.equal((await access(expiredLease)).rows[0].result.status, 'renew');
  await migrator.query(
    "UPDATE cc.google_access_tokens SET lease_until=clock_timestamp()-interval '1 second'",
  );
  await assert.rejects(
    complete(expiredLease, envelope, token.expiresAt),
    changed,
  );
  const retiredLease = randomUUID();
  assert.equal((await access(retiredLease)).rows[0].result.status, 'renew');
  await assert.rejects(
    complete(expiredLease, envelope, token.expiresAt),
    changed,
  );

  const replacementId = randomUUID();
  const replacementContext = {
    recordId: replacementId,
    customerId,
    generation: 2,
  };
  await migrator.query(
    'INSERT INTO cc.google_credentials(id,generation,customer_id,envelope,client_id,delegated_subject) VALUES($1,2,$2,$3,$4,$5)',
    [
      replacementId,
      customerId,
      JSON.stringify(cipher.seal(credential, replacementContext)),
      credential.serviceAccount.client_id,
      credential.subject,
    ],
  );
  await migrator.query(
    'UPDATE cc.google_connection SET generation=2,credential_id=$1',
    [replacementId],
  );
  await assert.rejects(
    complete(retiredLease, envelope, token.expiresAt),
    changed,
  );
  await assert.rejects(
    runtime.query('SELECT cc.record_google_observation($1,1,$2,$3)', [
      customerId,
      JSON.stringify(observation(customerId)),
      correlation,
    ]),
    changed,
  );
  await assert.rejects(access(randomUUID()), changed);
  const activeLease = randomUUID();
  const active = (await access(activeLease, runtime, 2)).rows[0].result;
  assert.equal(active.credentialId, replacementId);
  assert.deepEqual(
    cipher.open(active.envelope, replacementContext),
    credential,
  );
  await rollback('connection-token-failed', () =>
    complete(activeLease, null, null, 'delegation-not-authorized', 2),
  );
  await complete(activeLease, null, null, 'delegation-not-authorized', 2);
  assert.equal(
    (await access(randomUUID(), second, 2)).rows[0].result.failure,
    'delegation-not-authorized',
  );
  await reset(2);
  const retryLease = randomUUID();
  await access(retryLease, runtime, 2);
  await rollback('connection-token-failed', () =>
    complete(retryLease, null, null, 'network-failure', 2),
  );
  await complete(retryLease, null, null, 'network-failure', 2);
  assert.equal(
    (await access(randomUUID(), second, 2)).rows[0].result.failure,
    'network-failure',
  );
  await migrator.query(
    "UPDATE cc.google_access_tokens SET retry_at=clock_timestamp()-interval '1 second'",
  );
  assert.equal(
    (await access(randomUUID(), second, 2)).rows[0].result.status,
    'renew',
  );
  return [
    'two replicas share one fenced renewal lease and reuse encrypted access tokens: pass',
    'token encryption binds credential, customer, generation, and payload purpose: pass',
    'failed renewal audit rolls back cache mutation and preserves its lease: pass',
    'renewal failure, token rejection, observation, and retry audit faults preserve complete token, connection, credential, and event state: pass',
    'revoked access stops automatic renewal until current operator authority permits retry: pass',
    'lease expiry and credential replacement reject late renewal and observation writes: pass',
    'transient failures require a bounded cooldown before another renewal: pass',
    'concurrent actor revocation prevents API observation and audit writes while independent workers retain service authority: pass',
  ];
}
