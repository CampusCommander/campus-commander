import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { CredentialCipher } from '../../dist/deployment/google-runtime.mjs';
import { revalidateGoogleRestore } from './google-restore.mjs';

const preservedTables = [
  'google_connection',
  'google_credentials',
  'customer_settings_revisions',
  'school_definitions',
  'application_grants',
  'application_principals',
];
async function inventory(client) {
  const records = {};
  for (const table of preservedTables) {
    const rows = (
      await client.query(`SELECT row_to_json(t) AS value FROM cc.${table} t`)
    ).rows
      .map(({ value }) => JSON.stringify(value))
      .sort();
    records[table] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  const references = (
    await client.query(
      'SELECT observation,observed_at,failure,checked_at,correlation_id FROM cc.school_reference_state ORDER BY customer_id',
    )
  ).rows;
  records.school_reference_history = {
    count: references.length,
    sha256: createHash('sha256')
      .update(JSON.stringify(references))
      .digest('hex'),
  };
  return records;
}

/** Seed durable customer state through the same database commands used by the application. */
export async function seedPhase3State(client, actor, permissionVersion) {
  const customerId = 'C0123456',
    candidateId = randomUUID();
  const key = randomBytes(32),
    keyId = 'independent-google-recovery-key';
  const cipher = new CredentialCipher(keyId, key);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const credential = {
    serviceAccount: {
      type: 'service_account',
      client_id: '123456789',
      client_email: 'restore@fixture.iam.gserviceaccount.com',
      private_key: privateKey,
      private_key_id: 'synthetic-restore-key',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
    subject: 'restore-admin@example.invalid',
  };
  const observation = {
    customerId,
    primaryDomain: 'example.invalid',
    domains: [
      { name: 'example.invalid', primary: true, verified: true, aliases: [] },
    ],
  };
  const correlation = randomUUID(),
    browser = randomBytes(32).toString('hex');
  await client.query(
    'SELECT cc.stage_google_credential($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      actor,
      permissionVersion,
      candidateId,
      browser,
      credential.serviceAccount.client_id,
      credential.subject,
      JSON.stringify(
        cipher.seal(credential, {
          recordId: candidateId,
          customerId: null,
          generation: 0,
        }),
      ),
      correlation,
    ],
  );
  await client.query(
    'SELECT cc.finish_google_candidate($1,$2,$3,$4,$5,NULL,$6)',
    [
      actor,
      permissionVersion,
      candidateId,
      browser,
      JSON.stringify(observation),
      correlation,
    ],
  );
  await client.query(
    'SELECT cc.confirm_google_customer($1,$2,$3,$4,$5,$6,$7)',
    [
      actor,
      permissionVersion,
      candidateId,
      browser,
      customerId,
      JSON.stringify(
        cipher.seal(credential, {
          recordId: candidateId,
          customerId,
          generation: 1,
        }),
      ),
      correlation,
    ],
  );
  // Confirmation uses the candidate identity for the first committed credential.
  assert.equal(
    (await client.query('SELECT credential_id FROM cc.google_connection'))
      .rows[0].credential_id,
    candidateId,
  );
  const request = randomUUID();
  const settingsReceipt = (
    await client.query(
      'SELECT cc.save_customer_settings($1,$2,$3,0,$4,$5,$6) AS result',
      [
        actor,
        permissionVersion,
        customerId,
        request,
        '{"displayName":"École Restore 学校"}',
        correlation,
      ],
    )
  ).rows[0].result;
  const referenceLease = randomUUID();
  await client.query('SELECT cc.claim_school_references($1,$2,$3,1,$4,$5)', [
    actor,
    permissionVersion,
    customerId,
    referenceLease,
    correlation,
  ]);
  const reference = {
    customerId,
    generation: 1,
    revision: randomUUID(),
    observedAt: new Date().toISOString(),
    verified: true,
    complete: true,
    units: [
      { id: 'root', name: 'Root', path: '/', parentId: null },
      { id: 'school', name: 'School', path: '/School', parentId: 'root' },
    ],
  };
  const references = (
    await client.query(
      'SELECT cc.finish_school_references($1,$2,$3,1,$4,$5,NULL) AS result',
      [
        actor,
        permissionVersion,
        customerId,
        referenceLease,
        JSON.stringify(reference),
      ],
    )
  ).rows[0].result;
  const schoolId = randomUUID(),
    rules = { include: [{ id: 'school', descendants: true }], exclude: [] };
  const preview = async (id, expected, name) =>
    (
      await client.query(
        'SELECT cc.preview_school_definition($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
        [
          actor,
          permissionVersion,
          id,
          customerId,
          expected,
          references.observation.revision,
          name,
          JSON.stringify(rules),
          randomUUID(),
          correlation,
        ],
      )
    ).rows[0].result;
  const review = await preview(schoolId, 0, 'École Restore');
  await client.query('SELECT cc.confirm_school_definition($1,$2,$3)', [
    actor,
    permissionVersion,
    review.id,
  ]);
  const pendingReview = await preview(schoolId, 1, 'Pending school name');
  await client.query(
    'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
    [
      actor,
      'schools:read',
      JSON.stringify({ kind: 'school', customerId, schoolId }),
    ],
  );
  const pendingId = randomUUID();
  await client.query(
    'SELECT cc.stage_google_replacement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      actor,
      permissionVersion,
      pendingId,
      browser,
      credential.serviceAccount.client_id,
      credential.subject,
      JSON.stringify(
        cipher.seal(credential, {
          recordId: pendingId,
          customerId: null,
          generation: 0,
        }),
      ),
      correlation,
      customerId,
      1,
    ],
  );
  await client.query('SELECT cc.acquire_google_access($1,1,$2)', [
    customerId,
    randomUUID(),
  ]);
  await client.query('SELECT cc.claim_google_health($1,$2,$3,1,$4,$5,$6)', [
    actor,
    permissionVersion,
    customerId,
    randomUUID(),
    '["customer-identity","domain-observations"]',
    correlation,
  ]);
  const initial = await inventory(client);
  const source = {
    actor,
    permissionVersion,
    customerId,
    keyId,
    key,
    credentialId: candidateId,
    schoolId,
    request,
    settingsReceipt,
    pendingId,
    pendingReview: pendingReview.id,
    observation,
    initial,
  };
  return source;
}

