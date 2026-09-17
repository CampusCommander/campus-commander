import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { CredentialCipher } from '../../libs/google-connection/src/lib/credential.ts';
import { GoogleConnectionProvider } from '../../libs/google-connection/src/lib/coordinator.ts';

export async function qualifyGoogleLifecycle({
  runtime,
  migrator,
  connect,
  issuer,
}) {
  const other = await connect('cc-app', 'cc-app');
  const initial = (await migrator.query('SELECT * FROM cc.google_connection'))
    .rows[0];
  const customer = initial.customer_id;
  const actor = randomUUID(),
    reader = randomUUID();
  const correlation = randomUUID(),
    browser = randomBytes(32).toString('hex');
  for (const id of [actor, reader]) {
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [id, issuer, id],
    );
    for (const action of id === actor
      ? ['connection:read', 'connection:manage', 'connection:diagnose']
      : ['connection:read'])
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [id, action, '{"kind":"platform"}'],
      );
  }
  const key = randomBytes(32),
    nextKey = randomBytes(32);
  const cipher = new CredentialCipher(initial.encryption_key_id, key, [
    { keyId: 'rotation-key-2', key: nextKey },
  ]);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const credential = {
    subject: 'replacement@example.invalid',
    serviceAccount: {
      type: 'service_account',
      client_id: '123456789',
      client_email: 'fixture@project.iam.gserviceaccount.com',
      private_key: privateKey,
      private_key_id: 'replacement-key',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
  };
  const denied = (error) => error.code === '42501';
  const changed = (error) =>
    error.code === 'P0001' &&
    ['candidate-changed', 'credential-changed'].includes(error.detail);
  const management = async (who = actor, version = 1) =>
    (
      await runtime.query(
        'SELECT cc.read_google_credential_management($1,$2) AS result',
        [who, version],
      )
    ).rows[0].result;
  const stage = async (generation, client = runtime) => {
    const id = randomUUID();
    const envelope = cipher.seal(credential, {
      recordId: id,
      customerId: null,
      generation: 0,
    });
    await client.query(
      'SELECT cc.stage_google_replacement($1,1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        actor,
        id,
        browser,
        '123456789',
        credential.subject,
        JSON.stringify(envelope),
        correlation,
        customer,
        generation,
      ],
    );
    return id;
  };
  const finish = (id, observation = initial.observation, failure = null) =>
    runtime.query('SELECT cc.finish_google_candidate($1,1,$2,$3,$4,$5,$6)', [
      actor,
      id,
      browser,
      observation && JSON.stringify(observation),
      failure,
      correlation,
    ]);
  const candidate = async (id) =>
    (
      await runtime.query(
        'SELECT cc.read_google_candidate($1,1,$2,$3) AS result',
        [actor, id, browser],
      )
    ).rows[0].result;
  const activate = (
    id,
    generation,
    client = runtime,
    who = actor,
    version = 1,
  ) =>
    client.query(
      'SELECT cc.activate_google_replacement($1,$2,$3,$4,$5,$6,$7,$8) AS result',
      [
        who,
        version,
        id,
        browser,
        customer,
        generation,
        JSON.stringify(
          cipher.seal(credential, {
            recordId: id,
            customerId: customer,
            generation: generation + 1,
          }),
        ),
        correlation,
      ],
    );
  const rotate = (current, client = runtime) => {
    const id = randomUUID();
    const opened = cipher.open(current.envelope, {
      recordId: current.credentialId,
      customerId: customer,
      generation: current.generation,
    });
    const envelope = cipher.forKey('rotation-key-2').seal(opened, {
      recordId: id,
      customerId: customer,
      generation: current.generation + 1,
    });
    return client.query(
      'SELECT cc.rotate_google_credential_key($1,1,$2,$3,$4,$5,$6) AS result',
      [
        actor,
        customer,
        current.generation,
        id,
        JSON.stringify(envelope),
        correlation,
      ],
    );
  };
  try {
    await assert.rejects(management(reader), denied);
    for (const sql of [
      'SELECT cc.google_bound_generation($1,$2)',
      'SELECT * FROM cc.google_credentials WHERE customer_id=$1 AND generation=$2',
    ])
      await assert.rejects(
        runtime.query(sql, [customer, initial.generation]),
        denied,
      );
    const baseline = await management();
    const wrong = await stage(initial.generation);
    await finish(wrong, { ...initial.observation, customerId: 'C9999999' });
    assert.equal((await candidate(wrong)).failure, 'wrong-customer');
    assert.equal((await candidate(wrong)).envelope, null);
    assert.deepEqual(await management(), baseline);
    const failed = await stage(initial.generation);
    await finish(failed, null, 'permission-denied');
    assert.equal((await candidate(failed)).envelope, null);
    assert.deepEqual(await management(), baseline);
    const id = await stage(initial.generation);
    await finish(id);
    await assert.rejects(
      activate(id, initial.generation, runtime, reader),
      denied,
    );
    await migrator.query(
      "ALTER TABLE cc.security_events ADD CONSTRAINT lifecycle_audit_failure CHECK(event<>'connection-replaced') NOT VALID",
    );
    await assert.rejects(activate(id, initial.generation));
    assert.deepEqual(await management(), baseline);
    assert.equal((await candidate(id)).status, 'ready');
    await migrator.query(
      'ALTER TABLE cc.security_events DROP CONSTRAINT lifecycle_audit_failure',
    );
    await migrator.query(
      'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
      [actor],
    );
    await assert.rejects(activate(id, initial.generation), denied);
    await migrator.query(
      'UPDATE cc.application_principals SET permission_version=1 WHERE id=$1',
      [actor],
    );
    // Both API replicas verify a candidate before either activates it.
    const competitor = await stage(initial.generation, other);
    await finish(competitor);
    const activated = await Promise.allSettled([
      activate(id, initial.generation),
      activate(competitor, initial.generation, other),
    ]);
    assert.equal(
      activated.filter((value) => value.status === 'fulfilled').length,
      1,
    );
    let current = await management();
    assert.equal(current.generation, initial.generation + 1);
    assert.equal(current.customerId, customer);
    assert.deepEqual(
      cipher.open(current.envelope, {
        recordId: current.credentialId,
        customerId: customer,
        generation: current.generation,
      }),
      credential,
    );
    assert.equal(
      (
        await migrator.query(
          'SELECT count(*)::int AS count FROM cc.google_credentials WHERE id=$1',
          [initial.credential_id],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await migrator.query(
          'SELECT count(*)::int AS count FROM cc.google_credential_candidates WHERE envelope IS NOT NULL',
        )
      ).rows[0].count,
      0,
    );
    await assert.rejects(
      runtime.query('SELECT cc.acquire_google_access($1,$2,$3)', [
        customer,
        initial.generation,
        randomUUID(),
      ]),
      changed,
    );
    await assert.rejects(
      runtime.query('SELECT cc.record_google_observation($1,$2,$3,$4)', [
        customer,
        initial.generation,
        JSON.stringify(initial.observation),
        correlation,
      ]),
      changed,
    );

    // Hold a renewal across rotation. Its completion cannot overwrite the new generation.
    const oldGeneration = current.generation;
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const token = {
      accessToken: 'ya29.lifecycle-fixture',
      expiresAt: Date.now() + 3_500_000,
      scopeProfile: 'customer-domain-v1',
    };
    const provider = new GoogleConnectionProvider(other, cipher, {
      async renew() {
        entered.resolve();
        await release.promise;
        return token;
      },
      async observe() {
        return initial.observation;
      },
    });
    const stale = assert.rejects(
      provider.read({
        customerId: customer,
        generation: oldGeneration,
        correlationId: correlation,
      }),
      { code: 'credential-changed' },
    );
    await entered.promise;
    await migrator.query(
      "ALTER TABLE cc.security_events ADD CONSTRAINT rotation_audit_failure CHECK(event<>'credential-key-rotated') NOT VALID",
    );
    await assert.rejects(rotate(current));
    assert.deepEqual(await management(), current);
    await migrator.query(
      'ALTER TABLE cc.security_events DROP CONSTRAINT rotation_audit_failure',
    );
    await rotate(current);
    release.resolve();
    await stale;
    current = await management();
    assert.equal(current.keyId, 'rotation-key-2');
    assert.equal(current.generation, oldGeneration + 1);
    const context = {
      recordId: current.credentialId,
      customerId: customer,
      generation: current.generation,
    };
    assert.deepEqual(
      new CredentialCipher('rotation-key-2', nextKey).open(
        current.envelope,
        context,
      ),
      credential,
    );
    assert.throws(
      () =>
        new CredentialCipher(initial.encryption_key_id, key).open(
          current.envelope,
          context,
        ),
      { code: 'key-unavailable' },
    );
    let renewals = 0;
    const verifier = {
      async renew() {
        renewals++;
        return token;
      },
      async observe() {
        return initial.observation;
      },
    };
    await new GoogleConnectionProvider(runtime, cipher, verifier).read({
      customerId: customer,
      generation: current.generation,
      correlationId: correlation,
    });
    assert.equal(
      (await migrator.query('SELECT envelope FROM cc.google_access_tokens'))
        .rows[0].envelope.keyId,
      'rotation-key-2',
    );
    await new GoogleConnectionProvider(
      other,
      new CredentialCipher('rotation-key-2', nextKey),
      verifier,
    ).read({
      customerId: customer,
      generation: current.generation,
      correlationId: correlation,
    });
    assert.equal(renewals, 1);
    const beforeDisconnect = await management();
    const disconnect = () =>
      runtime.query(
        'SELECT cc.disconnect_google_credential($1,1,$2,$3,$4,$5)',
        [actor, customer, current.generation, randomUUID(), correlation],
      );
    await migrator.query(
      "ALTER TABLE cc.security_events ADD CONSTRAINT disconnect_audit_failure CHECK(event<>'connection-revoked') NOT VALID",
    );
    await assert.rejects(disconnect());
    assert.deepEqual(await management(), beforeDisconnect);
    await migrator.query(
      'ALTER TABLE cc.security_events DROP CONSTRAINT disconnect_audit_failure',
    );
    await disconnect();
    const disconnected = await management();
    assert.equal(disconnected.active, false);
    assert.equal(disconnected.envelope, null);
    assert.equal(disconnected.customerId, customer);
    await assert.rejects(
      runtime.query('SELECT cc.acquire_google_access($1,$2,$3)', [
        customer,
        disconnected.generation,
        randomUUID(),
      ]),
      (error) => error.detail === 'connection-disconnected',
    );
    assert.equal(
      (
        await migrator.query(
          'SELECT count(*)::int AS count FROM cc.google_access_tokens',
        )
      ).rows[0].count,
      0,
    );
    const health = (
      await runtime.query('SELECT cc.read_google_health($1,1) AS result', [
        actor,
      ])
    ).rows[0].result;
    assert.equal(health.connectionState, 'disconnected');
    assert.ok(
      health.capabilities.every(
        (value) => value.failure !== 'credential-rejected',
      ),
    );
    assert.equal(
      (
        await runtime.query(
          'SELECT cc.read_google_connection($1,1) AS result',
          [reader],
        )
      ).rows[0].result.customerId,
      customer,
    );
    // Same-customer reconnection works after disconnect without replacing customer settings.
    const reconnect = await stage(disconnected.generation);
    await finish(reconnect);
    const envelope = cipher.forKey('rotation-key-2').seal(credential, {
      recordId: reconnect,
      customerId: customer,
      generation: disconnected.generation + 1,
    });
    await runtime.query(
      'SELECT cc.activate_google_replacement($1,1,$2,$3,$4,$5,$6,$7)',
      [
        actor,
        reconnect,
        browser,
        customer,
        disconnected.generation,
        JSON.stringify(envelope),
        correlation,
      ],
    );
    assert.equal((await management()).active, true);
    assert.equal((await management()).customerId, customer);
    const events = (
      await migrator.query(
        "SELECT event FROM cc.security_events WHERE correlation_id=$1 AND event IN ('connection-replaced','credential-key-rotated','connection-revoked')",
        [correlation],
      )
    ).rows;
    assert.equal(
      events.filter((value) => value.event === 'connection-replaced').length,
      2,
    );
    assert.equal(
      events.filter((value) => value.event === 'credential-key-rotated').length,
      1,
    );
    assert.equal(
      events.filter((value) => value.event === 'connection-revoked').length,
      1,
    );
    return [
      'replacement failures and wrong customers preserve the working encrypted credential: pass',
      'replicas activate one reviewed replacement with current authority and atomic audit: pass',
      'replacement erases retired credentials and staged ciphertext: pass',
      'rotation rolls back on audit failure and rejects a renewal from the retired generation: pass',
      'independent restarted consumers use the committed encryption key and shared token: pass',
      'local disconnect erases credential material, preserves ownership, and rejects reads: pass',
      'same-customer reconnection preserves the installation and retains security events: pass',
    ];
  } finally {
    await other.end();
  }
}
