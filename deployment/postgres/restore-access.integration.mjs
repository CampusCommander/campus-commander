import assert from 'node:assert/strict';
import { invalidateRestoredAccess } from '../operations/restore-access.mjs';
import {
  seedInvitationRecovery,
  verifyInvitationRecovery,
} from '../operations/restore-access-fixture.mjs';

export async function qualifyRestoredAccess({
  runtime,
  migrator,
  principalId,
}) {
  const fixtures = await seedInvitationRecovery(migrator, principalId);
  await migrator.query('UPDATE cc.bootstrap_access SET revoked_at=NULL');
  const state = async () =>
    (
      await migrator.query(`
      SELECT 'bootstrap' AS relation, md5(row_to_json(item)::text) AS state FROM cc.bootstrap_access item
      UNION ALL SELECT 'invitation', md5(row_to_json(item)::text) FROM cc.application_invitations item
      UNION ALL SELECT 'principal', md5(row_to_json(item)::text) FROM cc.application_principals item
      UNION ALL SELECT 'grant', md5(row_to_json(item)::text) FROM cc.application_grants item
      UNION ALL SELECT 'event', md5(row_to_json(item)::text) FROM cc.security_events item
      ORDER BY relation, state
    `)
    ).rows;
  const before = await state();
  await assert.rejects(
    invalidateRestoredAccess(runtime),
    (error) => error.code === '42501',
  );
  assert.deepEqual(await state(), before);
  await migrator.query(
    "ALTER TABLE cc.security_events ADD CONSTRAINT restore_audit_failure CHECK(detail IS DISTINCT FROM 'restore-invalidated') NOT VALID",
  );
  try {
    await assert.rejects(
      invalidateRestoredAccess(migrator),
      (error) =>
        error.code === '23514' && error.constraint === 'restore_audit_failure',
    );
    assert.deepEqual(await state(), before);
  } finally {
    await migrator.query(
      'ALTER TABLE cc.security_events DROP CONSTRAINT restore_audit_failure',
    );
  }
  const expected = (
    await migrator.query(
      "SELECT count(*)::int AS count FROM cc.application_invitations WHERE status IN ('issued','redeeming','pending')",
    )
  ).rows[0].count;
  const counts = (
    await migrator.query(`SELECT
    (SELECT count(*)::int FROM cc.google_credential_candidates WHERE status IN ('verifying','ready')) AS candidates,
    (SELECT count(*)::int FROM cc.school_reviews WHERE applied_at IS NULL AND expires_at>clock_timestamp()) AS reviews`)
  ).rows[0];
  const result = await invalidateRestoredAccess(migrator);
  assert.deepEqual(result, {
    bootstrapCredentialsRevoked: 1,
    pendingInvitationsRevoked: expected,
    credentialCandidatesExpired: counts.candidates,
    schoolReviewsExpired: counts.reviews,
    googleConnection: { status: 'not-required' },
  });
  await verifyInvitationRecovery(migrator, runtime, fixtures);
  const restored = await state();
  assert.deepEqual(await invalidateRestoredAccess(migrator), {
    bootstrapCredentialsRevoked: 0,
    pendingInvitationsRevoked: 0,
    credentialCandidatesExpired: 0,
    schoolReviewsExpired: 0,
    googleConnection: { status: 'not-required' },
  });
  assert.deepEqual(await state(), restored);
  return [
    'restore invalidation requires the migration role and rolls back bootstrap, invitations, and audit together: pass',
    'restored issued, redeeming, and pending invitations reject source tokens and browser bindings: pass',
    'restore preserves terminal invitations and repeated invalidation creates no additional audit events: pass',
  ];
}