/** Compare hashes before revalidation changes the current Google observation. */
export async function verifyPhase3State(
  client,
  runtime,
  source,
  accessRecovery,
  backupKey,
  { deferRevalidation = false } = {},
) {
  const current = await inventory(client);
  assert.deepEqual(current, source.initial);
  const google = accessRecovery.googleConnection;
  assert.equal(google.status, 'revalidation-required');
  assert.equal(google.customerId, source.customerId);
  assert.equal(google.generation, 1);
  assert.equal(accessRecovery.credentialCandidatesExpired, 1);
  assert.equal(accessRecovery.schoolReviewsExpired, 1);
  assert.deepEqual(
    (
      await client.query(
        'SELECT status,envelope FROM cc.google_credential_candidates WHERE id=$1',
        [source.pendingId],
      )
    ).rows[0],
    { status: 'expired', envelope: null },
  );
  assert.equal(
    (
      await client.query(
        'SELECT expires_at<=clock_timestamp() AS expired FROM cc.school_reviews WHERE id=$1',
        [source.pendingReview],
      )
    ).rows[0].expired,
    true,
  );
  assert.deepEqual(
    (
      await runtime.query(
        'SELECT cc.read_customer_settings_receipt($1,$2,$3) AS result',
        [source.actor, source.permissionVersion, source.request],
      )
    ).rows[0].result,
    source.settingsReceipt,
  );
  const school = (
    await runtime.query(
      'SELECT cc.read_school_definition($1,$2,$3) AS result',
      [source.actor, source.permissionVersion, source.schoolId],
    )
  ).rows[0].result;
  assert.deepEqual(school.approvedIds, ['school']);
  assert.equal(school.effectiveIds, null);
  await assert.rejects(
    runtime.query('SELECT cc.acquire_google_access($1,1,$2)', [
      source.customerId,
      randomUUID(),
    ]),
    (error) => error.detail === 'restore-revalidation-required',
  );
  for (const table of ['google_access_tokens', 'google_health_checks'])
    assert.equal(
      (await client.query(`SELECT count(*)::int AS count FROM cc.${table}`))
        .rows[0].count,
      0,
    );
  await assert.rejects(
    runtime.query('SELECT cc.confirm_school_definition($1,$2,$3)', [
      source.actor,
      source.permissionVersion,
      source.pendingReview,
    ]),
    (error) => error.detail === 'school-changed',
  );
  const stateProof = {
    preserved: current,
    oldSettingsReceiptPreserved: true,
    approvedSchoolScopePreserved: true,
    oldSchoolReferencesEffective: false,
    pendingCandidatesExpired: 1,
    pendingReviewsExpired: 1,
  };
  if (deferRevalidation)
    return { ...stateProof, status: 'preserved-awaiting-revalidation' };
  const options = {
    client,
    recoveryId: google.recoveryId,
    keyConfiguration: {
      keyId: source.keyId,
      encryptionKeySecretRef: {
        provider: 'file',
        path: '/run/secrets/google-recovery-key',
      },
    },
    resolveSecret: async () => source.key,
    verifier: {
      async verify(value) {
        assert.equal(value.subject, 'restore-admin@example.invalid');
        return source.observation;
      },
    },
  };
  for (const [overrides, expected] of [
    [{ keyConfiguration: undefined }, /key is unavailable/],
    [{ resolveSecret: async () => backupKey }, /key verification failed/],
    [
      {
        verifier: {
          async verify() {
            return { ...source.observation, customerId: 'Cwrong01' };
          },
        },
      },
      /customer verification failed/,
    ],
  ]) {
    await assert.rejects(
      revalidateGoogleRestore({ ...options, ...overrides }),
      expected,
    );
    assert.deepEqual(await inventory(client), current);
    assert.equal(
      (await client.query('SELECT verified_at FROM cc.google_restore_gate'))
        .rows[0].verified_at,
      null,
    );
  }
  const revalidation = await revalidateGoogleRestore(options);
  assert.equal(revalidation.status, 'revalidated');
  assert.equal(
    (
      await runtime.query(
        'SELECT cc.acquire_google_access($1,1,$2) AS result',
        [source.customerId, randomUUID()],
      )
    ).rows[0].result.status,
    'renew',
  );
  return {
    status: 'passed',
    ...stateProof,
    exactRecoveredKeyVerified: true,
    backupKeyCannotDecryptGoogleCredential: true,
    wrongCustomerRejected: true,
    revalidation: {
      status: revalidation.status,
      customerId: revalidation.customerId,
      generation: revalidation.generation,
    },
    provider: 'synthetic verifier, real restored ciphertext and PostgreSQL',
    limits: [
      'This fixture invokes the revalidation library. It does not qualify the revalidation CLI or live Google privileges.',
    ],
  };
}
