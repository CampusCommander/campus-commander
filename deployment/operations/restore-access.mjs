import { randomUUID } from 'node:crypto';

/** Invalidate restored admission credentials before releasing application access. */
export async function invalidateRestoredAccess(client) {
  await client.query('BEGIN');
  try {
    const bootstrap = await client.query(
      'UPDATE cc.bootstrap_access SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL',
    );
    const invitations = await client.query(
      `WITH invalidated AS (
        UPDATE cc.application_invitations
        SET status='revoked',token_hash=NULL,browser_hash=NULL,version=version+1
        WHERE status IN ('issued','redeeming','pending') RETURNING id
      )
      INSERT INTO cc.security_events(id,event,correlation_id,target_id,resource_scope,detail)
      SELECT gen_random_uuid(),'invitation-revoked',$1,id,'{"kind":"platform"}'::jsonb,'restore-invalidated'
      FROM invalidated RETURNING id`,
      [randomUUID()],
    );
    await client.query('COMMIT');
    return {
      bootstrapCredentialsRevoked: bootstrap.rowCount,
      pendingInvitationsRevoked: invitations.rowCount,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
