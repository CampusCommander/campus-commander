import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function qualifySchoolReferences({
  runtime,
  migrator,
  connect,
  issuer,
}) {
  const other = await connect('cc-app', 'cc-app');
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id,
    generation = connection.generation;
  const actor = randomUUID(),
    reader = randomUUID();
  for (const id of [actor, reader]) {
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [id, issuer, id],
    );
    await migrator.query(
      'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
      [
        id,
        id === actor ? 'schools:manage' : 'schools:read',
        JSON.stringify({ kind: 'district', customerId: customer }),
      ],
    );
  }
  await migrator.query(
    'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
    [actor, 'connection:manage', JSON.stringify({ kind: 'platform' })],
  );
  const read = (who = actor, version = 1) =>
    runtime
      .query('SELECT cc.read_school_references($1,$2) AS result', [
        who,
        version,
      ])
      .then((r) => r.rows[0].result);
  const claim = (id = randomUUID(), client = runtime, version = 1) =>
    client
      .query('SELECT cc.claim_school_references($1,$2,$3,$4,$5,$6) AS result', [
        actor,
        version,
        customer,
        generation,
        id,
        randomUUID(),
      ])
      .then((r) => r.rows[0].result);
  const observation = {
    customerId: customer,
    generation,
    revision: randomUUID(),
    observedAt: new Date().toISOString(),
    verified: true,
    complete: true,
    units: [
      { id: 'root', name: 'Root', path: '/', parentId: null },
      { id: 'school-a', name: 'School A', path: '/School A', parentId: 'root' },
    ],
  };
  const finish = (id, value = observation, failure = null, version = 1) =>
    runtime
      .query(
        'SELECT cc.finish_school_references($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          actor,
          version,
          customer,
          generation,
          id,
          value === null ? null : JSON.stringify(value),
          failure,
        ],
      )
      .then((r) => r.rows[0].result);
  const resetRate = () =>
    migrator.query(
      "UPDATE cc.school_reference_state SET retry_at=clock_timestamp()-interval '1 second' WHERE customer_id=$1",
      [customer],
    );
  const denied = (error) => error.code === '42501';
  try {
    await assert.rejects(read(reader), denied);
    await assert.rejects(
      runtime.query('SELECT * FROM cc.school_reference_state'),
      denied,
    );
    await assert.rejects(
      runtime.query('SELECT cc.school_reference_projection()'),
      denied,
    );
    const concurrent = await Promise.allSettled([
      claim(),
      claim(randomUUID(), other),
    ]);
    assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = concurrent.find((r) => r.status === 'rejected').reason;
    assert.equal(rejected.detail, 'reference-check-running');
    const pending = concurrent.find((r) => r.status === 'fulfilled').value;
    assert.equal(pending.credentialId, connection.credential_id);
    assert.ok(pending.envelope);
    await assert.rejects(
      finish(pending.id, { ...observation, customerId: 'C9999999' }),
      (error) => error.code === '22023',
    );
    await assert.rejects(
      finish(pending.id, { ...observation, units: [observation.units[1]] }),
      (error) => error.code === '22023',
    );
    const valid = await finish(pending.id);
    assert.equal(valid.fresh, true);
    assert.equal(valid.checking, false);
    assert.deepEqual(valid.observation.units, observation.units);
    assert.notEqual(valid.observation.revision, observation.revision);
    assert.equal(JSON.stringify(valid).includes('envelope'), false);
    await assert.rejects(
      finish(pending.id),
      (error) => error.detail === 'reference-check-changed',
    );
    await assert.rejects(
      claim(),
      (error) => error.detail === 'reference-rate-limited',
    );
    await resetRate();
    const failed = await claim();
    const unavailable = await finish(failed.id, null, 'permission-denied');
    assert.equal(unavailable.fresh, false);
    assert.deepEqual(unavailable.observation, valid.observation);
    await resetRate();
    const rollback = await claim();
    await migrator.query(`CREATE FUNCTION cc.reject_school_reference_test_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.detail='school-references-ready' THEN RAISE EXCEPTION 'Synthetic audit failure.'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_school_reference_test_event BEFORE INSERT ON cc.security_events FOR EACH ROW EXECUTE FUNCTION cc.reject_school_reference_test_event()`);
    try {
      await assert.rejects(
        finish(rollback.id),
        (error) => error.code === 'P0001',
      );
      const after = await read();
      assert.equal(after.checking, true);
      assert.equal(after.failure, 'permission-denied');
      assert.deepEqual(after.observation, valid.observation);
    } finally {
      await migrator.query(
        'DROP TRIGGER reject_school_reference_test_event ON cc.security_events; DROP FUNCTION cc.reject_school_reference_test_event()',
      );
    }
    await finish(rollback.id);
    await migrator.query(
      "UPDATE cc.school_reference_state SET observed_at=clock_timestamp()-interval '11 minutes' WHERE customer_id=$1",
      [customer],
    );
    assert.equal((await read()).fresh, false);
    await resetRate();
    const retired = await claim();
    await runtime.query(
      'SELECT cc.disconnect_google_credential($1,$2,$3,$4,$5,$6)',
      [actor, 1, customer, generation, randomUUID(), randomUUID()],
    );
    assert.equal((await read()).fresh, false);
    await assert.rejects(
      finish(retired.id),
      (error) => error.detail === 'credential-changed',
    );
    await migrator.query(
      'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
      [actor],
    );
    await assert.rejects(finish(retired.id), denied);
    return [
      'school reference reads require current manager authority and hide ciphertext: pass',
      'replicas admit one bounded reference refresh and reject replay: pass',
      'invalid and cross-customer hierarchies cannot replace verified references: pass',
      'failed refresh retains prior references while denying freshness: pass',
      'audit failure rolls back reference publication and retains its lease: pass',
      'stale observations, retired credentials, and changed actor versions deny publication: pass',
    ];
  } finally {
    await other.end();
  }
}
