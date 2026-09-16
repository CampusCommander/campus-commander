import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { changeApplicationAccess } from '../bootstrap/application-access.mjs';

export async function qualifyAccessRevocation({
  runtime,
  migrator,
  connect,
  issuer,
}) {
  const actor = randomUUID(),
    inviter = randomUUID();
  const correlation = randomUUID();
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  for (const id of [actor, inviter]) {
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [id, issuer, id],
    );
    await migrator.query(
      `INSERT INTO cc.application_grants(principal_id,action,scope) SELECT $1,action,'{"kind":"platform"}'::jsonb FROM cc.application_actions`,
      [id],
    );
  }
  const grants = (
    await migrator.query(
      'SELECT action,scope FROM cc.application_grants WHERE principal_id=$1 ORDER BY action',
      [actor],
    )
  ).rows;
  const create = async (creator = inviter, version = 1) => {
    const token = randomBytes(32).toString('hex');
    const result = await runtime.query(
      'SELECT cc.create_invitation($1,$2,$3,NULL,$4,$5,24,$6) AS id',
      [creator, version, 'Revocation fixture', hash(token), '[]', correlation],
    );
    return { id: result.rows[0].id, token };
  };
  const claim = async (item) => {
    const browser = randomBytes(32).toString('hex');
    const result = await runtime.query(
      'SELECT cc.claim_invitation($1,$2,$3,$4) AS id',
      [hash(item.token), hash(browser), issuer, correlation],
    );
    return { ...item, browser, claimed: result.rows[0].id };
  };
  const pending = async (version = 1) => {
    const item = await claim(await create(inviter, version));
    const subject = randomUUID();
    await runtime.query('SELECT cc.verify_invitation($1,$2,$3,$4,$5,$6)', [
      item.id,
      hash(item.browser),
      issuer,
      subject,
      'Verified fixture',
      correlation,
    ]);
    return { ...item, subject };
  };
  const confirm = async (item, version = 1, client = runtime) =>
    (
      await client.query(
        'SELECT cc.confirm_invitation($1,$2,$3,3,$4,$5) AS id',
        [inviter, version, item.id, item.subject, correlation],
      )
    ).rows[0].id;
  const review = async (version = 1, enabled = false, proposed = []) =>
    (
      await runtime.query(
        'SELECT cc.review_platform_access($1,1,$2,$3,$4,$5) AS result',
        [actor, inviter, version, enabled, JSON.stringify(proposed)],
      )
    ).rows[0].result;
  const apply = async (preview, client = runtime) =>
    (
      await client.query(
        'SELECT cc.change_platform_access($1,1,$2,$3,$4,$5,$6,$7) AS result',
        [
          actor,
          inviter,
          preview.targetVersion,
          preview.proposed.enabled,
          JSON.stringify(preview.proposed.grants),
          correlation,
          JSON.stringify(preview.invitationsToRevoke.map((item) => item.id)),
        ],
      )
    ).rows[0].result;
  const snapshot = async (id) =>
    (
      await migrator.query(
        'SELECT status,version,token_hash FROM cc.application_invitations WHERE id=$1',
        [id],
      )
    ).rows[0];
  await assert.rejects(
    runtime.query('SELECT cc.revoke_principal_invitations($1,$2,$3)', [
      inviter,
      actor,
      correlation,
    ]),
    /permission denied/,
  );
  await assert.rejects(
    runtime.query('SELECT cc.change_platform_access($1,1,$2,1,false,$3,$4)', [
      actor,
      inviter,
      '[]',
      correlation,
    ]),
    /does not exist/,
  );
  const issued = await create();
  const redeeming = await claim(await create());
  const verified = await pending();
  const accepted = await pending();
  await confirm(accepted);
  const unrelated = await create(actor);
  const preview = await review();
  assert.deepEqual(
    preview.invitationsToRevoke.map((item) => item.id),
    [issued.id, redeeming.id, verified.id].sort(),
  );
  const late = await create();
  await assert.rejects(apply(preview), /pending invitations changed/);
  const current = await review();
  const before = await snapshot(issued.id);
  await migrator.query(
    "ALTER TABLE cc.security_events ADD CONSTRAINT reject_revocation_audit CHECK(event <> 'invitation-revoked') NOT VALID",
  );
  try {
    await assert.rejects(apply(current), /reject_revocation_audit/);
  } finally {
    await migrator.query(
      'ALTER TABLE cc.security_events DROP CONSTRAINT reject_revocation_audit',
    );
  }
  assert.deepEqual(await snapshot(issued.id), before);
  assert.equal(
    (
      await migrator.query(
        'SELECT enabled FROM cc.application_principals WHERE id=$1',
        [inviter],
      )
    ).rows[0].enabled,
    true,
  );
  assert.equal(
    (
      await migrator.query(
        'SELECT count(*) FROM cc.application_access_changes WHERE principal_id=$1',
        [inviter],
      )
    ).rows[0].count,
    '0',
  );
  const changed = await apply(current);
  assert.equal(changed.principal.permissionVersion, 2);
  for (const item of [issued, redeeming, verified, late]) {
    const record = await snapshot(item.id);
    assert.equal(record.status, 'revoked');
    assert.equal(record.token_hash, null);
    assert.equal((await claim(item)).claimed, null);
  }
  assert.equal((await snapshot(accepted.id)).status, 'accepted');
  assert.equal((await snapshot(unrelated.id)).status, 'issued');
  assert.equal(
    (
      await migrator.query(
        "SELECT count(*) FROM cc.security_events WHERE event='invitation-revoked' AND correlation_id=$1",
        [correlation],
      )
    ).rows[0].count,
    '4',
  );
  const receipt = (
    await runtime.query(
      'SELECT cc.list_platform_access_receipts($1,1,$2,0) AS result',
      [actor, inviter],
    )
  ).rows[0].result.items[0];
  assert.deepEqual(
    receipt.revokedInvitationIds,
    current.invitationsToRevoke.map((item) => item.id),
  );
  await apply(await review(2, true, grants));
  assert.equal((await snapshot(issued.id)).status, 'revoked');
  assert.equal((await claim(issued)).claimed, null);
  const replacement = await create(inviter, 3);
  await changeApplicationAccess(
    migrator,
    {
      action: 'replace',
      principalId: inviter,
      expectedVersion: 3,
      issuer,
      subject: 'replacement-' + inviter,
      displayName: 'Replacement fixture',
    },
    issuer,
    3,
  );
  assert.equal((await snapshot(replacement.id)).status, 'revoked');
  const revoked = await create(inviter, 4);
  await changeApplicationAccess(
    migrator,
    { action: 'revoke', principalId: inviter, expectedVersion: 4 },
    issuer,
    3,
  );
  assert.equal((await snapshot(revoked.id)).status, 'revoked');
  await apply(await review(5, true, grants));
  const racing = await pending(6);
  const racePreview = await review(6);
  const second = await connect('cc-app', 'cc-app');
  const results = await Promise.allSettled([
    confirm(racing, 6),
    apply(racePreview, second),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const final = await snapshot(racing.id);
  const enabled = (
    await migrator.query(
      'SELECT enabled FROM cc.application_principals WHERE id=$1',
      [inviter],
    )
  ).rows[0].enabled;
  assert.ok(
    (final.status === 'accepted' && enabled) ||
      (final.status === 'revoked' && !enabled),
  );
  return [
    'access changes revoke issued, redeeming, and pending invitations atomically: pass',
    'review freezes exact invitation IDs and rejects a competing new invitation: pass',
    'invitation audit failure rolls back grants, enablement, versions, and receipts: pass',
    'accepted and unrelated invitations remain unchanged; revoked invitations cannot revive: pass',
    'operator replacement and revocation invalidate outstanding invitations: pass',
    'invitation confirmation and access revocation serialize without stale acceptance: pass',
  ];
}
