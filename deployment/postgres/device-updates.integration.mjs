import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = async () => {
  const updates = await import(
    pathToFileURL(
      resolve(process.cwd(), 'api/src/app/devices/device-updates.ts'),
    ).href
  );
  const selection = await import(
    pathToFileURL(
      resolve(process.cwd(), 'api/src/app/devices/device-selection.ts'),
    ).href
  );
  return {
    DeviceUpdates: updates.DeviceUpdates,
    selectionStorageKey: selection.selectionStorageKey,
  };
};

/** The preview, confirmation, selection expiry, and manifest checks of card B3. */
export async function qualifyDeviceUpdates({
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
  const results = [];
  const failures = [];
  const { DeviceUpdates, selectionStorageKey } = await load();
  const actor = randomUUID();
  const key = { gridId: 'devices', tabId: 'b3' };
  const selectionKey = selectionStorageKey(actor, key);
  const selections = new Map();
  const artifacts = new Map();
  let artifactFailure = false;
  const cache = { get: async (name) => selections.get(name) ?? null };
  const storage = {
    async storeJson(document) {
      if (artifactFailure)
        throw new Error('The artifact store is unavailable.');
      const id = randomUUID();
      artifacts.set(id, document);
      return id;
    },
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const databaseFor = (client) => ({
    connection: { query: (text, values) => client.query(text, values) },
    async transaction(run) {
      await client.query('BEGIN');
      try {
        const result = await run(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  });
  const database = databaseFor(runtime);
  const updates = new DeviceUpdates(database, cache, storage);
  const current = { customerId: customer, generation };
  const grants = () => [
    {
      action: 'devices:read',
      scope: { kind: 'district', customerId: customer },
    },
    {
      action: 'devices:write',
      scope: { kind: 'district', customerId: customer },
    },
    {
      action: 'devices:bulk-actions',
      scope: { kind: 'district', customerId: customer },
    },
  ];
  const session = {
    identity: {
      id: actor,
      displayName: 'B3 preview actor',
      permissions: [],
      permissionVersion: 1,
      grants: grants(),
      preferences: {},
    },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    csrfToken: 'a'.repeat(64),
  };
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
  const rejects = async (promise, reason, status) => {
    try {
      await promise;
    } catch (error) {
      if (reason && error.getResponse?.().reason !== reason)
        throw new Error(
          `reason ${JSON.stringify(error.getResponse?.())} instead of ${reason}`,
        );
      if (status && error.getStatus?.() !== status)
        throw new Error(`status ${error.getStatus?.()} instead of ${status}`);
      return error;
    }
    throw new Error(`expected ${reason ?? 'a rejection'}`);
  };
  const raw = (extra = {}) =>
    JSON.stringify({
      terms: [],
      groups: [],
      additions: [],
      exceptions: [],
      changedAt: new Date().toISOString(),
      ...extra,
    });
  const fresh = (additions) => selections.set(selectionKey, raw({ additions }));
  const insertDevice = async (id, extra = {}) =>
    migrator.query(
      `INSERT INTO cc.devices(customer_id,device_id,serial_number,model,asset_tag,org_unit_path,
         annotated_location,status,last_entity_sync,removed_at)
       VALUES($1,$2,$3,'B3 model',$4,'/B3 School',$5,'ACTIVE',clock_timestamp(),$6)
       ON CONFLICT(customer_id,device_id) DO UPDATE SET annotated_location=EXCLUDED.annotated_location,
         removed_at=EXCLUDED.removed_at,last_entity_sync=clock_timestamp()`,
      [
        customer,
        id,
        `SN-${id}`,
        `AT-${id}`,
        extra.value ?? null,
        extra.removed ?? null,
      ],
    );
  const cleanup = async () => {
    await migrator.query(
      'DELETE FROM cc.device_update_jobs WHERE job_id IN (SELECT job_id FROM cc.jobs WHERE requested_by=$1)',
      [actor],
    );
    await migrator.query(
      'DELETE FROM cc.device_update_previews WHERE created_by=$1',
      [actor],
    );
    await migrator.query('DELETE FROM cc.jobs WHERE requested_by=$1', [actor]);
    await migrator.query(
      'DELETE FROM cc.application_grants WHERE principal_id=$1',
      [actor],
    );
    await migrator.query('DELETE FROM cc.application_principals WHERE id=$1', [
      actor,
    ]);
    await migrator.query(
      "DELETE FROM cc.devices WHERE customer_id=$1 AND device_id LIKE 'b3-%'",
      [customer],
    );
  };
  try {
    await migrator.query('UPDATE cc.google_connection SET active=true');
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
      [actor, issuer, `b3-${actor}`, 'B3 preview actor'],
    );
    for (const grant of grants())
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [actor, grant.action, JSON.stringify(grant.scope)],
      );
    await insertDevice('b3-a');
    await insertDevice('b3-b', { value: 'Room 1' });
    await insertDevice('b3-c', { value: 'Room 12' });
    await insertDevice('b3-removed', { removed: new Date() });
    fresh(['b3-a', 'b3-b', 'b3-c', 'b3-removed']);

    let preview;
    await check(
      'B3 preview freezes eligible, unchanged, and excluded targets',
      async () => {
        preview = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        assert.equal(preview.selected, 4);
        assert.equal(preview.eligible, 2);
        assert.equal(preview.unchanged, 1);
        assert.equal(preview.excluded, 1);
        const rows = (
          await migrator.query(
            `SELECT disposition FROM cc.device_update_preview_targets WHERE preview_id=$1`,
            [preview.previewId],
          )
        ).rows;
        assert.equal(rows.length, 4);
      },
    );

    let job;
    await check(
      'B3 confirmation creates one accepted job and its operations',
      async () => {
        const confirmed = await updates.confirm(
          session,
          current,
          preview.previewId,
          {
            manifestDigest: preview.manifestDigest,
            acknowledged: true,
          },
        );
        job = confirmed.receipt;
        assert.equal(confirmed.existing, false);
        assert.equal(job.status, 'accepted');
        assert.equal(job.deviceCount, 2);
        assert.equal(job.updateCount, 2);
        const ops = (
          await migrator.query(
            'SELECT device_id,status,batch FROM cc.device_update_operations WHERE job_id=$1 ORDER BY operation_number',
            [job.jobId],
          )
        ).rows;
        assert.deepEqual(
          ops.map((row) => row.device_id),
          ['b3-a', 'b3-b'],
        );
        assert.ok(
          ops.every((row) => row.status === 'pending' && row.batch === 0),
        );
      },
    );

    await check(
      'B3 a device added after the preview never joins the job',
      async () => {
        await insertDevice('b3-d');
        assert.equal(
          (
            await migrator.query(
              'SELECT count(*)::integer AS count FROM cc.device_update_operations WHERE job_id=$1',
              [job.jobId],
            )
          ).rows[0].count,
          2,
        );
        assert.equal(
          (
            await migrator.query(
              `SELECT count(*)::integer AS count FROM cc.device_update_preview_targets
             WHERE preview_id=$1 AND device_id='b3-d'`,
              [preview.previewId],
            )
          ).rows[0].count,
          0,
        );
      },
    );

    await check('B3 a second confirmation returns the same job', async () => {
      const again = await updates.confirm(session, current, preview.previewId, {
        manifestDigest: preview.manifestDigest,
        acknowledged: true,
      });
      assert.equal(again.existing, true);
      assert.equal(again.receipt.jobId, job.jobId);
      assert.equal(again.receipt.deviceCount, 2);
      assert.equal(again.receipt.updateCount, 2);
      assert.equal(
        (
          await migrator.query(
            'SELECT count(*)::integer AS count FROM cc.jobs WHERE requested_by=$1',
            [actor],
          )
        ).rows[0].count,
        1,
      );
    });

    await check('B3 the manifest artifact exists for each job', async () => {
      const row = (
        await migrator.query(
          'SELECT manifest_artifact_id FROM cc.device_update_jobs WHERE job_id=$1',
          [job.jobId],
        )
      ).rows[0];
      assert.ok(row.manifest_artifact_id);
      const document = artifacts.get(row.manifest_artifact_id);
      assert.ok(document, 'The manifest document was stored.');
      assert.equal(document.preview.previewId, preview.previewId);
      assert.equal(document.targets.length, 4);
      assert.equal(document.requester, actor);
      assert.equal(document.confirmer, actor);
    });

    await check('B3 a digest mismatch gives 409 preview-changed', async () => {
      fresh(['b3-a']);
      const other = await updates.preview(session, current, {
        ...key,
        mode: 'replace',
        value: 'Room 12',
      });
      await rejects(
        updates.confirm(session, current, other.previewId, {
          manifestDigest: '0'.repeat(64),
          acknowledged: true,
        }),
        'preview-changed',
        409,
      );
    });

    await check('B3 an expired preview gives 410 preview-expired', async () => {
      fresh(['b3-a']);
      const other = await updates.preview(session, current, {
        ...key,
        mode: 'replace',
        value: 'Room 12',
      });
      await migrator.query(
        "UPDATE cc.device_update_previews SET expires_at=clock_timestamp()-interval '1 minute' WHERE preview_id=$1",
        [other.previewId],
      );
      await rejects(
        updates.previewById(session, other.previewId),
        'preview-expired',
        410,
      );
      await rejects(
        updates.confirm(session, current, other.previewId, {
          manifestDigest: other.manifestDigest,
          acknowledged: true,
        }),
        'preview-expired',
        410,
      );
    });

    await check(
      'B3 zero eligible targets give 422 nothing-to-update',
      async () => {
        fresh(['b3-c']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        assert.equal(other.eligible, 0);
        await rejects(
          updates.confirm(session, current, other.previewId, {
            manifestDigest: other.manifestDigest,
            acknowledged: true,
          }),
          'nothing-to-update',
          422,
        );
      },
    );

    await check('B3 a grant change gives 409 permission-changed', async () => {
      fresh(['b3-a']);
      const other = await updates.preview(session, current, {
        ...key,
        mode: 'replace',
        value: 'Room 12',
      });
      await migrator.query(
        "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='devices:bulk-actions'",
        [actor],
      );
      await rejects(
        updates.confirm(session, current, other.previewId, {
          manifestDigest: other.manifestDigest,
          acknowledged: true,
        }),
        'permission-changed',
        409,
      );
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [
          actor,
          'devices:bulk-actions',
          JSON.stringify({ kind: 'district', customerId: customer }),
        ],
      );
    });

    await check(
      'B3 a connection change gives 409 connection-changed',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        await migrator.query('UPDATE cc.google_connection SET active=false');
        try {
          await rejects(
            updates.confirm(session, current, other.previewId, {
              manifestDigest: other.manifestDigest,
              acknowledged: true,
            }),
            'connection-changed',
            409,
          );
        } finally {
          await migrator.query('UPDATE cc.google_connection SET active=true');
        }
      },
    );

    await check(
      'B3 an expired selection gives expiredAt and 409 selection-expired',
      async () => {
        const changedAt = new Date(
          Date.now() - 13 * 60 * 60 * 1000,
        ).toISOString();
        selections.set(selectionKey, raw({ additions: ['b3-a'], changedAt }));
        const error = await rejects(
          updates.preview(session, current, { ...key, mode: 'clear' }),
          'selection-expired',
          409,
        );
        assert.equal(
          error.getResponse().expiredAt,
          new Date(Date.parse(changedAt) + 12 * 60 * 60 * 1000).toISOString(),
        );
      },
    );

    await check(
      'B3 an approved job keeps its operations after the selection expires',
      async () => {
        assert.equal(
          (
            await migrator.query(
              'SELECT count(*)::integer AS count FROM cc.device_update_operations WHERE job_id=$1',
              [job.jobId],
            )
          ).rows[0].count,
          2,
        );
        const again = await updates.confirm(
          session,
          current,
          preview.previewId,
          {
            manifestDigest: preview.manifestDigest,
            acknowledged: true,
          },
        );
        assert.equal(again.existing, true);
        assert.equal(again.receipt.jobId, job.jobId);
      },
    );

    await check('B3 an unexpired preview stays confirmable', async () => {
      fresh(['b3-a']);
      const other = await updates.preview(session, current, {
        ...key,
        mode: 'replace',
        value: 'Room 12',
      });
      const confirmed = await updates.confirm(
        session,
        current,
        other.previewId,
        {
          manifestDigest: other.manifestDigest,
          acknowledged: true,
        },
      );
      assert.equal(confirmed.existing, false);
      assert.equal(confirmed.receipt.deviceCount, 1);
    });

    await check('B3 an artifact failure fails the confirmation', async () => {
      fresh(['b3-a']);
      const other = await updates.preview(session, current, {
        ...key,
        mode: 'replace',
        value: 'Room 12',
      });
      const before = (
        await migrator.query(
          'SELECT count(*)::integer AS count FROM cc.jobs WHERE requested_by=$1',
          [actor],
        )
      ).rows[0].count;
      artifactFailure = true;
      try {
        await rejects(
          updates.confirm(session, current, other.previewId, {
            manifestDigest: other.manifestDigest,
            acknowledged: true,
          }),
          undefined,
          undefined,
        );
      } finally {
        artifactFailure = false;
      }
      assert.equal(
        (
          await migrator.query(
            'SELECT count(*)::integer AS count FROM cc.jobs WHERE requested_by=$1',
            [actor],
          )
        ).rows[0].count,
        before,
      );
    });

    await check(
      'B3 the runtime role cannot write a preview, job, or operation table',
      async () => {
        const writer = await connect('cc-app', 'cc-app');
        const tables = [
          'cc.device_update_previews',
          'cc.device_update_preview_targets',
          'cc.jobs',
          'cc.device_update_jobs',
          'cc.device_update_operations',
        ];
        const statements = [
          'INSERT INTO cc.device_update_previews SELECT * FROM cc.device_update_previews LIMIT 0',
          'UPDATE cc.device_update_previews SET job_id=job_id WHERE false',
          'INSERT INTO cc.device_update_preview_targets SELECT * FROM cc.device_update_preview_targets LIMIT 0',
          'UPDATE cc.device_update_preview_targets SET serial_number=serial_number WHERE false',
          'INSERT INTO cc.jobs SELECT * FROM cc.jobs LIMIT 0',
          'UPDATE cc.jobs SET revision=revision WHERE false',
          'INSERT INTO cc.device_update_jobs SELECT * FROM cc.device_update_jobs LIMIT 0',
          'UPDATE cc.device_update_jobs SET value=value WHERE false',
          'INSERT INTO cc.device_update_operations SELECT * FROM cc.device_update_operations LIMIT 0',
          'UPDATE cc.device_update_operations SET status=status WHERE false',
        ];
        try {
          for (const table of tables)
            assert.equal(
              (
                await migrator.query(
                  `SELECT has_table_privilege('cc-app',$1,'INSERT') AS held`,
                  [table],
                )
              ).rows[0].held,
              false,
              `The runtime role holds no INSERT on ${table}.`,
            );
          for (const text of statements) {
            await writer.query('BEGIN');
            const code = await writer.query(text).then(
              () => 'allowed',
              (error) => error.code,
            );
            await writer.query('ROLLBACK');
            assert.equal(code, '42501', `${text} is denied.`);
          }
        } finally {
          await writer.end();
        }
      },
    );

    await check(
      'B3 preview creation rejects a principal without devices:bulk-actions',
      async () => {
        const limited = randomUUID();
        const limitedKey = selectionStorageKey(limited, key);
        await migrator.query(
          'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
          [limited, issuer, `b3-limited-${limited}`, 'B3 limited actor'],
        );
        await migrator.query(
          'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
          [
            limited,
            'devices:write',
            JSON.stringify({ kind: 'district', customerId: customer }),
          ],
        );
        selections.set(limitedKey, raw({ additions: ['b3-a'] }));
        try {
          await assert.rejects(
            updates.preview(
              {
                ...session,
                identity: { ...session.identity, id: limited },
              },
              current,
              { ...key, mode: 'clear' },
            ),
            (error) => {
              assert.equal(error.getStatus(), 403);
              return true;
            },
          );
        } finally {
          await migrator.query(
            'DELETE FROM cc.device_update_previews WHERE created_by=$1',
            [limited],
          );
          await migrator.query(
            'DELETE FROM cc.application_grants WHERE principal_id=$1',
            [limited],
          );
          await migrator.query(
            'DELETE FROM cc.application_principals WHERE id=$1',
            [limited],
          );
        }
      },
    );

    await check(
      'B3 a lost grant stores no manifest artifact before the refusal',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        await migrator.query(
          "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='devices:bulk-actions'",
          [actor],
        );
        const stored = [];
        const revoked = new DeviceUpdates(database, cache, {
          async storeJson(document) {
            stored.push(document);
            return randomUUID();
          },
        });
        try {
          await rejects(
            revoked.confirm(session, current, other.previewId, {
              manifestDigest: other.manifestDigest,
              acknowledged: true,
            }),
            'permission-changed',
            409,
          );
          assert.equal(stored.length, 0);
        } finally {
          await migrator.query(
            'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
            [
              actor,
              'devices:bulk-actions',
              JSON.stringify({ kind: 'district', customerId: customer }),
            ],
          );
        }
      },
    );

    await check(
      'B3 two concurrent confirmations create exactly one job',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        const left = await connect('cc-app', 'cc-app');
        const right = await connect('cc-app', 'cc-app');
        try {
          const one = new DeviceUpdates(databaseFor(left), cache, storage);
          const two = new DeviceUpdates(databaseFor(right), cache, storage);
          const [first, second] = await Promise.all([
            one.confirm(session, current, other.previewId, {
              manifestDigest: other.manifestDigest,
              acknowledged: true,
            }),
            two.confirm(session, current, other.previewId, {
              manifestDigest: other.manifestDigest,
              acknowledged: true,
            }),
          ]);
          assert.equal(first.receipt.jobId, second.receipt.jobId);
          assert.equal(
            (
              await migrator.query(
                `SELECT count(*)::integer AS count FROM cc.jobs j
                 JOIN cc.device_update_previews p ON p.job_id=j.job_id
                 WHERE p.preview_id=$1`,
                [other.previewId],
              )
            ).rows[0].count,
            1,
          );
        } finally {
          await left.end();
          await right.end();
        }
      },
    );

    await check(
      'B3 confirmation takes the global access lock before its preview row',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        const holder = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        const observer = await connect('cc-migrator', 'cc-app');
        let pending;
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT pg_advisory_xact_lock(7240173008)');
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const callerPid = (
            await caller.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          pending = new DeviceUpdates(databaseFor(caller), cache, storage)
            .confirm(session, current, other.previewId, {
              manifestDigest: other.manifestDigest,
              acknowledged: true,
            })
            .then(
              (value) => ({ value }),
              (error) => ({ error }),
            );
          let waited = false;
          for (let round = 0; round < 200; round += 1) {
            const held = (
              await migrator.query(
                'SELECT pg_blocking_pids($1::int) && $2::int[] AS held',
                [callerPid, [holderPid]],
              )
            ).rows[0].held;
            if (held === true) {
              waited = true;
              break;
            }
            await sleep(25);
          }
          assert.equal(
            waited,
            true,
            'The confirmation waits for the global access lock.',
          );
          const free = await observer
            .query(
              'SELECT 1 FROM cc.device_update_previews WHERE preview_id=$1 FOR UPDATE NOWAIT',
              [other.previewId],
            )
            .then(
              () => true,
              (error) => error.code,
            );
          assert.equal(
            free,
            true,
            'The confirmation holds no preview row while it waits.',
          );
          await holder.query('COMMIT');
          const answer = await pending;
          assert.equal(answer.error, undefined);
          assert.equal(answer.value.existing, false);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (pending) await pending;
          await Promise.allSettled([
            holder.end(),
            caller.end(),
            observer.end(),
          ]);
        }
      },
    );
  } finally {
    await migrator.query('UPDATE cc.google_connection SET active=$1', [
      wasActive,
    ]);
    await migrator.query(
      'UPDATE cc.google_connection SET generation=$2 WHERE customer_id=$1',
      [customer, generation],
    );
    await cleanup().catch(() => undefined);
  }
  if (failures.length)
    throw new Error(`Device update checks failed: ${failures.join(' | ')}`);
  return results;
}
