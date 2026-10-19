import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  const actions = await import(
    pathToFileURL(
      resolve(process.cwd(), 'api/src/app/devices/device-updates-actions.ts'),
    ).href
  );
  const authorize = await import(
    pathToFileURL(
      resolve(process.cwd(), 'api/src/app/auth/authorize-action.ts'),
    ).href
  );
  const artifacts = await import(
    pathToFileURL(
      resolve(process.cwd(), 'api/src/app/storage/json-artifact.ts'),
    ).href
  );
  const store = await import(
    pathToFileURL(resolve(process.cwd(), 'deployment/storage/index.mjs')).href
  );
  return {
    DeviceUpdates: updates.DeviceUpdates,
    selectionStorageKey: selection.selectionStorageKey,
    requireDeviceUpdateActions: actions.requireDeviceUpdateActions,
    authorizeAction: authorize.authorizeAction,
    storeJsonDocument: artifacts.storeJsonDocument,
    createArtifactStore: store.createArtifactStore,
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
  const {
    DeviceUpdates,
    selectionStorageKey,
    requireDeviceUpdateActions,
    authorizeAction,
    storeJsonDocument,
    createArtifactStore,
  } = await load();
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
  // R1-F4: the real artifact store writes cc.artifacts and the filesystem, so the
  // reference protocol is tested against both instead of a Map.
  const artifactDirectory = await mkdtemp(join(tmpdir(), 'cc-b3-artifacts-'));
  await chmod(artifactDirectory, 0o700);
  const storePool = {
    async connect() {
      const client = await connect('cc-app', 'cc-app');
      return {
        query: (text, values) => client.query(text, values),
        release: async () => {
          await client.end().catch(() => undefined);
        },
      };
    },
  };
  const artifactStore = await createArtifactStore({
    pool: storePool,
    root: artifactDirectory,
    backend: 'local',
  });
  const realStorage = {
    storeJson: (document) => storeJsonDocument(artifactStore, document),
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
    assert.fail(`expected ${reason ?? 'a rejection'}`);
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
  const createPrincipal = async (label, actions) => {
    const id = randomUUID();
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
      [id, issuer, `b3-${label}-${id}`, `B3 ${label}`],
    );
    for (const action of actions)
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [
          id,
          action,
          JSON.stringify({ kind: 'district', customerId: customer }),
        ],
      );
    return id;
  };
  const removePrincipal = async (id) => {
    await migrator.query(
      'DELETE FROM cc.device_update_jobs WHERE job_id IN (SELECT job_id FROM cc.jobs WHERE requested_by=$1)',
      [id],
    );
    await migrator.query(
      'DELETE FROM cc.device_update_previews WHERE created_by=$1',
      [id],
    );
    await migrator.query('DELETE FROM cc.jobs WHERE requested_by=$1', [id]);
    await migrator.query(
      'DELETE FROM cc.application_grants WHERE principal_id=$1',
      [id],
    );
    await migrator.query('DELETE FROM cc.application_principals WHERE id=$1', [
      id,
    ]);
  };
  const sessionFor = (id, version, grants = session.identity.grants) => ({
    ...session,
    identity: { ...session.identity, id, permissionVersion: version, grants },
  });
  const recordingStorage = () => {
    const stored = [];
    return {
      stored,
      storage: {
        async storeJson(document) {
          const id = randomUUID();
          stored.push({ id, document });
          return id;
        },
      },
    };
  };
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
      'B3 a matching device added between the preview and the confirmation never joins',
      async () => {
        selections.set(
          selectionKey,
          raw({
            terms: [
              [
                {
                  field: 'serialNumber',
                  operator: 'startsWith',
                  value: 'SN-b3-',
                },
              ],
            ],
          }),
        );
        const frozen = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        assert.equal(frozen.selected, 3);
        assert.equal(frozen.eligible, 2);
        assert.equal(frozen.unchanged, 1);
        // The device matches the selection and arrives before the first confirmation.
        await insertDevice('b3-d');
        const confirmed = await updates.confirm(
          session,
          current,
          frozen.previewId,
          {
            manifestDigest: frozen.manifestDigest,
            acknowledged: true,
          },
        );
        const operations = (
          await migrator.query(
            'SELECT device_id FROM cc.device_update_operations WHERE job_id=$1 ORDER BY operation_number',
            [confirmed.receipt.jobId],
          )
        ).rows.map((row) => row.device_id);
        assert.deepEqual(
          operations,
          ['b3-a', 'b3-b'],
          'Only the frozen eligible targets become operations.',
        );
        assert.equal(
          (
            await migrator.query(
              `SELECT count(*)::integer AS count FROM cc.device_update_preview_targets
               WHERE preview_id=$1 AND device_id='b3-d'`,
              [frozen.previewId],
            )
          ).rows[0].count,
          0,
          'The added device never joins the frozen targets.',
        );
      },
    );

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
            `SELECT count(*)::integer AS count FROM cc.jobs j
             JOIN cc.device_update_previews p ON p.job_id=j.job_id
             WHERE p.preview_id=$1`,
            [preview.previewId],
          )
        ).rows[0].count,
        1,
      );
    });

    const confirmDuplicate = async (preview, version = 1) =>
      (
        await database.connection.query(
          `SELECT cc.confirm_device_update_preview($1::uuid,$2::integer,$3::text,
            $4::uuid,$5::text,$6::text,$7::uuid) AS result`,
          [
            actor,
            version,
            customer,
            preview.previewId,
            preview.manifestDigest,
            randomUUID(),
            randomUUID(),
          ],
        )
      ).rows[0].result;

    await check(
      'B3 a revoked grant blocks a duplicate confirmation',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        const first = await updates.confirm(session, current, other.previewId, {
          manifestDigest: other.manifestDigest,
          acknowledged: true,
        });
        assert.equal(first.existing, false);
        await migrator.query(
          "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='devices:bulk-actions'",
          [actor],
        );
        try {
          const result = await confirmDuplicate(other);
          assert.equal(
            result.outcome,
            'permission-changed',
            'The final function checks the grant before the existing receipt.',
          );
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
            'The refused duplicate creates no second job.',
          );
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
      'B3 a disabled principal gets no duplicate confirmation receipt',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        const first = await updates.confirm(session, current, other.previewId, {
          manifestDigest: other.manifestDigest,
          acknowledged: true,
        });
        assert.equal(first.existing, false);
        await migrator.query(
          'UPDATE cc.application_principals SET enabled=false WHERE id=$1',
          [actor],
        );
        try {
          const result = await confirmDuplicate(other);
          assert.equal(result.outcome, 'permission-changed');
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
          await migrator.query(
            'UPDATE cc.application_principals SET enabled=true WHERE id=$1',
            [actor],
          );
        }
      },
    );

    await check(
      'B3 an obsolete session version gets no duplicate confirmation receipt',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        const first = await updates.confirm(session, current, other.previewId, {
          manifestDigest: other.manifestDigest,
          acknowledged: true,
        });
        assert.equal(first.existing, false);
        await migrator.query(
          'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
          [actor],
        );
        try {
          const result = await confirmDuplicate(other, 1);
          assert.equal(result.outcome, 'permission-changed');
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
          await migrator.query(
            'UPDATE cc.application_principals SET permission_version=1 WHERE id=$1',
            [actor],
          );
        }
      },
    );

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

    await check(
      'B3 confirmation references the published manifest artifact',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        const confirmed = await new DeviceUpdates(
          database,
          cache,
          realStorage,
        ).confirm(session, current, other.previewId, {
          manifestDigest: other.manifestDigest,
          acknowledged: true,
        });
        const artifactId = (
          await migrator.query(
            'SELECT manifest_artifact_id FROM cc.device_update_jobs WHERE job_id=$1',
            [confirmed.receipt.jobId],
          )
        ).rows[0].manifest_artifact_id;
        const artifact = (
          await migrator.query('SELECT * FROM cc.artifacts WHERE id=$1', [
            artifactId,
          ])
        ).rows[0];
        assert.equal(artifact.publication_state, 'ready');
        assert.equal(artifact.active, false);
        assert.equal(
          artifact.reference_count,
          1,
          'The job references its manifest artifact.',
        );
        assert.equal(artifact.job_id, confirmed.receipt.jobId);
        assert.equal(
          await artifactStore.remove({
            artifactId,
            attemptId: artifact.attempt_id,
          }),
          false,
          'A referenced manifest artifact is not removable.',
        );
        const chunks = [];
        for await (const chunk of await artifactStore.openRead(artifactId))
          chunks.push(chunk);
        const document = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(document.preview.previewId, other.previewId);
        assert.equal(document.confirmer, actor);
      },
    );

    await check(
      'B3 a manifest removed before the confirmation fails it',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        const artifactId = await storeJsonDocument(artifactStore, {
          preview: {
            previewId: other.previewId,
            manifestDigest: other.manifestDigest,
          },
          targets: [],
          requester: actor,
          confirmer: actor,
        });
        const attemptId = (
          await migrator.query(
            'SELECT attempt_id FROM cc.artifacts WHERE id=$1',
            [artifactId],
          )
        ).rows[0].attempt_id;
        assert.equal(
          await artifactStore.remove({ artifactId, attemptId }),
          true,
        );
        const stale = {
          async storeJson() {
            return artifactId;
          },
        };
        let error;
        try {
          await new DeviceUpdates(database, cache, stale).confirm(
            session,
            current,
            other.previewId,
            {
              manifestDigest: other.manifestDigest,
              acknowledged: true,
            },
          );
        } catch (failure) {
          error = failure;
        }
        assert.equal(
          typeof error?.getStatus,
          'function',
          'The confirmation answers with an HTTP error.',
        );
        assert.equal(error.getStatus(), 500);
        assert.equal(
          (
            await migrator.query(
              `SELECT count(*)::integer AS count FROM cc.jobs j
               JOIN cc.device_update_previews p ON p.job_id=j.job_id
               WHERE p.preview_id=$1`,
              [other.previewId],
            )
          ).rows[0].count,
          0,
          'A missing manifest creates no job.',
        );
      },
    );

    await check(
      'B3 a rolled-back confirmation leaves the manifest unreferenced',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        const artifactId = await storeJsonDocument(artifactStore, {
          preview: {
            previewId: other.previewId,
            manifestDigest: other.manifestDigest,
          },
          targets: [],
          requester: actor,
          confirmer: actor,
        });
        const attemptId = (
          await migrator.query(
            'SELECT attempt_id FROM cc.artifacts WHERE id=$1',
            [artifactId],
          )
        ).rows[0].attempt_id;
        const client = await connect('cc-app', 'cc-app');
        try {
          await client.query('BEGIN');
          const result = (
            await client.query(
              `SELECT cc.confirm_device_update_preview($1::uuid,$2::integer,$3::text,
                $4::uuid,$5::text,$6::text,$7::uuid) AS result`,
              [
                actor,
                1,
                customer,
                other.previewId,
                other.manifestDigest,
                artifactId,
                randomUUID(),
              ],
            )
          ).rows[0].result;
          assert.equal(result.outcome, 'created');
          assert.equal(
            (
              await client.query(
                'SELECT reference_count FROM cc.artifacts WHERE id=$1',
                [artifactId],
              )
            ).rows[0].reference_count,
            1,
            'The confirmation references the artifact inside its transaction.',
          );
          await client.query('ROLLBACK');
        } finally {
          await client.end();
        }
        assert.equal(
          (
            await migrator.query(
              'SELECT reference_count FROM cc.artifacts WHERE id=$1',
              [artifactId],
            )
          ).rows[0].reference_count,
          0,
          'The rollback releases the reference.',
        );
        assert.equal(
          await artifactStore.remove({ artifactId, attemptId }),
          true,
          'An unreferenced manifest is removable.',
        );
      },
    );

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

    await check(
      'B3 a selection that resolves to no devices gives 422 nothing-selected',
      async () => {
        selections.set(selectionKey, raw({ additions: ['b3-missing'] }));
        await rejects(
          updates.preview(session, current, { ...key, mode: 'clear' }),
          'nothing-selected',
          422,
        );
        assert.equal(
          (
            await migrator.query(
              `SELECT count(*)::integer AS count FROM cc.device_update_previews
               WHERE created_by=$1 AND selected=0`,
              [actor],
            )
          ).rows[0].count,
          0,
          'An empty resolution creates no preview.',
        );
        selections.set(
          selectionKey,
          raw({
            terms: [
              [
                {
                  field: 'serialNumber',
                  operator: 'startsWith',
                  value: 'ZZZ-no-device',
                },
              ],
            ],
          }),
        );
        await rejects(
          updates.preview(session, current, { ...key, mode: 'clear' }),
          'nothing-selected',
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
      'B3 a permission version change after the preview gives 409 permission-changed',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        const recorder = recordingStorage();
        await migrator.query(
          'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
          [actor],
        );
        try {
          await rejects(
            new DeviceUpdates(database, cache, recorder.storage).confirm(
              sessionFor(actor, 2),
              current,
              other.previewId,
              {
                manifestDigest: other.manifestDigest,
                acknowledged: true,
              },
            ),
            'permission-changed',
            409,
          );
          assert.equal(
            recorder.stored.length,
            0,
            'A stale preview stores no manifest artifact.',
          );
          assert.equal(
            (
              await migrator.query(
                `SELECT count(*)::integer AS count FROM cc.jobs j
                 JOIN cc.device_update_previews p ON p.job_id=j.job_id
                 WHERE p.preview_id=$1`,
                [other.previewId],
              )
            ).rows[0].count,
            0,
            'A stale preview creates no job.',
          );
        } finally {
          await migrator.query(
            'UPDATE cc.application_principals SET permission_version=1 WHERE id=$1',
            [actor],
          );
        }
      },
    );

    await check(
      'B3 an action version change after the preview gives 409 preview-changed',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        const recorder = recordingStorage();
        await migrator.query(
          'UPDATE cc.device_update_previews SET action_version=2 WHERE preview_id=$1',
          [other.previewId],
        );
        try {
          await rejects(
            new DeviceUpdates(database, cache, recorder.storage).confirm(
              session,
              current,
              other.previewId,
              {
                manifestDigest: other.manifestDigest,
                acknowledged: true,
              },
            ),
            'preview-changed',
            409,
          );
          assert.equal(
            recorder.stored.length,
            0,
            'A changed action version stores no manifest artifact.',
          );
          assert.equal(
            (
              await migrator.query(
                `SELECT count(*)::integer AS count FROM cc.jobs j
                 JOIN cc.device_update_previews p ON p.job_id=j.job_id
                 WHERE p.preview_id=$1`,
                [other.previewId],
              )
            ).rows[0].count,
            0,
            'A changed action version creates no job.',
          );
        } finally {
          await migrator.query(
            'UPDATE cc.device_update_previews SET action_version=1 WHERE preview_id=$1',
            [other.previewId],
          );
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

    await check(
      'B3 an unexpired preview stays confirmable after the selection expires',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        const changedAt = new Date(
          Date.now() - 13 * 60 * 60 * 1000,
        ).toISOString();
        selections.set(selectionKey, raw({ additions: ['b3-a'], changedAt }));
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
      },
    );

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
      'B3 the runtime role cannot insert or update a preview, job, or operation table',
      async () => {
        const tables = [
          'cc.device_update_previews',
          'cc.device_update_preview_targets',
          'cc.jobs',
          'cc.device_update_jobs',
          'cc.device_update_operations',
        ];
        for (const table of tables)
          for (const privilege of ['INSERT', 'UPDATE'])
            assert.equal(
              (
                await migrator.query(
                  `SELECT has_table_privilege('cc-app',$1,$2) AS held`,
                  [table, privilege],
                )
              ).rows[0].held,
              false,
              `The runtime role holds no ${privilege} on ${table}.`,
            );
      },
    );

    await check(
      'B3 the runtime role cannot read the delegated subject',
      async () => {
        assert.equal(
          (
            await migrator.query(
              `SELECT has_column_privilege('cc-app','cc.google_credentials',
                'delegated_subject','SELECT') AS held`,
            )
          ).rows[0].held,
          false,
          'The runtime role reads no delegated subject.',
        );
        const reader = await connect('cc-app', 'cc-app');
        try {
          await reader.query('BEGIN');
          const code = await reader
            .query(
              'SELECT delegated_subject FROM cc.google_credentials LIMIT 0',
            )
            .then(
              () => 'allowed',
              (error) => error.code,
            );
          await reader.query('ROLLBACK');
          assert.equal(code, '42501');
        } finally {
          await reader.end();
        }
      },
    );

    await check(
      'B3 the runtime role cannot read the connection generation',
      async () => {
        assert.equal(
          (
            await migrator.query(
              `SELECT has_column_privilege('cc-app','cc.google_connection',
                'generation','SELECT') AS held`,
            )
          ).rows[0].held,
          false,
          'The runtime role reads no connection generation.',
        );
        const reader = await connect('cc-app', 'cc-app');
        try {
          await reader.query('BEGIN');
          const code = await reader
            .query('SELECT generation FROM cc.google_connection LIMIT 0')
            .then(
              () => 'allowed',
              (error) => error.code,
            );
          await reader.query('ROLLBACK');
          assert.equal(code, '42501');
        } finally {
          await reader.end();
        }
      },
    );

    await check('B3 the runtime role write statements are denied', async () => {
      const writer = await connect('cc-app', 'cc-app');
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
    });

    await check(
      'B3 a preview request without devices:bulk-actions answers 403 and writes access-denied',
      async () => {
        const limited = await createPrincipal('limited-request', [
          'devices:read',
          'devices:write',
        ]);
        const limitedGrants = ['devices:read', 'devices:write'].map(
          (action) => ({
            action,
            scope: { kind: 'district', customerId: customer },
          }),
        );
        const correlationId = randomUUID();
        const auth = {
          async authorize(authorizedSession, action, resource, correlation) {
            await authorizeAction(
              {
                phase: 3,
                audit: async (event, id, actorId, detail) => {
                  await migrator.query(
                    'INSERT INTO cc.security_events(id,actor_id,event,correlation_id,detail) VALUES($1,$2,$3,$4,$5)',
                    [randomUUID(), actorId, event, id, detail],
                  );
                },
              },
              authorizedSession,
              action,
              resource,
              correlation,
            );
          },
        };
        try {
          let error;
          try {
            await requireDeviceUpdateActions(
              auth,
              sessionFor(limited, 1, limitedGrants),
              customer,
              correlationId,
            );
          } catch (failure) {
            error = failure;
          }
          assert.equal(
            typeof error?.getStatus,
            'function',
            'The request answers with an HTTP error.',
          );
          assert.equal(error.getStatus(), 403);
          const rows = (
            await migrator.query(
              `SELECT actor_id,detail FROM cc.security_events
               WHERE event='access-denied' AND correlation_id=$1`,
              [correlationId],
            )
          ).rows;
          assert.deepEqual(rows, [
            { actor_id: limited, detail: 'devices:bulk-actions' },
          ]);
        } finally {
          await migrator.query(
            'DELETE FROM cc.security_events WHERE correlation_id=$1',
            [correlationId],
          );
          await removePrincipal(limited);
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
      'B3 a grant lost after the manifest creates no job',
      async () => {
        fresh(['b3-a']);
        const other = await updates.preview(session, current, {
          ...key,
          mode: 'replace',
          value: 'Room 12',
        });
        const revoked = new DeviceUpdates(database, cache, {
          async storeJson() {
            await migrator.query(
              "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='devices:bulk-actions'",
              [actor],
            );
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
          assert.equal(
            (
              await migrator.query(
                `SELECT count(*)::integer AS count FROM cc.jobs j
                 JOIN cc.device_update_previews p ON p.job_id=j.job_id
                 WHERE p.preview_id=$1`,
                [other.previewId],
              )
            ).rows[0].count,
            0,
          );
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

    await check(
      'B3 preview creation takes the global access lock before any row lock',
      async () => {
        fresh(['b3-a']);
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
            .preview(session, current, { ...key, mode: 'clear' })
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
            'The preview creation waits for the global access lock.',
          );
          assert.equal(
            (
              await migrator.query(
                `SELECT count(*)::integer AS count FROM pg_locks
                 WHERE pid=$1 AND locktype='advisory' AND NOT granted`,
                [callerPid],
              )
            ).rows[0].count,
            1,
            'The preview creation waits on the global advisory lock.',
          );
          const principalFree = await observer
            .query(
              'SELECT 1 FROM cc.application_principals WHERE id=$1 FOR UPDATE NOWAIT',
              [actor],
            )
            .then(
              () => true,
              (error) => error.code,
            );
          assert.equal(
            principalFree,
            true,
            'The preview creation holds no principal row while it waits.',
          );
          await holder.query('COMMIT');
          const answer = await pending;
          assert.equal(answer.error, undefined);
          assert.equal(answer.value.displayId.length, 6);
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

    await check(
      'B3 preview creation refuses authority revoked while it waits',
      async () => {
        const victim = await createPrincipal('revoked-during-preview', [
          'devices:read',
          'devices:write',
          'devices:bulk-actions',
        ]);
        const victimKey = selectionStorageKey(victim, key);
        selections.set(victimKey, raw({ additions: ['b3-a'] }));
        const holder = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        const observer = await connect('cc-migrator', 'cc-app');
        let pending;
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT pg_advisory_xact_lock(7240173008)');
          await holder.query(
            'SELECT 1 FROM cc.application_principals WHERE id=$1 FOR UPDATE',
            [victim],
          );
          await holder.query(
            'UPDATE cc.application_principals SET enabled=false, permission_version=2 WHERE id=$1',
            [victim],
          );
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const callerPid = (
            await caller.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          pending = new DeviceUpdates(databaseFor(caller), cache, storage)
            .preview(sessionFor(victim, 1), current, {
              ...key,
              mode: 'clear',
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
            'The preview creation waits for the access change.',
          );
          assert.equal(
            (
              await migrator.query(
                `SELECT count(*)::integer AS count FROM pg_locks
                 WHERE pid=$1 AND locktype='advisory' AND NOT granted`,
                [callerPid],
              )
            ).rows[0].count,
            1,
            'The preview creation waits on the global advisory lock.',
          );
          await holder.query('COMMIT');
          const answer = await pending;
          assert.equal(
            typeof answer.error?.getStatus,
            'function',
            'The preview creation answers with an HTTP error.',
          );
          assert.equal(answer.error.getStatus(), 403);
          assert.equal(
            (
              await migrator.query(
                'SELECT count(*)::integer AS count FROM cc.device_update_previews WHERE created_by=$1',
                [victim],
              )
            ).rows[0].count,
            0,
            'No preview is created for revoked authority.',
          );
          assert.equal(
            (
              await migrator.query(
                `SELECT count(*)::integer AS count FROM cc.device_update_preview_targets t
                 JOIN cc.device_update_previews p ON p.preview_id=t.preview_id
                 WHERE p.created_by=$1`,
                [victim],
              )
            ).rows[0].count,
            0,
            'No target is created for revoked authority.',
          );
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (pending) await pending;
          await Promise.allSettled([
            holder.end(),
            caller.end(),
            observer.end(),
          ]);
          await removePrincipal(victim);
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
    await artifactStore.close().catch(() => undefined);
    await rm(artifactDirectory, { recursive: true, force: true });
  }
  if (failures.length)
    throw new Error(`Device update checks failed: ${failures.join(' | ')}`);
  return results;
}
