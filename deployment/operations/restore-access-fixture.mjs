import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');

export async function seedInvitationRecovery(client, principalId) {
  const fixtures = [];
  for (const status of [
    'issued',
    'redeeming',
    'pending',
    'accepted',
    'revoked',
    'expired',
  ]) {
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const browser = randomBytes(32).toString('hex');
    const { rows } = await client.query(
      `INSERT INTO cc.application_invitations
        (id,created_by,issuer,label,token_hash,browser_hash,intended_grants,status,
         candidate_subject,candidate_name,principal_id,expires_at)
       SELECT $1,id,issuer,'Restore fixture',$2,$3,'[]'::jsonb,$4,
         CASE WHEN $4='accepted' THEN subject ELSE $5 END,
         CASE WHEN $4='accepted' THEN display_name ELSE $5 END,
         $6,now()+interval '1 hour'
       FROM cc.application_principals WHERE id=$7 RETURNING *`,
      [
        id,
        status === 'issued' ? hash(token) : null,
        status === 'issued' ? null : hash(browser),
        status,
        ['pending', 'accepted'].includes(status) ? `recipient-${id}` : null,
        status === 'accepted' ? principalId : null,
        principalId,
      ],
    );
    assert.equal(rows.length, 1);
    fixtures.push({ before: rows[0], token, browser });
  }
  return fixtures;
}

export async function verifyInvitationRecovery(client, runtime, fixtures) {
  for (const { before, token, browser } of fixtures) {
    const restored = (
      await client.query(
        'SELECT * FROM cc.application_invitations WHERE id=$1',
        [before.id],
      )
    ).rows[0];
    const pending = ['issued', 'redeeming', 'pending'].includes(before.status);
    assert.deepEqual(
      restored,
      pending
        ? {
            ...before,
            status: 'revoked',
            token_hash: null,
            browser_hash: null,
            version: before.version + 1,
          }
        : before,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM cc.security_events WHERE target_id=$1 AND event='invitation-revoked' AND detail='restore-invalidated'",
          [before.id],
        )
      ).rows[0].count,
      pending ? 1 : 0,
    );
    assert.equal(
      (
        await runtime.query('SELECT cc.claim_invitation($1,$2,$3,$4) AS id', [
          hash(token),
          hash(browser),
          before.issuer,
          randomUUID(),
        ])
      ).rows[0].id,
      null,
    );
    const browserStatus = (
      await runtime.query(
        'SELECT cc.invitation_browser_status($1,$2) AS status',
        [hash(browser), randomUUID()],
      )
    ).rows[0].status;
    if (pending) assert.equal(browserStatus, null);
    else assert.equal(browserStatus.status, before.status);
  }
}
