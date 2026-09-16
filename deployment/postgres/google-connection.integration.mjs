import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { CredentialCipher } from '../../libs/google-connection/src/lib/credential.ts';

export async function qualifyGoogleConnection({
  runtime,
  migrator,
  connect,
  issuer,
}) {
  const actors = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of actors) {
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [id, issuer, id],
    );
    await migrator.query(
      `INSERT INTO cc.application_grants(principal_id,action,scope) SELECT $1,action,'{"kind":"platform"}' FROM cc.application_actions`,
      [id],
    );
  }
  const correlation = randomUUID();
  const key = randomBytes(32);
  const cipher = new CredentialCipher('integration-key-1', key);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const credential = {
    serviceAccount: {
      type: 'service_account',
      client_id: '123456789',
      client_email: 'fixture@project.iam.gserviceaccount.com',
      private_key: privateKey,
      private_key_id: 'fixture-key',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
    subject: 'fixture@example.invalid',
  };
  const observation = (customerId = 'C0123456') => ({
    customerId,
    primaryDomain: 'example.invalid',
    domains: [
      {
        name: 'example.invalid',
        primary: true,
        verified: true,
        aliases: [{ name: 'alias.invalid', verified: true }],
      },
      {
        name: 'secondary.invalid',
        primary: false,
        verified: true,
        aliases: [],
      },
    ],
  });
  const stage = async (actor = actors[0], version = 1) => {
    const candidate = {
      id: randomUUID(),
      actor,
      version,
      browser: randomBytes(32).toString('hex'),
    };
    candidate.envelope = cipher.seal(credential, {
      recordId: candidate.id,
      customerId: null,
      generation: 0,
    });
    const result = await runtime.query(
      'SELECT cc.stage_google_credential($1,$2,$3,$4,$5,$6,$7,$8) AS result',
      [
        actor,
        version,
        candidate.id,
        candidate.browser,
        credential.serviceAccount.client_id,
        credential.subject,
        JSON.stringify(candidate.envelope),
        correlation,
      ],
    );
    assert.equal(result.rows[0].result.status, 'verifying');
    return candidate;
  };
  const finish = (
    candidate,
    value = observation(),
    failure = null,
    client = runtime,
  ) =>
    client.query('SELECT cc.finish_google_candidate($1,$2,$3,$4,$5,$6,$7)', [
      candidate.actor,
      candidate.version,
      candidate.id,
      candidate.browser,
      value && JSON.stringify(value),
      failure,
      correlation,
    ]);
  const read = (candidate) =>
    runtime.query('SELECT cc.read_google_candidate($1,$2,$3,$4) AS result', [
      candidate.actor,
      candidate.version,
      candidate.id,
      candidate.browser,
    ]);
  const confirm = (candidate, customerId = 'C0123456', client = runtime) =>
    client.query(
      'SELECT cc.confirm_google_customer($1,$2,$3,$4,$5,$6,$7) AS result',
      [
        candidate.actor,
        candidate.version,
        candidate.id,
        candidate.browser,
        customerId,
        JSON.stringify(
          cipher.seal(credential, {
            recordId: candidate.id,
            customerId,
            generation: 1,
          }),
        ),
        correlation,
      ],
    );
  const denied = (error) => error.code === '42501';
  const current = async () =>
    (await migrator.query('SELECT * FROM cc.google_connection')).rows;

  for (const table of [
    'google_credential_candidates',
    'google_credentials',
    'google_connection',
  ]) {
    await assert.rejects(runtime.query(`SELECT * FROM cc.${table}`), denied);
    await assert.rejects(runtime.query(`DELETE FROM cc.${table}`), denied);
  }
  await assert.rejects(
    runtime.query(
      "SELECT cc.google_connection_actor($1,1,'connection:manage')",
      [actors[0]],
    ),
    denied,
  );
  await assert.rejects(
    runtime.query('SELECT cc.google_envelope_valid($1)', [
      JSON.stringify(
        cipher.seal(credential, {
          recordId: randomUUID(),
          customerId: null,
          generation: 0,
        }),
      ),
    ]),
    denied,
  );
  assert.equal(
    (
      await migrator.query(
        `SELECT cc.application_scope_verified('{"kind":"district","customerId":"C0123456"}') AS value`,
      )
    ).rows[0].value,
    false,
  );
  await assert.rejects(stage(actors[0], 2), denied);

  const rejected = await stage();
  await assert.rejects(read({ ...rejected, actor: actors[1] }), denied);
  await assert.rejects(
    read({ ...rejected, browser: randomBytes(32).toString('hex') }),
    denied,
  );
  await assert.rejects(confirm(rejected));
  await assert.rejects(
    finish(rejected, { ...observation(), unexpected: 'provider-payload' }),
  );
  await finish(rejected, null, 'permission-denied');
  const failed = (
    await migrator.query(
      'SELECT status,envelope,failure FROM cc.google_credential_candidates WHERE id=$1',
      [rejected.id],
    )
  ).rows[0];
  assert.deepEqual(failed, {
    status: 'failed',
    envelope: null,
    failure: 'permission-denied',
  });
  const recoveredFailure = (await read(rejected)).rows[0].result;
  assert.equal(recoveredFailure.status, 'failed');
  assert.equal(recoveredFailure.failure, 'permission-denied');
  assert.equal(recoveredFailure.envelope, null);
  await assert.rejects(read({ ...rejected, actor: actors[1] }), denied);
  await assert.rejects(confirm(rejected));

  const revoked = await stage(actors[2]);
  await migrator.query(
    'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
    [actors[2]],
  );
  await assert.rejects(finish(revoked), denied);
  await assert.rejects(read(revoked), denied);
  await migrator.query(
    `UPDATE cc.google_credential_candidates SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE id=$1`,
    [revoked.id],
  );
  assert.equal(
    (
      await runtime.query('SELECT cc.expire_google_candidates($1) AS count', [
        correlation,
      ])
    ).rows[0].count,
    1,
  );
  const expired = (
    await migrator.query(
      'SELECT status,envelope FROM cc.google_credential_candidates WHERE id=$1',
      [revoked.id],
    )
  ).rows[0];
  assert.deepEqual(expired, { status: 'expired', envelope: null });

  // Confirmation must check the deadline after it acquires the authority lock.
  const delayed = await stage();
  await finish(delayed);
  const observer = await connect('cc-app', 'cc-app');
  const runtimePid = (await runtime.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await migrator.query('BEGIN');
  let pending;
  try {
    await migrator.query('SELECT pg_advisory_xact_lock(7240173008)');
    await migrator.query(
      `UPDATE cc.google_credential_candidates SET created_at=clock_timestamp()-interval '9 minutes',expires_at=clock_timestamp()+interval '750 milliseconds' WHERE id=$1`,
      [delayed.id],
    );
    pending = confirm(delayed).then(() => null, (error) => error);
    let waiting = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const activity = await observer.query(
        "SELECT wait_event FROM pg_stat_activity WHERE pid=$1 AND state='active'",
        [runtimePid],
      );
      if (activity.rows[0]?.wait_event === 'advisory') {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'Confirmation must wait for the authority lock.');
    await new Promise((resolve) => setTimeout(resolve, 800));
    await migrator.query('COMMIT');
  } catch (error) {
    await migrator.query('ROLLBACK');
    throw error;
  }
  assert.equal((await pending)?.detail, 'candidate-changed');
  assert.deepEqual(await current(), []);
  assert.equal((await migrator.query('SELECT count(*) FROM cc.google_credentials')).rows[0].count, '0');
  assert.equal((await migrator.query(
    "SELECT count(*) FROM cc.security_events WHERE target_id=$1 AND event IN ('customer-confirmed','connection-authorized')",
    [delayed.id],
  )).rows[0].count, '0');
  const expiredRead = (await read(delayed)).rows[0].result;
  assert.equal(expiredRead.status, 'expired');
  assert.equal(expiredRead.envelope, null);
  await runtime.query('SELECT cc.expire_google_candidates($1)', [correlation]);
  assert.equal((await read(delayed)).rows[0].result.status, 'expired');

  // Terminal history cleanup must stop at its indexed batch limit.
  await migrator.query(
    `INSERT INTO cc.google_credential_candidates(id,actor_id,actor_version,browser_hash,client_id,delegated_subject,status,failure,created_at,expires_at)
     SELECT gen_random_uuid(),$1,1,repeat('a',64),'123456789','fixture@example.invalid','failed','permission-denied',
       now()-interval '2 days',now()-interval '2 days'+interval '10 minutes' FROM generate_series(1,501)`,
    [actors[0]],
  );
  await runtime.query('SELECT cc.expire_google_candidates($1)', [correlation]);
  assert.equal((await migrator.query(
    "SELECT count(*) FROM cc.google_credential_candidates WHERE expires_at<now()-interval '1 day'",
  )).rows[0].count, '1');
  await runtime.query('SELECT cc.expire_google_candidates($1)', [correlation]);
  assert.equal((await migrator.query(
    "SELECT count(*) FROM cc.google_credential_candidates WHERE expires_at<now()-interval '1 day'",
  )).rows[0].count, '0');

  // Failed verification cannot bypass the per-actor staging rate limit.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const limited = await stage(actors[2], 2);
    await finish(limited, null, 'permission-denied');
  }
  await assert.rejects(stage(actors[2], 2), (error) => error.detail === 'busy');

  const candidates = [await stage(actors[0]), await stage(actors[1])];
  await finish(candidates[0]);
  await finish(candidates[1], observation('C7654321'));
  const preview = (await read(candidates[0])).rows[0].result;
  assert.equal(preview.status, 'ready');
  assert.deepEqual(preview.observation, observation());
  assert.deepEqual(
    new CredentialCipher('integration-key-1', key).open(preview.envelope, {
      recordId: candidates[0].id,
      customerId: null,
      generation: 0,
    }),
    credential,
  );
  await assert.rejects(finish(candidates[0]));
  await assert.rejects(confirm(candidates[0], 'C9999999'));
  await assert.rejects(
    confirm({ ...candidates[0], browser: candidates[1].browser }),
    denied,
  );

  await migrator.query(
    "ALTER TABLE cc.security_events ADD CONSTRAINT google_audit_failure CHECK(event<>'customer-confirmed') NOT VALID",
  );
  await assert.rejects(confirm(candidates[0]));
  assert.deepEqual(await current(), []);
  assert.equal((await read(candidates[0])).rows[0].result.status, 'ready');
  assert.equal(
    (await migrator.query('SELECT count(*) FROM cc.google_credentials')).rows[0]
      .count,
    '0',
  );
  await migrator.query(
    'ALTER TABLE cc.security_events DROP CONSTRAINT google_audit_failure',
  );

  const second = await connect('cc-app', 'cc-app');
  const results = await Promise.allSettled([
    confirm(candidates[0]),
    confirm(candidates[1], 'C7654321', second),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const winnerIndex = results.findIndex(
    (result) => result.status === 'fulfilled',
  );
  const winner = candidates[winnerIndex];
  const customerId = winnerIndex === 0 ? 'C0123456' : 'C7654321';
  const binding = (await current())[0];
  assert.equal(binding.customer_id, customerId);
  assert.equal(binding.credential_id, winner.id);
  assert.equal(binding.generation, 1);
  const stored = (
    await migrator.query(
      'SELECT envelope FROM cc.google_credentials WHERE id=$1',
      [winner.id],
    )
  ).rows[0].envelope;
  assert.deepEqual(
    new CredentialCipher('integration-key-1', key).open(stored, {
      recordId: winner.id,
      customerId,
      generation: 1,
    }),
    credential,
  );
  assert.throws(() =>
    cipher.open(stored, {
      recordId: winner.id,
      customerId: null,
      generation: 0,
    }),
  );
  assert.equal((await read(winner)).rows[0].result.status, 'consumed');
  assert.equal((await read(winner)).rows[0].result.envelope, null);
  await assert.rejects(confirm(winner, customerId));
  await assert.rejects(stage());
  assert.equal(
    (
      await migrator.query(
        "SELECT count(*) FROM cc.security_events WHERE event IN ('customer-confirmed','connection-authorized') AND target_id=$1",
        [winner.id],
      )
    ).rows[0].count,
    '2',
  );
  const publicConnection = (
    await runtime.query('SELECT cc.read_google_connection($1,1) AS result', [
      actors[0],
    ])
  ).rows[0].result;
  assert.equal(publicConnection.customerId, customerId);
  assert.equal('envelope' in publicConnection, false);

  const reader = randomUUID();
  await migrator.query(
    'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
    [reader, issuer, reader, reader],
  );
  const grant = {
    action: 'connection:read',
    scope: { kind: 'district', customerId },
  };
  const review = (
    await runtime.query(
      'SELECT cc.review_platform_access($1,1,$2,1,true,$3) AS result',
      [actors[0], reader, JSON.stringify([grant])],
    )
  ).rows[0].result;
  await runtime.query(
    'SELECT cc.change_platform_access($1,1,$2,1,true,$3,$4,$5)',
    [
      actors[0],
      reader,
      JSON.stringify(review.proposed.grants),
      correlation,
      '[]',
    ],
  );
  assert.equal(
    (
      await runtime.query('SELECT cc.read_google_connection($1,2) AS result', [
        reader,
      ])
    ).rows[0].result.customerId,
    customerId,
  );
  await migrator.query(
    'UPDATE cc.application_grants SET scope=$2 WHERE principal_id=$1',
    [reader, JSON.stringify({ kind: 'district', customerId: 'C9999999' })],
  );
  await assert.rejects(
    runtime.query('SELECT cc.read_google_connection($1,2)', [reader]),
    denied,
  );
  await assert.rejects(
    runtime.query('SELECT cc.review_platform_access($1,1,$2,2,true,$3)', [
      actors[0],
      reader,
      JSON.stringify([
        {
          action: 'connection:read',
          scope: { kind: 'district', customerId: 'C9999999' },
        },
      ]),
    ]),
    denied,
  );
  assert.equal(JSON.stringify(publicConnection).includes(privateKey), false);
  return [
    'candidate staging binds actor version and browser without runtime table access: pass',
    'failed and expired candidates erase ciphertext with security events and retain authorized recovery metadata: pass',
    'confirmation checks wall-clock expiry after lock contention and leaves no activation records: pass',
    'terminal cleanup uses 500-row batches and staging rate limits include failed checks: pass',
    'revoked authority cannot finish verification or read staged credentials: pass',
    'customer confirmation rejects replay, wrong customer, and cross-browser substitution: pass',
    'audit failure rolls back customer, active credential, and candidate consumption: pass',
    'concurrent first connections bind exactly one customer and credential generation: pass',
    'encrypted candidate and active credentials recover with independent keys and exact context: pass',
    'district grants require the confirmed customer and reject cross-customer reads: pass',
  ];
}
