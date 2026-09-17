import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function qualifySchoolDefinitions({
  runtime,
  migrator,
  issuer,
  actor,
  customer,
}) {
  const a = randomUUID(),
    b = randomUUID(),
    operator = randomUUID();
  await migrator.query(
    'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
    [operator, issuer, operator],
  );
  await migrator.query(
    'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
    [
      actor,
      'schools:read',
      JSON.stringify({ kind: 'district', customerId: customer }),
    ],
  );
  const query = async (sql, values) =>
    (await runtime.query(sql, values)).rows[0].result;
  const refs = () =>
    query('SELECT cc.read_school_references($1,1) AS result', [actor]);
  const rules = {
    include: [{ id: 'school-a', descendants: true }],
    exclude: [],
  };
  const preview = async (id, expected = 0, name = 'School', ruleset = rules) =>
    query(
      'SELECT cc.preview_school_definition($1,1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
      [
        actor,
        id,
        customer,
        expected,
        (await refs()).observation.revision,
        name,
        JSON.stringify(ruleset),
        randomUUID(),
        randomUUID(),
      ],
    );
  const confirm = (id) =>
    query('SELECT cc.confirm_school_definition($1,1,$2) AS result', [
      actor,
      id,
    ]);
  const read = (who, version, id) =>
    query('SELECT cc.read_school_definition($1,$2,$3) AS result', [
      who,
      version,
      id,
    ]);
  const list = (who, version) =>
    query('SELECT cc.list_school_definitions($1,$2,0,100) AS result', [
      who,
      version,
    ]);
  const audit = (who, version, id) =>
    query('SELECT cc.list_school_audit($1,$2,$3,0) AS result', [
      who,
      version,
      id,
    ]);
  const denied = (error) => error.code === '42501';
  for (const sql of [
    'SELECT * FROM cc.school_definitions',
    'SELECT * FROM cc.school_reviews',
    'SELECT cc.school_effective_ids($1)',
  ]) {
    await assert.rejects(
      runtime.query(sql, sql.includes('$1') ? [a] : []),
      denied,
    );
  }
  const first = await preview(a);
  assert.deepEqual(first.approvedIds, ['school-a']);
  const saved = await confirm(first.id);
  assert.equal(saved.revision, 1);
  assert.deepEqual(await confirm(first.id), saved);
  assert.deepEqual(
    await query('SELECT cc.read_school_review($1,1,$2) AS result', [
      actor,
      first.id,
    ]),
    saved,
  );
  await confirm((await preview(b, 0, 'Other school')).id);
  for (const action of ['schools:read', 'security-events:read']) {
    await migrator.query(
      'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
      [
        operator,
        action,
        JSON.stringify({ kind: 'school', customerId: customer, schoolId: a }),
      ],
    );
  }
  const visible = await list(operator, 1);
  assert.equal(visible.total, 1);
  assert.equal(visible.items[0].id, a);
  assert.equal(await read(operator, 1, b), null);
  assert.equal(await read(operator, 1, randomUUID()), null);
  assert.equal(await audit(operator, 1, b), null);
  assert.equal((await audit(operator, 1, a)).total, 1);
  await assert.rejects(
    query(
      'SELECT cc.preview_school_definition($1,1,$2,$3,1,$4,$5,$6,$7,$8) AS result',
      [
        operator,
        a,
        customer,
        first.referenceRevision,
        'Denied',
        JSON.stringify(rules),
        randomUUID(),
        randomUUID(),
      ],
    ),
    denied,
  );
  assert.deepEqual((await read(operator, 1, a)).effectiveIds, ['school-a']);
  const observation = (await refs()).observation;
  const units = [
    ...observation.units,
    {
      id: 'new-child',
      name: 'Child',
      path: '/School A/Child',
      parentId: 'school-a',
    },
  ];
  await migrator.query(
    "UPDATE cc.school_reference_state SET observation=jsonb_set(observation,'{units}',$1) WHERE customer_id=$2",
    [JSON.stringify(units), customer],
  );
  assert.deepEqual((await read(operator, 1, a)).effectiveIds, ['school-a']);
  const expanded = await preview(a, 1, 'Expanded school');
  assert.deepEqual(expanded.approvedIds, ['new-child', 'school-a']);
  assert.equal(expanded.affectedPrincipalCount, 1);
  await migrator.query(
    "UPDATE cc.school_reference_state SET failure='permission-denied' WHERE customer_id=$1",
    [customer],
  );
  assert.equal((await read(operator, 1, a)).effectiveIds, null);
  assert.deepEqual((await read(operator, 1, a)).approvedIds, ['school-a']);
  await assert.rejects(
    confirm(expanded.id),
    (error) => error.detail === 'references-changed',
  );
  await migrator.query(
    'UPDATE cc.school_reference_state SET failure=NULL WHERE customer_id=$1',
    [customer],
  );
  const concurrent = await preview(a, 1, 'Concurrent');
  await migrator.query(`CREATE FUNCTION cc.reject_school_change_test_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event='school-scope-changed' THEN RAISE EXCEPTION 'Synthetic audit failure.'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_school_change_test_event BEFORE INSERT ON cc.security_events FOR EACH ROW EXECUTE FUNCTION cc.reject_school_change_test_event()`);
  try {
    await assert.rejects(
      confirm(expanded.id),
      (error) => error.code === 'P0001',
    );
    assert.equal((await read(operator, 1, a)).revision, 1);
    assert.equal(
      (
        await query('SELECT cc.read_school_review($1,1,$2) AS result', [
          actor,
          expanded.id,
        ])
      ).appliedAt,
      null,
    );
  } finally {
    await migrator.query(
      'DROP TRIGGER reject_school_change_test_event ON cc.security_events; DROP FUNCTION cc.reject_school_change_test_event()',
    );
  }
  assert.equal((await confirm(expanded.id)).revision, 2);
  await assert.rejects(read(operator, 1, a), denied);
  assert.deepEqual((await read(operator, 2, a)).effectiveIds, [
    'new-child',
    'school-a',
  ]);
  await assert.rejects(
    confirm(concurrent.id),
    (error) => error.detail === 'school-changed',
  );
  const changedAccess = await preview(a, 2, 'Changed access');
  await migrator.query(
    'UPDATE cc.application_principals SET permission_version=permission_version+1 WHERE id=$1',
    [operator],
  );
  await assert.rejects(
    confirm(changedAccess.id),
    (error) => error.detail === 'school-access-changed',
  );
  await migrator.query(
    "UPDATE cc.school_reference_state SET observation=jsonb_set(observation,'{units}',$1) WHERE customer_id=$2",
    [JSON.stringify(observation.units), customer],
  );
  assert.deepEqual((await read(operator, 3, a)).effectiveIds, ['school-a']);
  return [
    'school confirmation retains a recoverable receipt and rejects replay effects: pass',
    'school lists, totals, direct reads, and audit deny other school identities: pass',
    'new descendants cannot expand access without explicit confirmation: pass',
    'reference failure preserves definitions while denying effective scope: pass',
    'school change and affected permission versions roll back with audit failure: pass',
    'concurrent definitions and changed affected principals invalidate reviews: pass',
  ];
}
