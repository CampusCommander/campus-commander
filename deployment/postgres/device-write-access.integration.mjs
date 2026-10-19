import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * B6: the write check opens the active credential of one generation.
 * A caller holds devices:write at the platform scope or the district scope of the
 * customer. The envelope leaves the function still encrypted.
 */
export async function qualifyDeviceWriteAccess({ runtime, migrator, issuer }) {
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const wasActive = connection.active;
  const principals = [];
  const results = [];
  const role = (await runtime.query('SELECT current_user AS name')).rows[0]
    .name;
  const result = (text, values = []) =>
    runtime.query(text, values).then((rows) => rows.rows[0]?.result);
  const adminRow = (text, values = []) =>
    migrator.query(text, values).then((rows) => rows.rows[0]);
  const rejects = async (promise, code, detail) => {
    try {
      await promise;
    } catch (error) {
      if (code && error.code !== code)
        throw new Error(
          `error ${error.code} instead of ${code}: ${error.message}`,
        );
      if (detail && error.detail !== detail)
        throw new Error(`detail ${error.detail} instead of ${detail}`);
      return error;
    }
    throw new Error(`expected a rejection ${code ?? ''} ${detail ?? ''}`);
  };
  const createPrincipal = async (label, grants) => {
    const id = randomUUID();
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
      [id, issuer, `b6-${label}-${id}`, `B6 ${label}`],
    );
    for (const [action, scope] of grants)
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [id, action, JSON.stringify(scope)],
      );
    principals.push(id);
    return id;
  };
  const district = (action) => [
    action,
    { kind: 'district', customerId: customer },
  ];
  const read = (actor, version = 1) =>
    result('SELECT cc.device_write_credential($1,$2,$3,$4) AS result', [
      actor,
      version,
      customer,
      generation,
    ]);
  try {
    await migrator.query('UPDATE cc.google_connection SET active=true');
    const writer = await createPrincipal('writer', [district('devices:write')]);
    const platform = await createPrincipal('platform', [
      ['devices:write', { kind: 'platform' }],
    ]);
    const reader = await createPrincipal('reader', [district('devices:read')]);
    const stored = (
      await migrator.query(
        'SELECT envelope FROM cc.google_credentials WHERE id=$1',
        [connection.credential_id],
      )
    ).rows[0].envelope;

    const claim = await read(writer);
    assert.deepEqual(claim, {
      customerId: customer,
      generation,
      credentialId: connection.credential_id,
      envelope: stored,
    });
    results.push(
      'a district writer receives the active credential of the generation: pass',
    );

    assert.deepEqual(
      await read(platform),
      claim,
      'A platform writer receives the same credential.',
    );
    results.push('a platform writer receives the active credential: pass');

    await rejects(read(reader), '42501');
    results.push('devices:read alone does not open the credential: pass');

    await rejects(read(writer, 2), '42501');
    results.push(
      'a stale permission version does not open the credential: pass',
    );

    await rejects(
      result('SELECT cc.device_write_credential($1,$2,$3,$4)', [
        writer,
        1,
        customer,
        generation + 1,
      ]),
      'P0001',
      'credential-changed',
    );
    results.push('a stale generation rejects with credential-changed: pass');

    const privileges = await adminRow(
      `SELECT count(DISTINCT p.oid)=1 AS present,
        COALESCE(bool_or(a.grantee=0),false) AS public_grant,
        COALESCE(bool_or(a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1)),false) AS role_grant
       FROM pg_proc p LEFT JOIN aclexplode(p.proacl) a ON true
       WHERE p.oid=to_regprocedure('cc.device_write_credential(uuid,integer,text,integer)')`,
      [role],
    );
    assert.equal(privileges.present, true, 'The function exists.');
    assert.equal(privileges.public_grant, false, 'PUBLIC holds no EXECUTE.');
    assert.equal(
      privileges.role_grant,
      true,
      'The application role holds EXECUTE.',
    );
    results.push(
      'the application role holds EXECUTE and PUBLIC holds none: pass',
    );
  } finally {
    await migrator.query('UPDATE cc.google_connection SET active=$1', [
      wasActive,
    ]);
    for (const id of principals) {
      await migrator.query(
        'DELETE FROM cc.application_grants WHERE principal_id=$1',
        [id],
      );
      await migrator.query(
        'DELETE FROM cc.application_principals WHERE id=$1',
        [id],
      );
    }
  }
  return results;
}
