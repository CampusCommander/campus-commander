import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function qualifyGoogleHealth({
  runtime,
  migrator,
  connect,
  issuer,
}) {
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const { customer_id: customerId, generation } = connection;
  const actor = randomUUID(),
    reader = randomUUID(),
    outsider = randomUUID();
  for (const id of [actor, reader, outsider]) {
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [id, issuer, id],
    );
    for (const action of id === reader
      ? ['connection:read']
      : ['connection:read', 'connection:diagnose'])
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [
          id,
          action,
          JSON.stringify({
            kind: 'district',
            customerId: id === outsider ? 'C9999999' : customerId,
          }),
        ],
      );
  }
  const read = async (id = actor, version = 1) =>
    (
      await runtime.query('SELECT cc.read_google_health($1,$2) AS result', [
        id,
        version,
      ])
    ).rows[0].result;
  const claim = async (
    capabilities = ['customer-identity', 'domain-observations'],
    id = actor,
    version = 1,
    client = runtime,
  ) =>
    (
      await client.query(
        'SELECT cc.claim_google_health($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          id,
          version,
          customerId,
          generation,
          randomUUID(),
          JSON.stringify(capabilities),
          randomUUID(),
        ],
      )
    ).rows[0].result;
  const finish = async (lease, results, observation = null, version = 1) =>
    (
      await runtime.query(
        'SELECT cc.finish_google_health($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          actor,
          version,
          customerId,
          generation,
          lease.id,
          JSON.stringify(results),
          observation ? JSON.stringify(observation) : null,
        ],
      )
    ).rows[0].result;
  const clearWindow = () =>
    migrator.query(
      "UPDATE cc.google_health_checks SET expires_at=clock_timestamp()-interval '1 second',retry_at=clock_timestamp()-interval '1 second'",
    );
  const denied = (error) => error.code === '42501';
  const busy = (error) =>
    error.code === 'P0001' &&
    ['health-check-running', 'health-rate-limited'].includes(error.detail);
  const changed = (error) =>
    error.code === 'P0001' &&
    ['health-check-changed', 'credential-changed'].includes(error.detail);
  const capabilities = ['customer-identity', 'domain-observations'];
  const passed = capabilities.map((capability) => ({
    capability,
    scopeVerified: true,
    failure: null,
  }));
  const partial = [
    passed[0],
    {
      capability: 'domain-observations',
      scopeVerified: false,
      failure: 'delegation-not-authorized',
    },
  ];
  for (const sql of [
    'SELECT * FROM cc.google_health_checks',
    'SELECT * FROM cc.google_capability_health',
    'SELECT cc.google_health_state()',
    "SELECT cc.google_health_capabilities_valid('[]')",
  ])
    await assert.rejects(runtime.query(sql), denied);
  await assert.rejects(read(outsider), denied);
  await assert.rejects(claim(capabilities, reader), denied);
  for (const invalid of [
    [],
    ['school-ou-references'],
    ['customer-identity', 'customer-identity'],
  ])
    await assert.rejects(claim(invalid), (error) => error.code === '22023');
  const initial = await read();
  assert.equal(initial.customerId, customerId);
  assert.equal(initial.capabilities.length, 2);
  assert.equal(JSON.stringify(initial).includes('envelope'), false);
  const lease = await claim();
  assert.ok(lease.envelope);
  await assert.rejects(claim(), busy);
  const health = await finish(lease, partial);
  assert.equal(
    health.capabilities.find((item) => item.capability === 'customer-identity')
      .failure,
    null,
  );
  const domain = health.capabilities.find(
    (item) => item.capability === 'domain-observations',
  );
  assert.equal(domain.failure, 'delegation-not-authorized');
  assert.equal(domain.scopeVerified, false);
  assert.ok(domain.lastSucceededAt);
  assert.ok(health.check.finishedAt);
  await assert.rejects(finish(lease, passed), changed);
  await assert.rejects(claim(), busy);
  await clearWindow();
  const target = await claim(['domain-observations']);
  await assert.rejects(
    finish(target, passed),
    (error) => error.code === '22023',
  );
  const targetResult = await finish(target, [
    { capability: 'domain-observations', scopeVerified: true, failure: null },
  ]);
  assert.deepEqual(
    targetResult.capabilities.find(
      (item) => item.capability === 'customer-identity',
    ),
    health.capabilities.find((item) => item.capability === 'customer-identity'),
  );
  assert.equal(
    targetResult.capabilities.find(
      (item) => item.capability === 'domain-observations',
    ).failure,
    null,
  );

  await clearWindow();
  const inconclusive = await claim();
  await assert.rejects(
    finish(inconclusive, [], connection.observation),
    (error) => error.code === '22023',
  );
  const retained = await finish(inconclusive, []);
  assert.deepEqual(retained.capabilities, targetResult.capabilities);
  assert.ok(retained.check.finishedAt);
  await assert.rejects(finish(inconclusive, []), changed);

  await clearWindow();
  const replica = await connect('cc-app', 'cc-app');
  const competing = await Promise.allSettled([
    claim(),
    claim(capabilities, actor, 1, replica),
  ]);
  assert.equal(
    competing.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    competing.filter(
      (result) => result.status === 'rejected' && busy(result.reason),
    ).length,
    1,
  );
  const winner = competing.find(
    (result) => result.status === 'fulfilled',
  ).value;
  await clearWindow();
  await assert.rejects(finish(winner, passed), changed);
  const newer = await claim();
  await assert.rejects(finish(winner, passed), changed);
  const beforeAuditFailure = await read();
  await migrator.query(`CREATE FUNCTION cc.reject_health_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.event='connection-checked' AND NEW.detail='health-completed' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF;
    RETURN NEW; END; $$; CREATE TRIGGER reject_health_audit BEFORE INSERT ON cc.security_events FOR EACH ROW EXECUTE FUNCTION cc.reject_health_audit()`);
  try {
    await assert.rejects(finish(newer, passed, connection.observation));
  } finally {
    await migrator.query(
      'DROP TRIGGER reject_health_audit ON cc.security_events; DROP FUNCTION cc.reject_health_audit()',
    );
  }
  const afterAuditFailure = await read();
  assert.deepEqual(
    afterAuditFailure.capabilities,
    beforeAuditFailure.capabilities,
  );
  assert.equal(afterAuditFailure.check.finishedAt, null);
  const locker = await connect('cc-migrator', 'cc-app');
  await locker.query('BEGIN');
  await locker.query('SELECT pg_advisory_xact_lock(7240173008)');
  const stale = assert.rejects(finish(newer, passed), denied);
  await locker.query(
    'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
    [actor],
  );
  await locker.query('COMMIT');
  await stale;
  assert.deepEqual(
    (await read(actor, 2)).capabilities,
    beforeAuditFailure.capabilities,
  );
  await assert.rejects(finish(newer, passed, null, 2), changed);
  await clearWindow();
  const recovered = await claim(capabilities, actor, 2);
  const healthy = await finish(recovered, passed, connection.observation, 2);
  assert.ok(
    healthy.capabilities.every(
      (item) => item.failure === null && item.scopeVerified,
    ),
  );
  assert.equal(healthy.backgroundFailure, null);
  const revision = (
    await migrator.query(
      'SELECT generation,customer_id FROM cc.google_connection',
    )
  ).rows[0];
  assert.deepEqual(revision, { generation, customer_id: customerId });
  return [
    'capability health requires current matching read or diagnostic grants and hides private tables: pass',
    'partial scope failure preserves separate successful capabilities and historical success: pass',
    'targeted rechecks preserve unrelated capability observations: pass',
    'inconclusive combined checks preserve all capability evidence: pass',
    'one shared diagnostic lease and cooldown reject competing replicas: pass',
    'expired and superseded diagnostic completions fail closed: pass',
    'audit failure rolls back health, observation, and lease completion: pass',
    'concurrent permission changes reject stale completion while fresh checks recover: pass',
  ];
}
