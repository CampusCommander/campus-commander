import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * B6: the write check opens the active credential of one generation.
 * A caller holds devices:write at the platform scope or the district scope of the
 * customer. The envelope leaves the function still encrypted.
 */
export async function qualifyDeviceWriteAccess({
  runtime,
  migrator,
  connect,
  issuer,
}) {
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const wasActive = connection.active;
  const principals = [];
  const results = [];
  const failures = [];
  const role = (await runtime.query('SELECT current_user AS name')).rows[0]
    .name;
  const result = (text, values = []) =>
    runtime.query(text, values).then((rows) => rows.rows[0]?.result);
  const adminRow = (text, values = []) =>
    migrator.query(text, values).then((rows) => rows.rows[0]);
  const settle = (promise) =>
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const check = async (name, body) => {
    try {
      await body();
      results.push(`${name}: pass`);
    } catch (error) {
      failures.push(name);
      results.push(`${name}: FAIL ${error.message}`);
    }
    process.stderr.write(`check ${results.at(-1)}\n`);
  };
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
  const writerRow = (actor, version = 1) =>
    runtime
      .query('SELECT customer_id,generation FROM cc.device_writer($1,$2)', [
        actor,
        version,
      ])
      .then((rows) => rows.rows[0]);
  const sleep = (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
  const waitForBlock = async (waiterPid, holderPid) => {
    for (let round = 0; round < 200; round += 1) {
      const held = (
        await migrator.query(
          'SELECT pg_blocking_pids($1::int) && $2::int[] AS held',
          [waiterPid, [holderPid]],
        )
      ).rows[0].held;
      if (held === true) return;
      await sleep(25);
    }
    throw new Error('The credential read never waited on the global lock.');
  };
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

    await check(
      'B6 the runtime role cannot select the credential table directly',
      async () => {
        const direct = await rejects(
          runtime.query('SELECT envelope FROM cc.google_credentials'),
          '42501',
        );
        assert.equal(direct.code, '42501');
      },
    );

    await check(
      'B6 cc.device_writer resolves district and platform writers and rejects readers',
      async () => {
        const present = await adminRow(
          `SELECT to_regprocedure('cc.device_writer(uuid,integer)') IS NOT NULL AS present`,
        );
        assert.equal(
          present.present,
          true,
          'The cc.device_writer function exists.',
        );
        const districtWriter = await settle(writerRow(writer));
        assert.equal(
          districtWriter.error,
          undefined,
          `cc.device_writer answers a district writer: ${districtWriter.error}`,
        );
        assert.deepEqual(districtWriter.value, {
          customer_id: customer,
          generation,
        });
        const platformWriter = await settle(writerRow(platform));
        assert.equal(
          platformWriter.error,
          undefined,
          `cc.device_writer answers a platform writer: ${platformWriter.error}`,
        );
        assert.deepEqual(platformWriter.value, {
          customer_id: customer,
          generation,
        });
        const districtReader = await settle(writerRow(reader));
        assert.equal(
          districtReader.value,
          undefined,
          `cc.device_writer answers a devices:read caller: ${JSON.stringify(districtReader.value)}`,
        );
        assert.equal(
          districtReader.error?.code,
          '42501',
          'A devices:read caller rejects 42501.',
        );
        const staleWriter = await settle(writerRow(writer, 2));
        assert.equal(
          staleWriter.error?.code,
          '42501',
          'A stale permission version rejects 42501.',
        );
      },
    );

    await check(
      'B1 a devices:wipe or devices:deprovision principal alone opens the write access',
      async () => {
        for (const action of ['devices:wipe', 'devices:deprovision']) {
          const solo = await createPrincipal(action.replace(':', '-'), [
            district(action),
          ]);
          const opened = await settle(read(solo));
          assert.equal(
            opened.error,
            undefined,
            `cc.device_write_credential answers a ${action} caller: ${opened.error}`,
          );
          assert.deepEqual(
            opened.value,
            claim,
            `A ${action} caller receives the active credential.`,
          );
          const row = await settle(writerRow(solo));
          assert.equal(
            row.error,
            undefined,
            `cc.device_writer answers a ${action} caller: ${row.error}`,
          );
          assert.deepEqual(row.value, { customer_id: customer, generation });
        }
      },
    );

    await check(
      'B6 both write-access routes pass a devices:write-only principal through the real SQL chain',
      async () => {
        const routes = await import(
          pathToFileURL(
            resolve(
              process.cwd(),
              'api/src/app/devices/device-write-access-routes.ts',
            ),
          ).href
        );
        const { ForbiddenException } = await import('@nestjs/common');
        assert.equal(
          routes.DeviceWriteAccessRoutes.length,
          1,
          'The routes take the write-access port as their only constructor argument.',
        );
        const projection = {
          state: 'granted',
          scope:
            'https://www.googleapis.com/auth/admin.directory.device.chromeos',
          failure: null,
          checkedAt: '2026-10-19T10:00:00.000Z',
        };
        const correlation = randomUUID();
        const routeFor = () =>
          new routes.DeviceWriteAccessRoutes({
            connection: async (received) => {
              const answer = await settle(
                runtime.query(
                  'SELECT customer_id,generation FROM cc.device_writer($1,$2)',
                  [received.identity.id, received.identity.permissionVersion],
                ),
              );
              if (answer.error?.code === '42501')
                throw new ForbiddenException({ reason: 'forbidden' });
              if (answer.error) throw answer.error;
              const row = answer.value.rows[0];
              return row.customer_id === null
                ? null
                : { customerId: row.customer_id, generation: row.generation };
            },
            read: async () => projection,
            check: async () => projection,
          });
        for (const [label, principal] of [
          ['district', writer],
          ['platform', platform],
        ]) {
          const session = {
            identity: { id: principal, permissionVersion: 1 },
          };
          const access = routeFor();
          const readAnswer = await settle(access.read(session, correlation));
          assert.equal(
            readAnswer.error,
            undefined,
            `GET passes for a ${label} devices:write writer: ${readAnswer.error}`,
          );
          assert.deepEqual(readAnswer.value, projection);
          const checkAnswer = await settle(access.check(session, correlation));
          assert.equal(
            checkAnswer.error,
            undefined,
            `POST passes for a ${label} devices:write writer: ${checkAnswer.error}`,
          );
          assert.deepEqual(checkAnswer.value, projection);
        }
        const readerSession = {
          identity: { id: reader, permissionVersion: 1 },
        };
        const readerAnswer = await settle(
          routeFor().read(readerSession, correlation),
        );
        assert.equal(
          readerAnswer.value,
          undefined,
          'A reader receives no state.',
        );
        assert.equal(
          readerAnswer.error?.getStatus?.(),
          403,
          'A reader receives 403 on the access route.',
        );
      },
    );

    await check(
      'B6 an inactive connection and an unverified restore gate reject with their details',
      async () => {
        await migrator.query('UPDATE cc.google_connection SET active=false');
        try {
          const disconnected = await rejects(
            read(writer),
            'P0001',
            'connection-disconnected',
          );
          assert.equal(disconnected.detail, 'connection-disconnected');
        } finally {
          await migrator.query('UPDATE cc.google_connection SET active=true');
        }
        const prior = (
          await migrator.query('SELECT * FROM cc.google_restore_gate')
        ).rows[0];
        await migrator.query('DELETE FROM cc.google_restore_gate');
        try {
          await migrator.query(
            `INSERT INTO cc.google_restore_gate(singleton,recovery_id,customer_id,credential_id,generation)
             VALUES(true,$1,$2,$3,$4)`,
            [randomUUID(), customer, connection.credential_id, generation],
          );
          await rejects(read(writer), 'P0001', 'restore-revalidation-required');
        } finally {
          await migrator.query('DELETE FROM cc.google_restore_gate');
          if (prior)
            await migrator.query(
              `INSERT INTO cc.google_restore_gate(singleton,recovery_id,customer_id,credential_id,generation,restored_at,verified_at)
               VALUES(true,$1,$2,$3,$4,$5,$6)`,
              [
                prior.recovery_id,
                prior.customer_id,
                prior.credential_id,
                prior.generation,
                prior.restored_at,
                prior.verified_at,
              ],
            );
        }
      },
    );

    await check(
      'B6 a revoked principal answers 42501 before a moved generation answers 409',
      async () => {
        const revoked = await createPrincipal('precedence', [
          district('devices:write'),
        ]);
        await migrator.query(
          "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='devices:write'",
          [revoked],
        );
        await rejects(
          result('SELECT cc.device_write_credential($1,$2,$3,$4)', [
            revoked,
            1,
            customer,
            generation + 1,
          ]),
          '42501',
        );
      },
    );

    await check(
      'B6 a revocation during the global lock wait releases no envelope',
      async () => {
        const volatility = await adminRow(
          `SELECT provolatile FROM pg_proc
           WHERE oid=to_regprocedure('cc.device_write_credential(uuid,integer,text,integer)')`,
        );
        assert.equal(
          volatility.provolatile,
          'v',
          'The credential read stays VOLATILE.',
        );
        const revoked = await createPrincipal('revoked', [
          district('devices:write'),
        ]);
        const holder = await connect('cc-migrator', 'cc-app');
        const waiter = await connect('cc-app', 'cc-app');
        try {
          const waiterPid = (
            await waiter.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          await holder.query('BEGIN');
          await holder.query('SELECT pg_advisory_xact_lock(7240173008)');
          const pending = settle(
            waiter.query(
              'SELECT cc.device_write_credential($1,$2,$3,$4) AS result',
              [revoked, 1, customer, generation],
            ),
          );
          await waitForBlock(waiterPid, holderPid);
          await holder.query(
            'UPDATE cc.application_principals SET enabled=false,permission_version=permission_version+1 WHERE id=$1',
            [revoked],
          );
          await holder.query(
            "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='devices:write'",
            [revoked],
          );
          await holder.query('COMMIT');
          const answer = await pending;
          assert.equal(
            answer.value,
            undefined,
            `A revoked writer receives no envelope: ${JSON.stringify(answer.value)}`,
          );
          assert.equal(
            answer.error?.code,
            '42501',
            'A revocation during the lock wait rejects 42501.',
          );
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await Promise.allSettled([holder.end(), waiter.end()]);
        }
      },
    );

    await check(
      'B6 a re-grant during the global lock wait returns the envelope',
      async () => {
        const regranted = await createPrincipal('regranted', [
          district('devices:write'),
        ]);
        const holder = await connect('cc-migrator', 'cc-app');
        const waiter = await connect('cc-app', 'cc-app');
        try {
          const waiterPid = (
            await waiter.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          await holder.query('BEGIN');
          await holder.query('SELECT pg_advisory_xact_lock(7240173008)');
          const pending = settle(
            waiter.query(
              'SELECT cc.device_write_credential($1,$2,$3,$4) AS result',
              [regranted, 1, customer, generation],
            ),
          );
          await waitForBlock(waiterPid, holderPid);
          await holder.query(
            "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='devices:write'",
            [regranted],
          );
          await holder.query(
            "INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,'devices:write',$2)",
            [
              regranted,
              JSON.stringify({ kind: 'district', customerId: customer }),
            ],
          );
          await holder.query('COMMIT');
          const answer = await pending;
          assert.equal(
            answer.error,
            undefined,
            `A re-granted writer receives the envelope: ${answer.error}`,
          );
          assert.deepEqual(answer.value.rows[0].result, {
            customerId: customer,
            generation,
            credentialId: connection.credential_id,
            envelope: stored,
          });
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await Promise.allSettled([holder.end(), waiter.end()]);
        }
      },
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
  if (failures.length)
    throw new Error(
      `Device write access checks failed: ${failures.join(' | ')}`,
    );
  return results;
}
