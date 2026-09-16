import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const opaque = () => randomBytes(32).toString('hex');

export async function qualifyInvitations({
  runtime,
  migrator,
  connect,
  principalId,
  issuer,
}) {
  const correlation = randomUUID();
  const create = async ({ subject = null, grants = [], version = 2 } = {}) => {
    const token = opaque();
    const { rows } = await runtime.query(
      'SELECT cc.create_invitation($1,$2,$3,$4,$5,$6,$7,$8) AS id',
      [
        principalId,
        version,
        'Controlled recipient',
        subject,
        hash(token),
        JSON.stringify(grants),
        24,
        correlation,
      ],
    );
    return { id: rows[0].id, token };
  };
  const claim = async (
    invitation,
    client = runtime,
    browser = opaque(),
    claimIssuer = issuer,
  ) => {
    const { rows } = await client.query(
      'SELECT cc.claim_invitation($1,$2,$3,$4) AS id',
      [hash(invitation.token), hash(browser), claimIssuer, correlation],
    );
    return { id: rows[0].id, browser };
  };
  const verify = async (invitation, subject, claimIssuer = issuer) => {
    const { rows } = await runtime.query(
      'SELECT cc.verify_invitation($1,$2,$3,$4,$5,$6) AS verified',
      [
        invitation.id,
        hash(invitation.browser),
        claimIssuer,
        subject,
        'Verified recipient',
        correlation,
      ],
    );
    return rows[0].verified;
  };
  const snapshot = async (id) =>
    (
      await migrator.query(
        'SELECT * FROM cc.application_invitations WHERE id=$1',
        [id],
      )
    ).rows[0];
  const confirm = async (id, subject, version = 3, actorVersion = 2) =>
    (
      await runtime.query(
        'SELECT cc.confirm_invitation($1,$2,$3,$4,$5,$6) AS principal',
        [principalId, actorVersion, id, version, subject, correlation],
      )
    ).rows[0].principal;
  const revoke = async (id, version) =>
    (
      await runtime.query(
        'SELECT cc.revoke_invitation($1,$2,$3,$4,$5) AS revoked',
        [principalId, 2, id, version, correlation],
      )
    ).rows[0].revoked;
  const rollback = async (event, action) => {
    await migrator.query(
      `ALTER TABLE cc.security_events ADD CONSTRAINT reject_invitation_audit CHECK(event <> '${event}') NOT VALID`,
    );
    try {
      await assert.rejects(action(), /reject_invitation_audit/);
    } finally {
      await migrator.query(
        'ALTER TABLE cc.security_events DROP CONSTRAINT reject_invitation_audit',
      );
    }
  };
  for (const sql of [
    'SELECT * FROM cc.application_invitations',
    'DELETE FROM cc.application_invitations',
    "SELECT cc.invitation_actor(NULL,1,'platform-users:invite')",
    'SELECT cc.expire_invitations(gen_random_uuid())',
    "SELECT cc.invitation_grants_allowed(NULL,'[]')",
  ])
    await assert.rejects(runtime.query(sql), /permission denied/);
  await assert.rejects(create({ version: 1 }), /Current platform authority/);
  await assert.rejects(create({ version: null }), /Current platform authority/);
  await assert.rejects(
    create({
      grants: [
        { action: 'customer:read', scope: { kind: 'platform' } },
        { action: 'customer:read', scope: { kind: 'platform' } },
      ],
    }),
    /exceeds/,
  );
  await assert.rejects(
    create({ grants: [{ action: 'unknown', scope: { kind: 'platform' } }] }),
    /exceeds/,
  );
  await assert.rejects(
    create({
      grants: [
        {
          action: 'customer:read',
          scope: { kind: 'district', customerId: 'unverified' },
        },
      ],
    }),
    /exceeds/,
  );
  const beforeCount = (
    await migrator.query('SELECT count(*) FROM cc.application_invitations')
  ).rows[0].count;
  await rollback('invitation-created', () => create());
  assert.equal(
    (await migrator.query('SELECT count(*) FROM cc.application_invitations'))
      .rows[0].count,
    beforeCount,
  );

  const invitation = await create({
    subject: 'controlled-subject',
    grants: [{ action: 'customer:read', scope: { kind: 'platform' } }],
  });
  assert.equal(
    (await snapshot(invitation.id)).token_hash,
    hash(invitation.token),
  );
  assert.equal(
    (await claim(invitation, runtime, opaque(), 'https://wrong-issuer.invalid'))
      .id,
    null,
  );
  await rollback('invitation-redeemed', () => claim(invitation));
  assert.equal((await snapshot(invitation.id)).status, 'issued');
  const runtime2 = await connect('cc-app', 'cc-app');
  const claims = await Promise.all([
    claim(invitation),
    claim(invitation, runtime2),
  ]);
  assert.equal(claims.filter((item) => item.id).length, 1);
  const claimed = claims.find((item) => item.id);
  assert.equal((await snapshot(invitation.id)).token_hash, null);
  assert.equal((await claim(invitation)).id, null);
  assert.equal(await verify(claimed, 'wrong-subject'), false);
  assert.equal(
    await verify({ ...claimed, browser: opaque() }, 'controlled-subject'),
    false,
  );
  assert.equal(
    await verify(claimed, 'controlled-subject', 'https://wrong-issuer.invalid'),
    false,
  );
  await rollback('invitation-redeemed', () =>
    verify(claimed, 'controlled-subject'),
  );
  assert.equal((await snapshot(invitation.id)).status, 'redeeming');
  assert.equal(await verify(claimed, 'controlled-subject'), true);
  assert.equal(await verify(claimed, 'controlled-subject'), false);
  assert.equal(
    (
      await runtime.query(
        'SELECT id FROM cc.application_principals WHERE subject=$1',
        ['controlled-subject'],
      )
    ).rowCount,
    0,
  );
  assert.equal(await confirm(invitation.id, 'wrong-subject'), null);
  assert.equal(await confirm(invitation.id, 'controlled-subject', 2), null);
  await assert.rejects(
    confirm(invitation.id, 'controlled-subject', 3, 1),
    /Current platform authority/,
  );

  await migrator.query(
    'UPDATE cc.application_principals SET enabled=false WHERE id=$1',
    [principalId],
  );
  await assert.rejects(
    confirm(invitation.id, 'controlled-subject'),
    /Current platform authority/,
  );
  await migrator.query(
    'UPDATE cc.application_principals SET enabled=true WHERE id=$1',
    [principalId],
  );
  await migrator.query(
    "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='customer:read'",
    [principalId],
  );
  await assert.rejects(
    confirm(invitation.id, 'controlled-subject'),
    /current authority/,
  );
  await migrator.query(
    `INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,'customer:read','{"kind":"platform"}')`,
    [principalId],
  );
  await rollback('access-granted', () =>
    confirm(invitation.id, 'controlled-subject'),
  );
  assert.equal((await snapshot(invitation.id)).status, 'pending');
  assert.equal(
    (
      await runtime.query(
        'SELECT id FROM cc.application_principals WHERE subject=$1',
        ['controlled-subject'],
      )
    ).rowCount,
    0,
  );
  const accepted = await confirm(invitation.id, 'controlled-subject');
  assert.ok(accepted);
  const principal = (
    await runtime.query('SELECT * FROM cc.application_principals WHERE id=$1', [
      accepted,
    ])
  ).rows[0];
  assert.deepEqual(principal.permissions, ['identity:read']);
  assert.equal(
    (
      await runtime.query(
        'SELECT action FROM cc.application_grants WHERE principal_id=$1',
        [accepted],
      )
    ).rows[0].action,
    'customer:read',
  );
  assert.equal(await confirm(invitation.id, 'controlled-subject'), null);
  assert.equal(await revoke(invitation.id, 4), false);
  assert.equal(
    (
      await runtime.query(
        'SELECT cc.invitation_browser_status($1,$2) AS status',
        [hash(claimed.browser), correlation],
      )
    ).rows[0].status,
    'accepted',
  );

  const revoked = await create();
  await rollback('invitation-revoked', () => revoke(revoked.id, 1));
  assert.equal((await snapshot(revoked.id)).status, 'issued');
  assert.equal(await revoke(revoked.id, 1), true);
  assert.equal((await claim(revoked)).id, null);
  const expired = await create();
  await migrator.query(
    "UPDATE cc.application_invitations SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1",
    [expired.id],
  );
  assert.equal((await claim(expired)).id, null);
  assert.equal((await snapshot(expired.id)).status, 'expired');
  const listed = (
    await runtime.query('SELECT cc.list_invitations($1,$2,$3) AS items', [
      principalId,
      2,
      correlation,
    ])
  ).rows[0].items;
  assert.equal(
    listed.find((item) => item.id === invitation.id).status,
    'accepted',
  );
  assert.ok(!JSON.stringify(listed).includes(invitation.token));
  assert.ok(!JSON.stringify(listed).includes(hash(claimed.browser)));
  assert.ok(!JSON.stringify(listed).includes('token_hash'));
  const events = (
    await runtime.query(
      'SELECT event FROM cc.security_events WHERE target_id=$1',
      [invitation.id],
    )
  ).rows.map((row) => row.event);
  assert.deepEqual(
    events.sort(),
    [
      'invitation-created',
      'invitation-redeemed',
      'invitation-redeemed',
      'invitation-confirmed',
    ].sort(),
  );
  return [
    'invitation runtime operations deny raw table access, stale authority, unsupported scopes, and excess grants: pass',
    'invitation claim race, token replay, wrong identity, wrong issuer, and browser substitution denied: pass',
    'unknown identity receives no principal or grants before explicit inviter confirmation: pass',
    'revoked inviter, reduced grant ceiling, stale invitation, and audit failure preserve pending state: pass',
    'invitation create, claim, verification, confirmation, and revocation roll back when audit fails: pass',
    'invitation expiry and revocation deny redemption; summaries and events exclude tokens: pass',
  ];
}
