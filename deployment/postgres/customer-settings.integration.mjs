import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function qualifyCustomerSettings({
  runtime,
  migrator,
  connect,
  issuer,
}) {
  const customerId = (
    await migrator.query('SELECT customer_id FROM cc.google_connection')
  ).rows[0].customer_id;
  const actor = randomUUID(),
    reader = randomUUID(),
    outsider = randomUUID();
  for (const id of [actor, reader, outsider]) {
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [id, issuer, id],
    );
    for (const action of id === reader
      ? ['customer:read']
      : ['customer:read', 'customer:write']) {
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
  }
  const read = async (id = actor, version = 1) =>
    (
      await runtime.query('SELECT cc.read_customer_settings($1,$2) AS result', [
        id,
        version,
      ])
    ).rows[0].result;
  const save = async (
    settings,
    expectedRevision,
    requestId = randomUUID(),
    id = actor,
    version = 1,
    client = runtime,
  ) =>
    (
      await client.query(
        'SELECT cc.save_customer_settings($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          id,
          version,
          customerId,
          expectedRevision,
          requestId,
          JSON.stringify(settings),
          randomUUID(),
        ],
      )
    ).rows[0].result;
  const denied = (error) => error.code === '42501';
  const conflict = (error) =>
    error.code === 'P0001' &&
    ['request-conflict', 'revision-conflict'].includes(error.detail);
  for (const sql of [
    'SELECT * FROM cc.customer_settings_revisions',
    'DELETE FROM cc.customer_settings_revisions',
    "SELECT cc.customer_settings_receipt('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')",
    "SELECT cc.customer_settings_valid('{}')",
  ]) {
    await assert.rejects(runtime.query(sql), denied);
  }
  const initial = await read();
  assert.equal(initial.revision, 0);
  assert.equal(initial.onboarding.settingsConfirmedAt, null);
  assert.ok(initial.onboarding.customerConfirmedAt);
  assert.equal(initial.customerId, customerId);
  assert.equal('clientId' in initial, false);
  await assert.rejects(read(outsider), denied);
  await assert.rejects(
    save({ displayName: 'Denied' }, 0, randomUUID(), reader),
    denied,
  );
  for (const settings of [
    {},
    { displayName: '' },
    { displayName: '\n' },
    { displayName: 'x'.repeat(257) },
    { displayName: 'District', theme: 'dark' },
  ]) {
    await assert.rejects(save(settings, 0), (error) => error.code === '22023');
  }
  const request = randomUUID(),
    settings = { displayName: 'Saved district' };
  const saved = await save(settings, 0, request);
  assert.equal(saved.revision, 1);
  assert.deepEqual(await save(settings, 0, request), saved);
  await assert.rejects(
    save({ displayName: 'Different' }, 0, request),
    conflict,
  );
  await assert.rejects(save(settings, 0), conflict);
  assert.equal((await read(reader)).settings.displayName, settings.displayName);
  assert.equal((await read()).onboarding.settingsConfirmedAt, saved.savedAt);
  assert.equal(
    (
      await migrator.query(
        "SELECT count(*)::int AS count FROM cc.security_events WHERE event='customer-settings-changed' AND target_id=$1",
        [request],
      )
    ).rows[0].count,
    1,
  );
  const receipt = (
    await runtime.query(
      'SELECT cc.read_customer_settings_receipt($1,1,$2) AS result',
      [reader, request],
    )
  ).rows[0].result;
  assert.deepEqual(receipt, saved);
  await assert.rejects(
    runtime.query('SELECT cc.read_customer_settings_receipt($1,1,$2)', [
      outsider,
      request,
    ]),
    denied,
  );
  const replica = await connect('cc-app', 'cc-app');
  const competing = await Promise.allSettled([
    save({ displayName: 'First writer' }, 1),
    save({ displayName: 'Second writer' }, 1, randomUUID(), actor, 1, replica),
  ]);
  assert.equal(
    competing.filter((value) => value.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    competing.filter(
      (value) => value.status === 'rejected' && conflict(value.reason),
    ).length,
    1,
  );
  const before = await read();
  await migrator.query(`CREATE FUNCTION cc.reject_customer_settings_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event='customer-settings-changed' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER reject_customer_settings_audit BEFORE INSERT ON cc.security_events FOR EACH ROW EXECUTE FUNCTION cc.reject_customer_settings_audit()`);
  try {
    await assert.rejects(
      save({ displayName: 'Must roll back' }, 2),
      (error) =>
        error.code === 'P0001' && error.message === 'Synthetic audit failure',
    );
  } finally {
    await migrator.query(
      'DROP TRIGGER reject_customer_settings_audit ON cc.security_events; DROP FUNCTION cc.reject_customer_settings_audit()',
    );
  }
  assert.deepEqual(await read(), before);
  const locker = await connect('cc-migrator', 'cc-app');
  await locker.query('BEGIN');
  await locker.query('SELECT pg_advisory_xact_lock(7240173008)');
  const stale = save({ displayName: 'Stale actor' }, 2);
  const rejected = assert.rejects(stale, denied);
  await locker.query(
    'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
    [actor],
  );
  await locker.query('COMMIT');
  await rejected;
  assert.deepEqual(await read(actor, 2), before);
  await assert.rejects(save(settings, 0, request, actor, 1), denied);
  assert.deepEqual(await save(settings, 0, request, actor, 2), saved);
  assert.equal(
    (
      await migrator.query(
        'SELECT count(*)::int AS count FROM cc.customer_settings_revisions WHERE customer_id=$1',
        [customerId],
      )
    ).rows[0].count,
    2,
  );
  return [
    'customer settings reject unknown fields, invalid values, cross-customer grants, and runtime table access: pass',
    'settings revisions and receipts persist separately from credentials and user preferences: pass',
    'duplicate requests return the original receipt without another audit event: pass',
    'competing settings writes commit exactly one next revision: pass',
    'audit failure rolls back the settings revision and concurrent permission changes reject stale actors: pass',
  ];
}
