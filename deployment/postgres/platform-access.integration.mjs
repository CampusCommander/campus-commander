import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function qualifyPlatformAccess({
  runtime,
  migrator,
  connect,
  principalId,
  issuer,
}) {
  const correlation = randomUUID();
  const target = randomUUID();
  const limited = randomUUID();
  const secondAdmin = randomUUID();
  const scope = { kind: 'platform' };
  const readGrant = [{ action: 'customer:read', scope }];
  const fullGrants = (
    await runtime.query(
      'SELECT action,scope FROM cc.application_grants WHERE principal_id=$1 ORDER BY action',
      [principalId],
    )
  ).rows;
  for (const [id, subject] of [
    [target, 'access-target'],
    [limited, 'limited-manager'],
    [secondAdmin, 'second-administrator'],
  ]) {
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [id, issuer, subject],
    );
  }
  await migrator.query(
    `INSERT INTO cc.application_grants(principal_id,action,scope)
    SELECT $1,action,'{"kind":"platform"}'::jsonb FROM cc.application_actions WHERE action IN ('platform-users:manage','platform-users:read')`,
    [limited],
  );
  const call = async ({
    actor = principalId,
    version = 2,
    id = target,
    targetVersion = 1,
    enabled = true,
    grants = readGrant,
    apply = true,
    client = runtime,
  } = {}) => {
    const values = [
      actor,
      version,
      id,
      targetVersion,
      enabled,
      JSON.stringify(grants),
    ];
    if (apply) values.push(correlation);
    return (
      await client.query(
        `SELECT cc.${apply ? 'change' : 'review'}_platform_access($1,$2,$3,$4,$5,$6${apply ? ',$7' : ''}) AS result`,
        values,
      )
    ).rows[0].result;
  };
  const read = async (id = target) =>
    (
      await runtime.query(
        'SELECT cc.read_platform_principal($1,$2,$3) AS result',
        [principalId, 2, id],
      )
    ).rows[0].result;
  for (const sql of [
    'SELECT * FROM cc.application_access_changes',
    'DELETE FROM cc.application_access_changes',
    'SELECT cc.platform_principal(NULL)',
    'SELECT cc.full_platform_administrator(NULL)',
    `SELECT cc.application_scope_verified('{"kind":"platform"}')`,
    `SELECT cc.access_grants_allowed(NULL,'[]')`,
  ])
    await assert.rejects(runtime.query(sql), /permission denied/);
  await assert.rejects(call({ version: null }), /Current platform authority/);
  await assert.rejects(call({ version: 1 }), /Current platform authority/);
  await assert.rejects(call({ targetVersion: 2 }), /principal changed/);
  await assert.rejects(
    call({ grants: [{ action: 'unknown', scope }] }),
    /delegation authority/,
  );
  await assert.rejects(
    call({ grants: [...readGrant, ...readGrant] }),
    /delegation authority/,
  );
  await assert.rejects(
    call({
      grants: [
        {
          action: 'customer:read',
          scope: { kind: 'district', customerId: 'unverified' },
        },
      ],
    }),
    /delegation authority/,
  );
  const limitedGrants = (
    await runtime.query(
      'SELECT action,scope FROM cc.application_grants WHERE principal_id=$1',
      [limited],
    )
  ).rows;
  await assert.rejects(
    call({
      actor: limited,
      version: 1,
      id: limited,
      grants: [...limitedGrants, { action: 'connection:manage', scope }],
    }),
    /delegation authority/,
  );
  await assert.rejects(
    call({
      actor: limited,
      version: 1,
      id: principalId,
      targetVersion: 2,
      enabled: false,
      grants: [],
    }),
    /delegation authority/,
  );
  await assert.rejects(
    call({
      id: principalId,
      targetVersion: 2,
      enabled: false,
      grants: fullGrants,
    }),
    /one enabled platform administrator/,
  );
  await assert.rejects(
    call({ id: principalId, targetVersion: 2, grants: readGrant }),
    /one enabled platform administrator/,
  );
  const before = await read();
  const review = await call({ apply: false });
  assert.deepEqual(review.current, before);
  assert.deepEqual(review.proposed, { enabled: true, grants: readGrant });
  assert.deepEqual(await read(), before);
  await migrator.query(
    `ALTER TABLE cc.security_events ADD CONSTRAINT reject_access_audit CHECK(event<>'grants-changed') NOT VALID`,
  );
  try {
    await assert.rejects(call(), /reject_access_audit/);
  } finally {
    await migrator.query(
      'ALTER TABLE cc.security_events DROP CONSTRAINT reject_access_audit',
    );
  }
  assert.deepEqual(await read(), before);
  assert.equal(
    (await migrator.query('SELECT * FROM cc.application_access_changes'))
      .rowCount,
    0,
  );
  const changed = await call();
  assert.equal(changed.principal.permissionVersion, 2);
  assert.equal(changed.principal.id, target);
  assert.deepEqual(changed.principal.grants, readGrant);
  assert.deepEqual(changed.principal.permissions, ['identity:read']);
  const receipt = (
    await migrator.query(
      'SELECT * FROM cc.application_access_changes WHERE id=$1',
      [changed.receiptId],
    )
  ).rows[0];
  assert.deepEqual(receipt.previous_grants, []);
  assert.deepEqual(receipt.grants, readGrant);
  const receipts = (
    await runtime.query(
      'SELECT cc.list_platform_access_receipts($1,$2,$3,$4) AS result',
      [principalId, 2, target, 0],
    )
  ).rows[0].result;
  assert.equal(receipts.total, 1);
  assert.equal(receipts.items[0].id, changed.receiptId);
  assert.deepEqual(receipts.items[0].previous.grants, []);
  assert.deepEqual(receipts.items[0].applied.grants, readGrant);
  for (const [actor, version, offset] of [
    [target, 2, 0],
    [principalId, 1, 0],
    [principalId, 2, -1],
  ]) {
    await assert.rejects(
      runtime.query('SELECT cc.list_platform_access_receipts($1,$2,$3,$4)', [
        actor,
        version,
        target,
        offset,
      ]),
    );
  }
  assert.deepEqual(
    (
      await runtime.query(
        'SELECT cc.list_platform_access_receipts($1,$2,$3,$4) AS result',
        [principalId, 2, target, 20],
      )
    ).rows[0].result.items,
    [],
  );
  await assert.rejects(call(), /principal changed/);
  await assert.rejects(call({ targetVersion: 2 }), /Select an access change/);
  const disabled = await call({ targetVersion: 2, enabled: false });
  assert.equal(disabled.principal.enabled, false);
  assert.equal(disabled.principal.permissionVersion, 3);
  const enabled = await call({ targetVersion: 3 });
  assert.equal(enabled.principal.enabled, true);
  assert.equal(enabled.principal.permissionVersion, 4);
  assert.deepEqual(
    (
      await runtime.query(
        'SELECT preferences FROM cc.application_principals WHERE id=$1',
        [target],
      )
    ).rows[0].preferences,
    { theme: 'system', navigationCollapsed: false },
  );
  const page = (
    await runtime.query(
      'SELECT cc.list_platform_principals($1,$2,$3,$4) AS result',
      [principalId, 2, 0, 2],
    )
  ).rows[0].result;
  assert.equal(page.items.length, 2);
  assert.equal(
    page.total,
    Number(
      (await runtime.query('SELECT count(*) FROM cc.application_principals'))
        .rows[0].count,
    ),
  );
  await assert.rejects(
    runtime.query('SELECT cc.list_platform_principals($1,$2,0,101)', [
      principalId,
      2,
    ]),
    /page is invalid/,
  );
  await call({ id: secondAdmin, grants: fullGrants });
  const runtime2 = await connect('cc-app', 'cc-app');
  const results = await Promise.allSettled([
    call({
      id: principalId,
      targetVersion: 2,
      enabled: false,
      grants: fullGrants,
    }),
    call({
      actor: secondAdmin,
      version: 2,
      id: secondAdmin,
      targetVersion: 2,
      enabled: false,
      grants: fullGrants,
      client: runtime2,
    }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.match(
    results.find((item) => item.status === 'rejected').reason.message,
    /one enabled platform administrator/,
  );
  const remaining = await migrator.query(
    'SELECT id FROM cc.application_principals WHERE cc.full_platform_administrator(id)',
  );
  assert.equal(remaining.rowCount, 1);
  const events = (
    await runtime.query(
      'SELECT event FROM cc.security_events WHERE target_id=$1',
      [target],
    )
  ).rows.map((row) => row.event);
  assert.equal(events.filter((event) => event === 'grants-changed').length, 3);
  assert.ok(
    events.includes('principal-disabled') &&
      events.includes('principal-enabled'),
  );
  return [
    'platform access preview preserves state and applies exact grants with immutable change receipts: pass',
    'stale revisions, self-escalation, excessive delegation, duplicate grants, and unverified district scopes denied: pass',
    'principal identity and preferences survive grant, disable, and enable changes: pass',
    'permission versions, grants, enablement, receipts, and security events commit atomically: pass',
    'concurrent administrator disable attempts preserve one enabled full platform administrator: pass',
    'principal pagination uses authorized counts and bounded pages; runtime helper and receipt access denied: pass',
  ];
}
