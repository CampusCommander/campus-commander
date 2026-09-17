import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  prepareGoogleRestore,
  revalidateGoogleRestore,
} from '../operations/google-restore.mjs';
import { GoogleConnectionProvider } from '../../libs/google-connection/src/lib/coordinator.ts';
import { GoogleConnectionError } from '../../libs/google-connection/src/lib/provider.ts';

export async function qualifyGoogleRestore({
  runtime,
  migrator,
  key,
  cipher,
  credential,
  customerId,
  actor,
  observation,
}) {
  const { credential_id: credentialId, generation } = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const recoveryId = randomUUID(),
    candidate = randomUUID(),
    review = randomUUID(),
    lease = randomUUID();
  const reference = { provider: 'file', path: '/fixture/recovered-key' };
  const keyConfiguration = {
    keyId: 'new-primary',
    encryptionKeySecretRef: { provider: 'file', path: '/fixture/new-primary' },
    additionalKeys: [
      { keyId: 'integration-key-1', encryptionKeySecretRef: reference },
    ],
  };
  await migrator.query(
    `INSERT INTO cc.google_credential_candidates
    (id,actor_id,actor_version,browser_hash,client_id,delegated_subject,status,envelope)
    VALUES($1,$2,1,$3,$4,$5,'verifying',$6)`,
    [
      candidate,
      actor,
      randomBytes(32).toString('hex'),
      credential.serviceAccount.client_id,
      credential.subject,
      JSON.stringify(
        cipher.seal(credential, {
          recordId: candidate,
          customerId: null,
          generation: 0,
        }),
      ),
    ],
  );
  await migrator.query(
    `INSERT INTO cc.school_reviews
    (id,actor_id,actor_version,school_id,customer_id,expected_revision,reference_revision,name,rules,approved_ids,affected_principals,created_at,expires_at,correlation_id)
    VALUES($1,$2,1,$3,$4,0,$5,'Restore fixture','{}','[]','[]',clock_timestamp(),clock_timestamp()+interval '5 minutes',$5)`,
    [review, actor, randomUUID(), customerId, randomUUID()],
  );
  const units = [{ id: 'root', name: 'Root', path: '/', parentId: null }];
  const references = {
    customerId,
    generation,
    revision: randomUUID(),
    observedAt: new Date().toISOString(),
    verified: true,
    complete: true,
    units,
  };
  await migrator.query(
    `INSERT INTO cc.school_reference_state
    (customer_id,observation,observed_at,lease_id,lease_actor,lease_version,lease_generation,lease_expires_at)
    VALUES($1,$2,clock_timestamp(),$3,$4,1,$5,clock_timestamp()+interval '40 seconds')`,
    [customerId, JSON.stringify(references), lease, actor, generation],
  );
  await runtime.query('SELECT cc.claim_google_health($1,1,$2,$3,$4,$5,$6)', [
    actor,
    customerId,
    generation,
    randomUUID(),
    '["customer-identity"]',
    randomUUID(),
  ]);
  const snapshot = async () =>
    (
      await migrator.query(`
    SELECT 'gate' AS relation,md5(row_to_json(t)::text) AS state FROM cc.google_restore_gate t
    UNION ALL SELECT 'connection',md5(row_to_json(t)::text) FROM cc.google_connection t
    UNION ALL SELECT 'credential',md5(row_to_json(t)::text) FROM cc.google_credentials t
    UNION ALL SELECT 'candidate',md5(row_to_json(t)::text) FROM cc.google_credential_candidates t
    UNION ALL SELECT 'token',md5(row_to_json(t)::text) FROM cc.google_access_tokens t
    UNION ALL SELECT 'health',md5(row_to_json(t)::text) FROM cc.google_health_checks t
    UNION ALL SELECT 'reference',md5(row_to_json(t)::text) FROM cc.school_reference_state t
    UNION ALL SELECT 'review',md5(row_to_json(t)::text) FROM cc.school_reviews t
    UNION ALL SELECT 'event',md5(row_to_json(t)::text) FROM cc.security_events t
    ORDER BY relation,state`)
    ).rows;
  const prepare = async () => {
    await migrator.query('BEGIN');
    try {
      await migrator.query('SELECT pg_advisory_xact_lock(7240173008)');
      const result = await prepareGoogleRestore(migrator, recoveryId);
      await migrator.query('COMMIT');
      return result;
    } catch (error) {
      await migrator.query('ROLLBACK');
      throw error;
    }
  };
  const auditRollback = async (detail, action) => {
    assert.ok(
      ['restore-google-blocked', 'restore-revalidated'].includes(detail),
    );
    const before = await snapshot();
    await migrator.query(
      `ALTER TABLE cc.security_events ADD CONSTRAINT google_restore_audit_failure CHECK(detail IS DISTINCT FROM '${detail}') NOT VALID`,
    );
    try {
      await assert.rejects(
        action(),
        (error) =>
          error.code === '23514' &&
          error.constraint === 'google_restore_audit_failure',
      );
      assert.deepEqual(await snapshot(), before);
    } finally {
      await migrator.query(
        'ALTER TABLE cc.security_events DROP CONSTRAINT google_restore_audit_failure',
      );
    }
  };
  await auditRollback('restore-google-blocked', prepare);
  const prepared = await prepare();
  assert.equal(prepared.googleConnection.recoveryId, recoveryId);
  assert.ok(prepared.credentialCandidatesExpired >= 1);
  assert.equal(prepared.schoolReviewsExpired, 1);
  assert.deepEqual(
    (
      await migrator.query(
        'SELECT status,envelope FROM cc.google_credential_candidates WHERE id=$1',
        [candidate],
      )
    ).rows[0],
    { status: 'expired', envelope: null },
  );
  assert.equal(
    (
      await migrator.query(
        'SELECT expires_at<=clock_timestamp() AS expired FROM cc.school_reviews WHERE id=$1',
        [review],
      )
    ).rows[0].expired,
    true,
  );
  for (const table of ['google_access_tokens', 'google_health_checks'])
    assert.equal(
      (await migrator.query(`SELECT count(*)::int AS count FROM cc.${table}`))
        .rows[0].count,
      0,
    );
  assert.equal(
    (await migrator.query('SELECT lease_id FROM cc.school_reference_state'))
      .rows[0].lease_id,
    null,
  );
  for (const sql of [
    'SELECT * FROM cc.google_restore_gate',
    'UPDATE cc.google_restore_gate SET verified_at=clock_timestamp()',
  ])
    await assert.rejects(runtime.query(sql), (error) => error.code === '42501');
  const blocked = (error) => error.detail === 'restore-revalidation-required';
  for (const [sql, args] of [
    [
      'SELECT cc.acquire_google_access($1,$2,$3)',
      [customerId, generation, randomUUID()],
    ],
    [
      'SELECT cc.record_google_observation($1,$2,$3,$4)',
      [
        customerId,
        generation,
        JSON.stringify(observation(customerId)),
        randomUUID(),
      ],
    ],
    [
      'SELECT cc.claim_google_health($1,1,$2,$3,$4,$5,$6)',
      [
        actor,
        customerId,
        generation,
        randomUUID(),
        '["customer-identity"]',
        randomUUID(),
      ],
    ],
    [
      'SELECT cc.claim_school_references($1,1,$2,$3,$4,$5)',
      [actor, customerId, generation, randomUUID(), randomUUID()],
    ],
    [
      'SELECT cc.finish_school_references($1,1,$2,$3,$4,$5,NULL)',
      [actor, customerId, generation, lease, JSON.stringify(references)],
    ],
  ])
    await assert.rejects(runtime.query(sql, args), blocked);
  let calls = 0;
  const provider = new GoogleConnectionProvider(runtime, cipher, {
    async renew() {
      calls++;
      return {
        accessToken: 'ya29.restore-fixture',
        expiresAt: Date.now() + 3_500_000,
        scopeProfile: 'customer-domain-v1',
      };
    },
    async observe() {
      calls++;
      return observation(customerId);
    },
  });
  const input = { customerId, generation, correlationId: randomUUID() };
  await assert.rejects(provider.read(input), {
    code: 'connection-store-unavailable',
  });
  assert.equal(calls, 0);
  const options = {
    client: migrator,
    recoveryId,
    keyConfiguration,
    async resolveSecret(ref) {
      assert.deepEqual(ref, reference);
      return key;
    },
    verifier: {
      async verify(value) {
        assert.equal(
          value.serviceAccount.client_id,
          credential.serviceAccount.client_id,
        );
        assert.equal(value.subject, credential.subject);
        return observation(customerId);
      },
    },
  };
  const unchanged = async (overrides, predicate) => {
    const before = await snapshot();
    await assert.rejects(
      revalidateGoogleRestore({ ...options, ...overrides }),
      predicate,
    );
    assert.deepEqual(await snapshot(), before);
  };
  await unchanged({ recoveryId: randomUUID() }, /credential state changed/);
  await unchanged(
    { keyConfiguration: { ...keyConfiguration, additionalKeys: [] } },
    /key is unavailable/,
  );
  await unchanged(
    { resolveSecret: async () => randomBytes(32) },
    /key verification failed/,
  );
  for (const code of ['delegation-not-authorized', 'permission-denied'])
    await unchanged(
      {
        verifier: {
          async verify() {
            throw new GoogleConnectionError(code);
          },
        },
      },
      { code },
    );
  await unchanged(
    {
      verifier: {
        async verify() {
          return observation('C9999999');
        },
      },
    },
    /customer verification failed/,
  );
  await auditRollback('restore-revalidated', () =>
    revalidateGoogleRestore(options),
  );
  const result = await revalidateGoogleRestore(options);
  assert.equal(result.status, 'revalidated');
  assert.equal(result.customerId, customerId);
  assert.equal(result.generation, generation);
  assert.equal(
    (await migrator.query('SELECT cc.school_reference_projection() AS result'))
      .rows[0].result.fresh,
    false,
  );
  const beforeRepeat = await snapshot();
  const repeated = await revalidateGoogleRestore({
    ...options,
    verifier: {
      async verify() {
        assert.fail('Repeated receipt must not claim a new provider check.');
      },
    },
  });
  assert.equal(repeated.status, 'already-revalidated');
  assert.equal(repeated.verifiedAt, result.verifiedAt);
  assert.deepEqual(await snapshot(), beforeRepeat);
  assert.equal((await provider.read(input)).customerId, customerId);
  assert.equal(calls, 2);
  const refreshed = randomUUID();
  await runtime.query('SELECT cc.claim_school_references($1,1,$2,$3,$4,$5)', [
    actor,
    customerId,
    generation,
    refreshed,
    randomUUID(),
  ]);
  await runtime.query(
    'SELECT cc.finish_school_references($1,1,$2,$3,$4,$5,NULL)',
    [actor, customerId, generation, refreshed, JSON.stringify(references)],
  );
  assert.equal(
    (await migrator.query('SELECT cc.school_reference_projection() AS result'))
      .rows[0].result.fresh,
    true,
  );
  assert.equal(
    (await migrator.query('SELECT credential_id FROM cc.google_connection'))
      .rows[0].credential_id,
    credentialId,
  );
  // Later fixtures exercise credential replacement with the verified restore gate present.
  await migrator.query('DELETE FROM cc.school_reference_state');
  await migrator.query('DELETE FROM cc.school_reviews WHERE id=$1', [review]);
  return [
    'restore invalidates pending credentials, school reviews, token caches, and leases atomically with audit: pass',
    'runtime roles cannot open the restore gate or start Google reads before revalidation: pass',
    'missing keys, wrong keys, provider denial, wrong customers, and audit failures preserve the closed restore gate: pass',
    'the recorded recovery key verifies the same customer and opens the gate without changing credential generation: pass',
    'restored school references remain historical until a new reference check succeeds: pass',
    'repeated revalidation returns the original receipt without new provider evidence: pass',
  ];
}
