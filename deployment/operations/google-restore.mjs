import { randomUUID } from 'node:crypto';
import {
  CredentialCipher,
  GoogleCustomerVerifier,
  googleObservationSchema,
} from '../../dist/deployment/google-runtime.mjs';

/** Call within the restore invalidation transaction, with application services stopped. */
export async function prepareGoogleRestore(client, recoveryId) {
  const candidates = await client.query(
    `WITH expired AS (
      UPDATE cc.google_credential_candidates SET status='expired',envelope=NULL
      WHERE status IN ('verifying','ready') RETURNING id
    )
    INSERT INTO cc.security_events(id,event,correlation_id,target_id,resource_scope,detail)
    SELECT gen_random_uuid(),'connection-stage-expired',$1,id,'{"kind":"platform"}'::jsonb,'restore-invalidated'
    FROM expired RETURNING id`,
    [recoveryId],
  );
  const reviews = await client.query(
    `WITH expired AS (
      UPDATE cc.school_reviews SET expires_at=clock_timestamp()
      WHERE applied_at IS NULL AND expires_at>clock_timestamp() RETURNING school_id,customer_id
    )
    INSERT INTO cc.security_events(id,event,correlation_id,target_id,resource_scope,detail)
    SELECT gen_random_uuid(),'recovery-required',$1,school_id,
      jsonb_build_object('kind','school','customerId',customer_id,'schoolId',school_id),'restore-review-expired'
    FROM expired RETURNING id`,
    [recoveryId],
  );
  await client.query('DELETE FROM cc.google_access_tokens');
  await client.query('DELETE FROM cc.google_health_checks');
  await client.query(`UPDATE cc.school_reference_state SET lease_id=NULL,lease_actor=NULL,lease_version=NULL,
    lease_generation=NULL,lease_expires_at=NULL,retry_at=NULL`);
  await client.query('DELETE FROM cc.google_restore_gate');
  const { rows } = await client.query(
    `INSERT INTO cc.google_restore_gate(singleton,recovery_id,customer_id,credential_id,generation)
     SELECT true,$1,customer_id,credential_id,generation FROM cc.google_connection WHERE active
     RETURNING customer_id,generation`,
    [recoveryId],
  );
  if (rows.length) {
    await client.query(
      `INSERT INTO cc.security_events(id,event,correlation_id,target_id,resource_scope,detail)
       SELECT gen_random_uuid(),'recovery-required',recovery_id,credential_id,
         jsonb_build_object('kind','district','customerId',customer_id),'restore-google-blocked'
       FROM cc.google_restore_gate`,
    );
  }
  return {
    credentialCandidatesExpired: candidates.rowCount,
    schoolReviewsExpired: reviews.rowCount,
    googleConnection: rows.length
      ? {
          status: 'revalidation-required',
          recoveryId,
          customerId: rows[0].customer_id,
          generation: rows[0].generation,
        }
      : { status: 'not-required' },
  };
}

/** Verify the recorded credential under the same authority lock used by Google reads. */
export async function revalidateGoogleRestore({
  client,
  recoveryId,
  keyConfiguration,
  resolveSecret,
  verifier = new GoogleCustomerVerifier(),
}) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(7240173008)');
    const { rows } = await client.query(`
      SELECT g.recovery_id,g.customer_id,g.credential_id,g.generation,g.verified_at,
        c.active,c.credential_id AS current_credential_id,c.generation AS current_generation,
        c.encryption_key_id,d.envelope,d.client_id,d.delegated_subject
      FROM cc.google_restore_gate g JOIN cc.google_connection c ON c.customer_id=g.customer_id
      JOIN cc.google_credentials d ON d.id=c.credential_id
      WHERE g.singleton FOR UPDATE OF g,c
    `);
    const state = rows[0];
    if (
      !state ||
      state.recovery_id !== recoveryId ||
      !state.active ||
      state.credential_id !== state.current_credential_id ||
      state.generation !== state.current_generation
    )
      throw new Error('Restored Google credential state changed.');
    if (state.verified_at) {
      await client.query('COMMIT');
      return {
        status: 'already-revalidated',
        recoveryId,
        customerId: state.customer_id,
        generation: state.generation,
        verifiedAt: state.verified_at.toISOString(),
      };
    }
    const reference = [
      keyConfiguration,
      ...(keyConfiguration?.additionalKeys ?? []),
    ].find(
      (entry) => entry?.keyId === state.encryption_key_id,
    )?.encryptionKeySecretRef;
    if (!reference)
      throw new Error('Restored Google encryption key is unavailable.');
    let material;
    let credential;
    try {
      material = Buffer.from(await resolveSecret(reference));
      credential = new CredentialCipher(state.encryption_key_id, material).open(
        state.envelope,
        {
          recordId: state.credential_id,
          customerId: state.customer_id,
          generation: state.generation,
        },
      );
    } catch (error) {
      if (error?.code === 'ENOENT')
        throw new Error('Restored Google encryption key is unavailable.');
      throw new Error('Restored Google encryption key verification failed.');
    } finally {
      material?.fill(0);
    }
    if (
      credential.serviceAccount.client_id !== state.client_id ||
      credential.subject !== state.delegated_subject
    )
      throw new Error('Restored Google credential state changed.');
    const observation = googleObservationSchema.parse(
      await verifier.verify(credential),
    );
    if (observation.customerId !== state.customer_id)
      throw new Error('Restored Google customer verification failed.');
    await client.query(
      'UPDATE cc.google_connection SET observation=$1,observed_at=clock_timestamp() WHERE singleton',
      [JSON.stringify(observation)],
    );
    const verified = (
      await client.query(
        'UPDATE cc.google_restore_gate SET verified_at=clock_timestamp() WHERE singleton RETURNING verified_at',
      )
    ).rows[0].verified_at;
    await client.query(
      `INSERT INTO cc.security_events(id,event,correlation_id,target_id,resource_scope,detail)
       VALUES($1,'connection-checked',$2,$3,$4,'restore-revalidated')`,
      [
        randomUUID(),
        recoveryId,
        state.credential_id,
        JSON.stringify({ kind: 'district', customerId: state.customer_id }),
      ],
    );
    await client.query('COMMIT');
    return {
      status: 'revalidated',
      recoveryId,
      customerId: state.customer_id,
      generation: state.generation,
      verifiedAt: verified.toISOString(),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
