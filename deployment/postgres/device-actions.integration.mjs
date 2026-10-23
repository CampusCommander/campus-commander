import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import 'reflect-metadata';

// The controllers and their Nest services carry decorators. Transform only those modules, as the
// step 4 integration check does. Every other module keeps the default loader.
const decorator = /(^|\n)\s*@[A-Z][A-Za-z]*\(/;
registerHooks({
  load(url, context, nextLoad) {
    if (
      url.startsWith('file:') &&
      url.endsWith('.ts') &&
      !url.includes('/node_modules/')
    ) {
      const file = fileURLToPath(url);
      const source = readFileSync(file, 'utf8');
      if (decorator.test(source)) {
        const transformed = transformSync(source, {
          loader: 'ts',
          format: 'esm',
          target: 'node24',
          sourcefile: file,
          tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
        });
        return {
          format: 'module',
          source: transformed.code,
          shortCircuit: true,
        };
      }
    }
    return nextLoad(url, context);
  },
});

const load = async () => {
  const module = (path) =>
    import(pathToFileURL(resolve(process.cwd(), path)).href);
  const actions = await module('api/src/app/devices/device-actions.ts');
  const guards = await module('api/src/app/devices/device-updates-actions.ts');
  const selection = await module('api/src/app/devices/device-selection.ts');
  const controller = await module(
    'api/src/app/devices/device-actions.controller.ts',
  );
  const security = await module('api/src/app/security.ts');
  const devices = await module('api/src/app/devices/devices.service.ts');
  const auth = await module('api/src/app/auth/auth.service.ts');
  const database = await module('api/src/app/database/database.service.ts');
  return {
    DeviceActions: actions.DeviceActions,
    COMMAND_PREVIEW_FAMILY: actions.COMMAND_PREVIEW_FAMILY,
    STATUS_PREVIEW_FAMILY: actions.STATUS_PREVIEW_FAMILY,
    actionManifestDigest: actions.actionManifestDigest,
    DEVICE_ACTION_ROUTE_ACTIONS: guards.DEVICE_ACTION_ROUTE_ACTIONS,
    requireDeviceActions: guards.requireDeviceActions,
    requireDeviceAction: guards.requireDeviceAction,
    selectionStorageKey: selection.selectionStorageKey,
    DeviceCommandsController: controller.DeviceCommandsController,
    DeviceStatusChangesController: controller.DeviceStatusChangesController,
    ApplicationExceptionFilter: security.ApplicationExceptionFilter,
    DevicesService: devices.DevicesService,
    AuthService: auth.AuthService,
    DatabaseService: database.DatabaseService,
  };
};

/** The action previews and their route and SQL permissions of card B3 (design sections 2, 6, 7). */
export async function qualifyDeviceActions({ runtime, migrator, issuer }) {
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const wasActive = connection.active;
  const results = [];
  const failures = [];
  const {
    DeviceActions,
    COMMAND_PREVIEW_FAMILY,
    STATUS_PREVIEW_FAMILY,
    DEVICE_ACTION_ROUTE_ACTIONS,
    requireDeviceActions,
    requireDeviceAction,
    selectionStorageKey,
    DeviceCommandsController,
    DeviceStatusChangesController,
    ApplicationExceptionFilter,
    DevicesService,
    AuthService,
    DatabaseService,
  } = await load();
  const actor = randomUUID();
  const createdPrincipals = [actor];
  // The artifacts, jobs, and devices of the card B3 checks below. Each one leaves in cleanup().
  const artifacts = new Set();
  const jobs = [];
  const key = {
    gridId: 'devices',
    tabId: '66666666-6666-4666-8666-666666666666',
  };
  const selectionKey = selectionStorageKey(actor, key);
  const selections = new Map();
  const cache = { get: async (name) => selections.get(name) ?? null };
  const storedDocuments = [];
  /** A published, ready artifact row for one stored manifest. The confirmation checks its state. */
  const publishArtifact = async () => {
    const id = randomUUID();
    const attempt = randomUUID();
    // The artifact fixture publishes the same cc.artifacts state as the real store, without a file.
    await migrator.query(
      `INSERT INTO cc.artifacts(id,backend,locator,schema_version,attempt_id,sha256,size_bytes,
         publication_state,active,reference_count)
       VALUES($1,'local',$2,1,$3,$4,1,'ready',false,0)`,
      [id, `${id}.${attempt}`, attempt, 'a'.repeat(64)],
    );
    artifacts.add(id);
    return id;
  };
  // The service stores the manifest before the confirmation function runs. Publish a real, ready
  // artifact for each stored document, so a confirmation that reaches the function finds one.
  const storage = {
    storeJson: async (document) => {
      storedDocuments.push(document);
      return publishArtifact();
    },
  };
  const database = {
    connection: { query: (text, values) => runtime.query(text, values) },
    async transaction(run) {
      await runtime.query('BEGIN');
      try {
        const result = await run(runtime);
        await runtime.query('COMMIT');
        return result;
      } catch (error) {
        await runtime.query('ROLLBACK');
        throw error;
      }
    },
  };
  const actions = new DeviceActions(database, cache, storage);
  const current = { customerId: customer, generation };
  const grants = (
    names = [
      'devices:read',
      'devices:bulk-actions',
      'devices:commands',
      'devices:status',
    ],
  ) =>
    names.map((action) => ({
      action,
      scope: { kind: 'district', customerId: customer },
    }));
  const session = {
    identity: {
      id: actor,
      displayName: 'B3 action actor',
      permissions: [],
      permissionVersion: 1,
      grants: grants(),
      preferences: {},
    },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    csrfToken: 'a'.repeat(64),
  };
  const sessionFor = (id, names) => ({
    ...session,
    identity: {
      ...session.identity,
      id,
      grants: grants(names),
    },
  });
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
  const raw = (additions) =>
    JSON.stringify({
      terms: [],
      groups: [],
      additions,
      exceptions: [],
      changedAt: new Date().toISOString(),
    });
  const fresh = (additions) => selections.set(selectionKey, raw(additions));
  /** The stored selection of one person. Each principal reads its own cache key. */
  const freshFor = (id, additions) =>
    selections.set(selectionStorageKey(id, key), raw(additions));
  const insertDevice = async (id, status, extra = {}) =>
    migrator.query(
      `INSERT INTO cc.devices(customer_id,device_id,serial_number,model,asset_tag,org_unit_path,
         status,status_observed_at,last_entity_sync,removed_at)
       VALUES($1,$2,$3,'B3A model',$4,'/B3A School',$5,$6,clock_timestamp(),$7)
       ON CONFLICT(customer_id,device_id) DO UPDATE SET status=EXCLUDED.status,
         status_observed_at=EXCLUDED.status_observed_at,
         last_entity_sync=clock_timestamp(),removed_at=EXCLUDED.removed_at`,
      [
        customer,
        id,
        `SN-${id}`,
        `AT-${id}`,
        status,
        extra.observedAt ?? new Date(),
        extra.removed ?? null,
      ],
    );
  const createPrincipal = async (label, names) => {
    const id = randomUUID();
    createdPrincipals.push(id);
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
      [id, issuer, `b3a-${label}-${id}`, `B3A ${label}`],
    );
    for (const action of names)
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
  const cleanup = async () => {
    await migrator.query(
      'DELETE FROM cc.security_events WHERE actor_id=ANY($1::uuid[])',
      [createdPrincipals],
    );
    // A job of the B3 checks holds operations and overlays. End it, so the write slot and the
    // next suite stay free, then remove its rows.
    for (const jobId of jobs)
      try {
        await migrator.query(
          `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '60 seconds'
            WHERE job_id=$1`,
          [jobId],
        );
        await migrator.query('SELECT cc.finalize_device_update_job($1,$2,$3)', [
          customer,
          jobId,
          null,
        ]);
      } catch {
        /* A job that another check ended stays. */
      }
    await migrator.query(
      "DELETE FROM cc.device_write_overlays WHERE customer_id=$1 AND device_id LIKE 'b3a-%'",
      [customer],
    );
    for (const id of createdPrincipals.slice(1)) await removePrincipal(id);
    await removePrincipal(actor);
    for (const id of artifacts)
      await migrator
        .query('DELETE FROM cc.artifacts WHERE id=$1', [id])
        .catch(() => undefined);
    await migrator.query(
      "DELETE FROM cc.devices WHERE customer_id=$1 AND (device_id LIKE 'b3a-%' OR device_id LIKE 'b6-%')",
      [customer],
    );
  };
  const directPreview = async (
    principal,
    action,
    digest,
    targets,
    reason = null,
  ) =>
    (
      await runtime.query(
        `SELECT cc.create_device_update_preview($1::uuid,$2::integer,$3::text,$4::integer,
           $5::text,$6::jsonb,$7::text,$8::jsonb,$9::integer,$10::text) AS result`,
        [
          principal,
          1,
          customer,
          generation,
          action,
          // A command or status preview carries no change (card U6).
          null,
          digest,
          JSON.stringify(targets),
          15,
          reason,
        ],
      )
    ).rows[0].result;
  const target = (device) => ({
    ordinal: 0,
    device_id: device,
    serial_number: `SN-${device}`,
    org_unit_path: '/B3A School',
    observed_value: 'ACTIVE',
    observed_at: null,
    disposition: 'eligible',
    exclusion_reason: null,
  });
  const routeRequest = (id, names, correlationId = randomUUID()) => ({
    session: sessionFor(id, names),
    correlationId,
  });
  const controllerFor = (family, jobs = {}) => {
    const appDatabase = new DatabaseService({ deployment: undefined });
    appDatabase.pool = {
      query: (text, values) => runtime.query(text, values),
    };
    const auth = new AuthService(
      { deployment: { phase: 3 } },
      appDatabase,
      {},
      {},
      {},
    );
    const devices = new DevicesService(database, {}, {});
    return family === 'commands'
      ? new DeviceCommandsController(devices, actions, auth, jobs)
      : new DeviceStatusChangesController(devices, actions, auth, jobs);
  };

  try {
    await migrator.query('UPDATE cc.google_connection SET active=true');
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
      [actor, issuer, `b3a-${actor}`, 'B3A action actor'],
    );
    for (const grant of grants())
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [actor, grant.action, JSON.stringify(grant.scope)],
      );
    await insertDevice('b3a-active', 'ACTIVE');
    await insertDevice('b3a-disabled', 'DISABLED');
    await insertDevice('b3a-deprovisioned', 'DEPROVISIONED');
    await insertDevice('b3a-active-2', 'ACTIVE');
    await insertDevice('b3a-active-3', 'ACTIVE');
    await insertDevice('b3a-removed', 'ACTIVE', { removed: new Date() });
    // The devices of the card B3 checks below.
    for (const deviceId of [
      'b3a-powerwash',
      'b3a-deprovision',
      'b3a-wipe',
      'b3a-reboot',
      'b3a-powerwash-early',
      'b3a-powerwash-late',
      // The card B6 checks below.
      'b6-active',
      'b6-deprovision-target',
      'b6-powerwash',
    ])
      await insertDevice(deviceId, 'ACTIVE');
    await insertDevice('b6-disabled', 'DISABLED');
    await insertDevice('b6-deprovisioned', 'DEPROVISIONED');

    let rebootPreview;
    await check(
      'B3A a Reboot preview lists each excluded status with its reason',
      async () => {
        fresh(['b3a-active', 'b3a-disabled', 'b3a-deprovisioned']);
        rebootPreview = await actions.preview(session, current, 'reboot', key);
        assert.match(rebootPreview.displayId, /^PV-\d{3,}$/);
        assert.equal(rebootPreview.action, 'reboot');
        assert.equal(rebootPreview.commandType, 'REBOOT');
        assert.equal(rebootPreview.statusAction, null);
        assert.equal(rebootPreview.selected, 3);
        assert.equal(rebootPreview.eligible, 1);
        assert.equal(rebootPreview.excluded, 2);
        const page = await actions.targets(
          session,
          rebootPreview.previewId,
          COMMAND_PREVIEW_FAMILY,
          undefined,
          undefined,
          100,
        );
        assert.deepEqual(
          page.targets.map((row) => [
            row.deviceId,
            row.disposition,
            row.exclusionReason,
          ]),
          [
            // The selection resolves in device_id order.
            ['b3a-active', 'eligible', null],
            ['b3a-deprovisioned', 'excluded', 'device-deprovisioned'],
            ['b3a-disabled', 'excluded', 'device-disabled'],
          ],
        );
        assert.deepEqual(
          page.targets.map((row) => row.observedStatus),
          ['ACTIVE', 'DEPROVISIONED', 'DISABLED'],
        );
        const stored = (
          await migrator.query(
            `SELECT action,action_version,field_changes,manifest_digest,selected,eligible,
               unchanged,excluded FROM cc.device_update_previews WHERE preview_id=$1`,
            [rebootPreview.previewId],
          )
        ).rows[0];
        assert.deepEqual(stored, {
          action: 'reboot',
          action_version: 1,
          field_changes: 0,
          manifest_digest: rebootPreview.manifestDigest,
          selected: 3,
          eligible: 1,
          unchanged: 0,
          excluded: 2,
        });
        const expected = createHash('sha256')
          .update(
            JSON.stringify({
              action: 'reboot',
              actionVersion: 1,
              googleAction: 'REBOOT',
              targets: [['b3a-active', 'ACTIVE']],
            }),
          )
          .digest('hex');
        assert.equal(stored.manifest_digest, expected);
        const targetRows = (
          await migrator.query(
            `SELECT device_id,observed_value,observed_at,disposition,exclusion_reason
               FROM cc.device_update_preview_targets WHERE preview_id=$1 ORDER BY ordinal`,
            [rebootPreview.previewId],
          )
        ).rows;
        assert.deepEqual(
          targetRows.map((row) => [
            row.device_id,
            row.observed_value,
            row.disposition,
            row.exclusion_reason,
          ]),
          [
            ['b3a-active', 'ACTIVE', 'eligible', null],
            [
              'b3a-deprovisioned',
              'DEPROVISIONED',
              'excluded',
              'device-deprovisioned',
            ],
            ['b3a-disabled', 'DISABLED', 'excluded', 'device-disabled'],
          ],
        );
        assert.ok(
          targetRows.every((row) => row.observed_at instanceof Date),
          'Each target stores the cached status stamp.',
        );
      },
    );

    await check(
      'B3A a Re-enable preview of ACTIVE devices shows zero eligible and confirm answers 422',
      async () => {
        fresh(['b3a-active-2', 'b3a-active-3']);
        const preview = await actions.preview(
          session,
          current,
          'reenable',
          key,
        );
        assert.equal(preview.action, 'reenable');
        assert.equal(preview.statusAction, 'reenable');
        assert.equal(preview.commandType, null);
        assert.equal(preview.selected, 2);
        assert.equal(preview.eligible, 0);
        assert.equal(preview.excluded, 2);
        const page = await actions.targets(
          session,
          preview.previewId,
          STATUS_PREVIEW_FAMILY,
          undefined,
          undefined,
          100,
        );
        assert.deepEqual(
          page.targets.map((row) => [row.deviceId, row.exclusionReason]),
          [
            ['b3a-active-2', 'device-active'],
            ['b3a-active-3', 'device-active'],
          ],
        );
        await assert.rejects(
          actions.confirm(
            session,
            current,
            preview.previewId,
            {
              manifestDigest: preview.manifestDigest,
              acknowledged: true,
            },
            STATUS_PREVIEW_FAMILY,
          ),
          (error) => {
            assert.equal(error.getStatus(), 422, String(error));
            assert.deepEqual(error.getResponse(), {
              reason: 'nothing-to-update',
            });
            return true;
          },
        );
        const stored = (
          await migrator.query(
            'SELECT job_id FROM cc.device_update_previews WHERE preview_id=$1',
            [preview.previewId],
          )
        ).rows[0];
        assert.equal(stored.job_id, null, 'No job starts.');
        assert.equal(
          (
            await migrator.query(
              'SELECT count(*)::integer AS count FROM cc.jobs WHERE requested_by=$1',
              [actor],
            )
          ).rows[0].count,
          0,
          'No job row exists for the refused confirmation.',
        );
      },
    );

    await check(
      'B3A a Disable preview accepts an ACTIVE device and refuses a DISABLED one',
      async () => {
        fresh(['b3a-active', 'b3a-disabled']);
        const preview = await actions.preview(session, current, 'disable', key);
        assert.equal(preview.action, 'disable');
        assert.equal(preview.eligible, 1);
        assert.equal(preview.excluded, 1);
        const page = await actions.targets(
          session,
          preview.previewId,
          STATUS_PREVIEW_FAMILY,
          'excluded',
          undefined,
          100,
        );
        assert.deepEqual(
          page.targets.map((row) => [row.deviceId, row.exclusionReason]),
          [['b3a-disabled', 'device-disabled']],
        );
      },
    );

    let limited;
    await check(
      'B3A a person without devices:commands gets 403 from the route and from SQL',
      async () => {
        limited = await createPrincipal('no-command', [
          'devices:read',
          'devices:bulk-actions',
          'devices:status',
        ]);
        const correlationId = randomUUID();
        const request = routeRequest(
          limited,
          ['devices:read', 'devices:bulk-actions', 'devices:status'],
          correlationId,
        );
        await assert.rejects(
          controllerFor('commands').preview(request, {
            ...key,
            commandType: 'REBOOT',
          }),
          (error) => {
            assert.equal(error.getStatus?.(), 403, String(error));
            return true;
          },
        );
        const events = (
          await migrator.query(
            `SELECT actor_id,detail FROM cc.security_events
             WHERE event='access-denied' AND correlation_id=$1`,
            [correlationId],
          )
        ).rows;
        assert.deepEqual(events, [
          { actor_id: limited, detail: 'devices:commands' },
        ]);
        const answer = await directPreview(limited, 'reboot', 'a'.repeat(64), [
          target('b3a-active'),
        ]);
        assert.deepEqual(answer, { outcome: 'forbidden' });
        assert.equal(
          (
            await migrator.query(
              'SELECT count(*)::integer AS count FROM cc.device_update_previews WHERE created_by=$1',
              [limited],
            )
          ).rows[0].count,
          0,
          'The SQL refusal stores no preview.',
        );
      },
    );

    await check(
      'B3A a person without devices:status gets 403 from the status route and from SQL',
      async () => {
        const operator = await createPrincipal('no-status', [
          'devices:read',
          'devices:bulk-actions',
          'devices:commands',
        ]);
        const correlationId = randomUUID();
        await assert.rejects(
          controllerFor('status').preview(
            routeRequest(
              operator,
              ['devices:read', 'devices:bulk-actions', 'devices:commands'],
              correlationId,
            ),
            { ...key, statusAction: 'disable' },
          ),
          (error) => {
            assert.equal(error.getStatus?.(), 403, String(error));
            return true;
          },
        );
        const events = (
          await migrator.query(
            `SELECT actor_id,detail FROM cc.security_events
             WHERE event='access-denied' AND correlation_id=$1`,
            [correlationId],
          )
        ).rows;
        assert.deepEqual(events, [
          { actor_id: operator, detail: 'devices:status' },
        ]);
        assert.deepEqual(
          await directPreview(operator, 'reenable', 'a'.repeat(64), [
            target('b3a-disabled'),
          ]),
          { outcome: 'forbidden' },
        );
      },
    );

    await check(
      'B3A a person without devices:bulk-actions gets 403 from each family and from SQL',
      async () => {
        const limitedBulk = await createPrincipal('no-bulk', [
          'devices:read',
          'devices:commands',
          'devices:status',
        ]);
        const names = ['devices:read', 'devices:commands', 'devices:status'];
        const commandCorrelation = randomUUID();
        await assert.rejects(
          controllerFor('commands').preview(
            routeRequest(limitedBulk, names, commandCorrelation),
            { ...key, commandType: 'REBOOT' },
          ),
          (error) => {
            assert.equal(error.getStatus?.(), 403, String(error));
            return true;
          },
        );
        const statusCorrelation = randomUUID();
        await assert.rejects(
          controllerFor('status').preview(
            routeRequest(limitedBulk, names, statusCorrelation),
            { ...key, statusAction: 'reenable' },
          ),
          (error) => {
            assert.equal(error.getStatus?.(), 403, String(error));
            return true;
          },
        );
        const events = (
          await migrator.query(
            `SELECT correlation_id,detail FROM cc.security_events
               WHERE event='access-denied' AND correlation_id=ANY($1::uuid[])
               ORDER BY correlation_id`,
            [[commandCorrelation, statusCorrelation].sort()],
          )
        ).rows;
        assert.deepEqual(
          events.map((row) => row.detail),
          ['devices:bulk-actions', 'devices:bulk-actions'],
        );
        for (const [action, deviceId] of [
          ['reboot', 'b3a-active'],
          ['disable', 'b3a-active'],
        ])
          assert.deepEqual(
            await directPreview(limitedBulk, action, 'a'.repeat(64), [
              target(deviceId),
            ]),
            { outcome: 'forbidden' },
            `SQL refuses ${action} without Bulk Actions.`,
          );
      },
    );

    await check(
      'B3A the route guard requires the read and Bulk Actions pair before the action permission',
      async () => {
        const calls = [];
        const auth = {
          authorize: async (_session, action) => calls.push(action),
        };
        await requireDeviceActions(
          auth,
          session,
          customer,
          randomUUID(),
          DEVICE_ACTION_ROUTE_ACTIONS,
        );
        assert.deepEqual(calls, ['devices:read', 'devices:bulk-actions']);
        calls.length = 0;
        for (const action of [
          'reboot',
          'wipe-users',
          'powerwash',
          'disable',
          'reenable',
          'deprovision',
        ])
          await requireDeviceAction(
            auth,
            session,
            customer,
            randomUUID(),
            action,
          );
        assert.deepEqual(calls, [
          'devices:commands',
          'devices:wipe',
          'devices:wipe',
          'devices:status',
          'devices:status',
          'devices:deprovision',
        ]);
      },
    );

    // -------------------------------------------------------------------------------------------
    // Card B3: the three actions, the reason, and the typed phrase (design section 5). The routes and
    // the API contracts of these actions arrive in card B6, so each check calls the schema functions
    // directly and reads the rows they write.
    // -------------------------------------------------------------------------------------------
    const wipeActor = await createPrincipal('wipe', [
      'devices:read',
      'devices:bulk-actions',
      'devices:wipe',
      'devices:deprovision',
    ]);
    const adminRow = (text, values = []) =>
      migrator.query(text, values).then((answer) => answer.rows[0]);
    const call = (text, values = []) =>
      runtime.query(text, values).then((answer) => answer.rows[0].result);
    /** A timestamp shifted by one interval, as the database computes it. */
    const plus = (at, interval) =>
      migrator
        .query('SELECT ($1::timestamptz+$2::interval) AS at', [at, interval])
        .then((answer) => answer.rows[0].at.getTime());
    const digest = 'c'.repeat(64);
    const RETIRING = 'DEPROVISION_REASON_RETIRING_DEVICE';
    const SAME_MODEL = 'DEPROVISION_REASON_SAME_MODEL_REPLACEMENT';
    const previewOf = (actorId, action, deviceId, reason = null) =>
      directPreview(actorId, action, digest, [target(deviceId)], reason);
    const confirmOf = (actorId, row, phrase, artifactId) =>
      call(
        `SELECT cc.confirm_device_update_preview($1::uuid,$2::integer,$3::text,$4::uuid,
           $5::text,$6::text,$7::uuid,$8::text) AS result`,
        [
          actorId,
          1,
          customer,
          row.preview_id,
          row.manifest_digest,
          artifactId,
          randomUUID(),
          phrase,
        ],
      );
    const manifestOf = (actorId, previewId) =>
      call(
        'SELECT cc.read_device_update_preview_manifest($1,$2,$3,$4) AS result',
        [actorId, 1, customer, previewId],
      );
    /** One preview through its confirmation: the job that a card B6 route creates. */
    const confirmedJob = async ({
      actor: owner = wipeActor,
      action,
      deviceId,
      reason = null,
      phrase,
    }) => {
      const created = await previewOf(owner, action, deviceId, reason);
      assert.equal(created.outcome, 'created', `${action} preview`);
      // The manifest names an unconfirmed preview. A preview that holds a job answers its receipt.
      const manifest = await manifestOf(owner, created.preview.preview_id);
      assert.equal(manifest.outcome, 'manifest', `${action} manifest`);
      const artifactId = await publishArtifact();
      const answer = await confirmOf(
        owner,
        created.preview,
        phrase,
        artifactId,
      );
      assert.equal(answer.outcome, 'created', `${action} confirmation`);
      jobs.push(answer.receipt.jobId);
      return {
        ...answer.receipt,
        preview: created.preview,
        artifactId,
        manifest,
      };
    };
    const admit = () =>
      call('SELECT cc.admit_device_update_job($1,$2) AS result', [
        customer,
        false,
      ]);
    const finishJob = async (jobId) => {
      await migrator.query(
        `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '60 seconds'
          WHERE job_id=$1`,
        [jobId],
      );
      return call('SELECT cc.finalize_device_update_job($1,$2,$3) AS result', [
        customer,
        jobId,
        null,
      ]);
    };
    /** The write slot admits one job at a time. A leftover job of an earlier suite ends first. */
    const start = async (jobId) => {
      for (let tries = 0; tries < 20; tries += 1) {
        const admitted = await admit();
        if (admitted?.jobId === jobId) return admitted;
        const leftover =
          admitted?.jobId ??
          (
            await adminRow(
              `SELECT job_id FROM cc.jobs WHERE customer_id=$1 AND
                kind IN ('device-update','device-command','device-status') AND status='running'`,
              [customer],
            )
          )?.job_id;
        if (!leftover) break;
        await finishJob(leftover);
      }
      throw new Error(`The ${jobId} job was not admitted.`);
    };
    const claim = (jobId, token, attempt, batch = 0) =>
      call('SELECT cc.claim_device_update_batch($1,$2,$3,$4,$5,$6) AS result', [
        customer,
        jobId,
        token,
        batch,
        attempt,
        'kestra-execution',
      ]);
    const settleJob = (jobId, token, attempt, kind, results, observedAt) =>
      call(
        'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          customer,
          jobId,
          kind === 'read-back' ? null : token,
          attempt,
          kind,
          JSON.stringify(results),
          observedAt,
        ],
      );

    await check(
      "B3 a Deprovision preview needs one of Google's four reasons, and no other action carries one",
      async () => {
        const rejected = (action, reason, message) =>
          assert.rejects(
            previewOf(wipeActor, action, 'b3a-deprovision', reason),
            (error) => {
              assert.equal(error.code, '22023', `${message}: ${error.message}`);
              return true;
            },
          );
        await rejected(
          'deprovision',
          null,
          'A Deprovision preview without a reason',
        );
        await rejected(
          'deprovision',
          'DEPROVISION_REASON_OTHER',
          'A fifth reason value',
        );
        await rejected(
          'powerwash',
          RETIRING,
          'A Powerwash preview with a reason',
        );
        await rejected('disable', RETIRING, 'A Disable preview with a reason');
        await rejected(
          'reenable',
          RETIRING,
          'A Re-enable preview with a reason',
        );
        assert.equal(
          (
            await adminRow(
              'SELECT count(*)::integer AS count FROM cc.device_update_previews WHERE created_by=$1',
              [wipeActor],
            )
          ).count,
          0,
          'A refused preview stores no row.',
        );
        const stored = await previewOf(
          wipeActor,
          'deprovision',
          'b3a-deprovision',
          RETIRING,
        );
        assert.equal(stored.outcome, 'created');
        assert.equal(stored.preview.action, 'deprovision');
        assert.equal(stored.preview.action_version, 1);
        assert.equal(stored.preview.deprovision_reason, RETIRING);
        const command = await previewOf(
          wipeActor,
          'powerwash',
          'b3a-powerwash',
        );
        assert.equal(command.outcome, 'created');
        assert.equal(command.preview.deprovision_reason, null);
      },
    );

    let powerwashJob;
    await check(
      'B3 a Powerwash preview becomes a CMD- job with no requested value',
      async () => {
        powerwashJob = await confirmedJob({
          action: 'powerwash',
          deviceId: 'b3a-powerwash',
          phrase: 'POWERWASH',
        });
        assert.match(powerwashJob.displayId, /^CMD-\d{3,}$/);
        assert.deepEqual(
          await adminRow(
            'SELECT kind,scope_kind,target_count FROM cc.jobs WHERE job_id=$1',
            [powerwashJob.jobId],
          ),
          { kind: 'device-command', scope_kind: 'devices', target_count: 1 },
        );
        assert.deepEqual(
          await adminRow(
            `SELECT device_id,baseline_value,requested_value,batch,status
               FROM cc.device_update_operations WHERE job_id=$1`,
            [powerwashJob.jobId],
          ),
          {
            device_id: 'b3a-powerwash',
            baseline_value: 'ACTIVE',
            requested_value: null,
            batch: 0,
            status: 'pending',
          },
        );
        assert.deepEqual(
          await adminRow(
            'SELECT action,preview_id FROM cc.device_update_jobs WHERE job_id=$1',
            [powerwashJob.jobId],
          ),
          { action: 'powerwash', preview_id: powerwashJob.preview.preview_id },
        );
      },
    );

    let deprovisionJob;
    await check(
      'B3 a Deprovision preview becomes an STS- job with DEPROVISIONED as its requested value',
      async () => {
        deprovisionJob = await confirmedJob({
          action: 'deprovision',
          deviceId: 'b3a-deprovision',
          reason: SAME_MODEL,
          phrase: 'DEPROVISION',
        });
        assert.match(deprovisionJob.displayId, /^STS-\d{3,}$/);
        assert.equal(
          (
            await adminRow('SELECT kind FROM cc.jobs WHERE job_id=$1', [
              deprovisionJob.jobId,
            ])
          ).kind,
          'device-status',
        );
        assert.deepEqual(
          await adminRow(
            `SELECT device_id,baseline_value,requested_value,status
               FROM cc.device_update_operations WHERE job_id=$1`,
            [deprovisionJob.jobId],
          ),
          {
            device_id: 'b3a-deprovision',
            baseline_value: 'ACTIVE',
            requested_value: 'DEPROVISIONED',
            status: 'pending',
          },
        );
      },
    );

    await check(
      'B3 a Wipe user data confirm without WIPE answers phrase-mismatch and creates no job',
      async () => {
        const created = await previewOf(wipeActor, 'wipe-users', 'b3a-wipe');
        assert.equal(created.outcome, 'created');
        const artifactId = await publishArtifact();
        const before = (
          await adminRow(
            'SELECT count(*)::integer AS count FROM cc.jobs WHERE requested_by=$1',
            [wipeActor],
          )
        ).count;
        for (const [phrase, label] of [
          [null, 'an absent phrase'],
          ['wipe', 'a lower-case phrase'],
          [' WIPE ', 'an untrimmed phrase'],
          ['WIPEX', 'a longer phrase'],
        ]) {
          assert.deepEqual(
            await confirmOf(wipeActor, created.preview, phrase, artifactId),
            { outcome: 'phrase-mismatch' },
            label,
          );
        }
        assert.equal(
          (
            await adminRow(
              'SELECT job_id FROM cc.device_update_previews WHERE preview_id=$1',
              [created.preview.preview_id],
            )
          ).job_id,
          null,
          'A mismatch leaves the preview without a job.',
        );
        assert.equal(
          (
            await adminRow(
              'SELECT count(*)::integer AS count FROM cc.jobs WHERE requested_by=$1',
              [wipeActor],
            )
          ).count,
          before,
          'A mismatch creates no job.',
        );
        // The check refuses a wrong phrase, and the right one still creates the job.
        const accepted = await confirmOf(
          wipeActor,
          created.preview,
          'WIPE',
          artifactId,
        );
        assert.equal(accepted.outcome, 'created');
        assert.match(accepted.receipt.displayId, /^CMD-\d{3,}$/);
        jobs.push(accepted.receipt.jobId);
      },
    );

    const deprovisionRun = { admitted: null, attempt: null };
    await check(
      'B3 the manifest and the batch claim carry the reason',
      async () => {
        const manifest = deprovisionJob.manifest;
        assert.equal(manifest.outcome, 'manifest');
        assert.equal(manifest.manifest.preview.action, 'deprovision');
        assert.equal(manifest.manifest.preview.deprovisionReason, SAME_MODEL);
        const commandManifest = powerwashJob.manifest;
        assert.equal(commandManifest.outcome, 'manifest');
        assert.equal(
          commandManifest.manifest.preview.deprovisionReason,
          null,
          'A command manifest carries no reason.',
        );
        deprovisionRun.admitted = await start(deprovisionJob.jobId);
        deprovisionRun.attempt = randomUUID();
        const claimed = await claim(
          deprovisionJob.jobId,
          deprovisionRun.admitted.dispatchToken,
          deprovisionRun.attempt,
        );
        assert.equal(claimed.outcome, 'claimed');
        assert.equal(claimed.action, 'deprovision');
        assert.equal(claimed.deprovisionReason, SAME_MODEL);
        assert.deepEqual(
          claimed.operations.map((one) => [
            one.deviceId,
            one.baselineValue,
            one.requestedValue,
          ]),
          [['b3a-deprovision', 'ACTIVE', 'DEPROVISIONED']],
        );
      },
    );

    await check(
      'B3 a person without devices:wipe receives forbidden for a Powerwash preview',
      async () => {
        const limited = await createPrincipal('no-wipe', [
          'devices:read',
          'devices:bulk-actions',
          'devices:commands',
        ]);
        for (const action of ['powerwash', 'wipe-users'])
          assert.deepEqual(
            await directPreview(limited, action, digest, [
              target('b3a-powerwash'),
            ]),
            { outcome: 'forbidden' },
            `SQL refuses ${action} without devices:wipe.`,
          );
        const capable = (principal, action) =>
          adminRow('SELECT cc.write_capable($1,$2,$3) AS capable', [
            principal,
            customer,
            action,
          ]).then((row) => row.capable);
        assert.equal(await capable(limited, 'reboot'), true);
        assert.equal(await capable(limited, 'powerwash'), false);
        assert.equal(await capable(limited, 'wipe-users'), false);
        assert.equal(await capable(limited, 'deprovision'), false);
        assert.equal(
          (
            await adminRow(
              'SELECT count(*)::integer AS count FROM cc.device_update_previews WHERE created_by=$1',
              [limited],
            )
          ).count,
          0,
          'The refusal stores no preview.',
        );
        assert.equal(await capable(wipeActor, 'powerwash'), true);
        assert.equal(await capable(wipeActor, 'wipe-users'), true);
        assert.equal(await capable(wipeActor, 'deprovision'), true);
        assert.equal(await capable(wipeActor, 'reboot'), false);
      },
    );

    await check(
      'B3 a succeeded Deprovision settlement publishes DEPROVISIONED with an overlay',
      async () => {
        const { admitted, attempt } = deprovisionRun;
        const observedAt = new Date();
        const settled = await settleJob(
          deprovisionJob.jobId,
          admitted.dispatchToken,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              verifiedBy: 'write-response',
            },
          ],
          observedAt,
        );
        assert.deepEqual(
          settled.settled.map((one) => [one.deviceId, one.status]),
          [['b3a-deprovision', 'succeeded']],
        );
        const device = await adminRow(
          'SELECT status,status_observed_at FROM cc.devices WHERE customer_id=$1 AND device_id=$2',
          [customer, 'b3a-deprovision'],
        );
        assert.equal(device.status, 'DEPROVISIONED');
        assert.equal(device.status_observed_at.getTime(), observedAt.getTime());
        const overlay = await adminRow(
          `SELECT value,source,job_id,expires_at FROM cc.device_write_overlays
            WHERE customer_id=$1 AND device_id=$2 AND field='status'`,
          [customer, 'b3a-deprovision'],
        );
        assert.equal(overlay.value, 'DEPROVISIONED');
        assert.equal(overlay.source, 'write-response');
        assert.equal(overlay.job_id, deprovisionJob.jobId);
        assert.equal(
          overlay.expires_at.getTime(),
          observedAt.getTime() + 36 * 60 * 60 * 1000,
        );
        assert.deepEqual(
          await adminRow(
            `SELECT observed_value,observed_at FROM cc.device_update_operations WHERE job_id=$1`,
            [deprovisionJob.jobId],
          ).then((row) => [row.observed_value, row.observed_at.getTime()]),
          ['DEPROVISIONED', observedAt.getTime()],
        );
        assert.deepEqual(settled.publication.deviceIds, ['b3a-deprovision']);
      },
    );

    /** One command job issued through its settlement, ready for its first expiry observation. */
    const issuedJob = async ({
      actor: owner = wipeActor,
      action,
      deviceId,
      phrase,
    }) => {
      const job = await confirmedJob({
        actor: owner,
        action,
        deviceId,
        phrase,
      });
      const admitted = await start(job.jobId);
      const attempt = randomUUID();
      const claimed = await claim(job.jobId, admitted.dispatchToken, attempt);
      assert.equal(claimed.outcome, 'claimed');
      const observedAt = new Date(Date.now() - 60 * 1000);
      const settled = await settleJob(
        job.jobId,
        admitted.dispatchToken,
        attempt,
        'issue',
        [
          {
            operationNumber: 1,
            outcome: 'issued',
            commandId: '4100000123',
            verifiedBy: 'write-response',
          },
        ],
        observedAt,
      );
      assert.deepEqual(
        settled.settled.map((one) => one.status),
        ['issued'],
      );
      return { job, observedAt };
    };
    /** The first expiry observation of the job's one operation. */
    const observeExpiry = async (jobId, expiresAt) => {
      await migrator.query(
        `UPDATE cc.device_update_operations SET poll_after=clock_timestamp()-interval '1 second'
          WHERE job_id=$1`,
        [jobId],
      );
      let lease = (
        await call('SELECT cc.due_device_command_polls($1) AS result', [
          customer,
        ])
      ).find((one) => one.jobId === jobId);
      if (lease === undefined) {
        // A due job of an earlier suite holds the ten-entry answer. Grant this job its lease.
        lease = { leaseId: randomUUID() };
        await migrator.query(
          `UPDATE cc.device_update_jobs SET poll_lease_id=$2,
             poll_lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE job_id=$1`,
          [jobId, lease.leaseId],
        );
      }
      const attempt = randomUUID();
      const claimed = await call(
        'SELECT cc.claim_device_command_polls($1,$2,$3,$4) AS result',
        [customer, jobId, attempt, lease.leaseId],
      );
      assert.equal(claimed.outcome, 'claimed');
      const settled = await call(
        'SELECT cc.settle_device_command_polls($1,$2,$3,$4,$5,$6) AS result',
        [
          customer,
          jobId,
          attempt,
          lease.leaseId,
          JSON.stringify([
            {
              operationNumber: 1,
              outcome: 'pending',
              commandState: 'sent',
              commandExpiresAt: expiresAt.toISOString(),
            },
          ]),
          new Date().toISOString(),
        ],
      );
      assert.equal(settled.outcome, 'settled');
      return { leaseId: lease.leaseId, expired: settled.expired };
    };
    const operationOf = (jobId) =>
      adminRow(
        `SELECT status,command_state,command_id,command_expires_at,poll_deadline_at,outcome_reason
           FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=1`,
        [jobId],
      );

    await check(
      'B3 both deadline rules hold for Powerwash and for Reboot',
      async () => {
        const day = 24 * 60 * 60 * 1000;
        const powerwash = await issuedJob({
          action: 'powerwash',
          deviceId: 'b3a-powerwash-early',
          phrase: 'POWERWASH',
        });
        const reboot = await issuedJob({
          actor,
          action: 'reboot',
          deviceId: 'b3a-reboot',
          phrase: null,
        });
        // The issue settlement of a Powerwash ends 30 days after the issue answer. Reboot keeps 7.
        assert.equal(
          (await operationOf(powerwash.job.jobId)).poll_deadline_at.getTime(),
          await plus(powerwash.observedAt, '30 days'),
          'A Powerwash issue settlement takes 30 days.',
        );
        assert.equal(
          (await operationOf(reboot.job.jobId)).poll_deadline_at.getTime(),
          await plus(reboot.observedAt, '7 days'),
          'A Reboot issue settlement keeps 7 days.',
        );
        await finishJob(powerwash.job.jobId);
        await finishJob(reboot.job.jobId);
        // The first expiry observation of a Powerwash takes the earlier of the two deadlines.
        const earlyExpiry = new Date(powerwash.observedAt.getTime() + 10 * day);
        const early = await observeExpiry(powerwash.job.jobId, earlyExpiry);
        const powerwashObserved = await operationOf(powerwash.job.jobId);
        assert.equal(
          powerwashObserved.command_expires_at.getTime(),
          earlyExpiry.getTime(),
          'The first poll stores Google expiry.',
        );
        assert.equal(
          powerwashObserved.poll_deadline_at.getTime(),
          await plus(earlyExpiry, '24 hours'),
          'Powerwash takes Google expiry plus 24 hours when that comes first.',
        );
        // Reboot keeps the expiry plus 24 hours, even beyond its 7-day issue cap.
        const lateExpiry = new Date(reboot.observedAt.getTime() + 45 * day);
        await observeExpiry(reboot.job.jobId, lateExpiry);
        assert.equal(
          (await operationOf(reboot.job.jobId)).poll_deadline_at.getTime(),
          await plus(lateExpiry, '24 hours'),
          'Reboot takes Google expiry plus 24 hours.',
        );
        // A Powerwash whose expiry comes later keeps the 30-day issue deadline.
        const late = await issuedJob({
          action: 'powerwash',
          deviceId: 'b3a-powerwash-late',
          phrase: 'POWERWASH',
        });
        await finishJob(late.job.jobId);
        await observeExpiry(
          late.job.jobId,
          new Date(late.observedAt.getTime() + 45 * day),
        );
        assert.equal(
          (await operationOf(late.job.jobId)).poll_deadline_at.getTime(),
          await plus(late.observedAt, '30 days'),
          'Powerwash keeps the 30-day deadline when the expiry is later.',
        );
        // The deadline sweep settles the operation not-observed and the job needs review.
        await migrator.query(
          `UPDATE cc.device_update_operations SET poll_deadline_at=clock_timestamp()-interval '1 second'
            WHERE job_id=$1`,
          [powerwash.job.jobId],
        );
        const swept = await call(
          'SELECT cc.claim_device_command_polls($1,$2,$3,$4) AS result',
          [customer, powerwash.job.jobId, randomUUID(), early.leaseId],
        );
        assert.equal(swept.status, 'needs-review');
        const sweptOperation = await operationOf(powerwash.job.jobId);
        assert.equal(sweptOperation.status, 'unknown');
        assert.equal(sweptOperation.outcome_reason, 'not-observed');
      },
    );

    await check(
      'B3 the migrated functions keep PUBLIC out, grant the runtime, and hold one identity',
      async () => {
        assert.ok(
          (
            await adminRow(
              `SELECT to_regprocedure('cc.create_device_update_preview(uuid,integer,text,integer,text,jsonb,text,jsonb,integer,text)') AS found`,
            )
          ).found,
          'The preview function carries its new signature.',
        );
        assert.ok(
          (
            await adminRow(
              `SELECT to_regprocedure('cc.confirm_device_update_preview(uuid,integer,text,uuid,text,text,uuid,text)') AS found`,
            )
          ).found,
          'The confirm function carries its new signature.',
        );
        for (const old of [
          'cc.create_device_update_preview(uuid,integer,text,integer,text,jsonb,text,jsonb,integer)',
          'cc.confirm_device_update_preview(uuid,integer,text,uuid,text,text,uuid)',
        ])
          assert.equal(
            (await adminRow('SELECT to_regprocedure($1) AS found', [old]))
              .found,
            null,
            `${old} no longer exists.`,
          );
        for (const signature of [
          'create_device_update_preview(uuid,integer,text,integer,text,jsonb,text,jsonb,integer,text)',
          'confirm_device_update_preview(uuid,integer,text,uuid,text,text,uuid,text)',
        ]) {
          const row = await adminRow(
            `SELECT COALESCE(bool_or(a.grantee=0),false) AS public_grant,
              COALESCE(bool_or(a.grantee=(SELECT oid FROM pg_roles WHERE rolname='cc-app')),false) AS app_grant
             FROM pg_proc p LEFT JOIN aclexplode(p.proacl) a ON true
             WHERE p.oid=to_regprocedure('cc.${signature}')`,
          );
          assert.equal(
            row.public_grant,
            false,
            `${signature} grants PUBLIC EXECUTE.`,
          );
          assert.equal(row.app_grant, true, `${signature} runtime grant`);
        }
      },
    );

    // -------------------------------------------------------------------------------------------
    // Card B6: the previews and confirmations of the three actions (design sections 1 to 3).
    // -------------------------------------------------------------------------------------------
    const commandsNames = [
      'devices:read',
      'devices:bulk-actions',
      'devices:commands',
    ];
    const statusNames = [
      'devices:read',
      'devices:bulk-actions',
      'devices:status',
    ];
    const wipeNames = [
      'devices:read',
      'devices:bulk-actions',
      'devices:wipe',
      'devices:deprovision',
    ];
    const wipeSession = sessionFor(wipeActor, wipeNames);
    const commandsOnly = await createPrincipal('b6-commands', commandsNames);
    const statusOnly = await createPrincipal('b6-status', statusNames);

    await check(
      'B6 a person with only devices:commands previews Reboot and receives 403 for Powerwash',
      async () => {
        freshFor(commandsOnly, ['b6-active']);
        const reboot = await controllerFor('commands').preview(
          routeRequest(commandsOnly, commandsNames),
          { ...key, commandType: 'REBOOT' },
        );
        assert.equal(reboot.action, 'reboot');
        assert.equal(reboot.commandType, 'REBOOT');
        assert.equal(reboot.deprovisionReason, null);
        assert.equal(reboot.selected, 1);
        assert.equal(reboot.eligible, 1);
        const correlationId = randomUUID();
        await assert.rejects(
          controllerFor('commands').preview(
            routeRequest(commandsOnly, commandsNames, correlationId),
            { ...key, commandType: 'REMOTE_POWERWASH' },
          ),
          (error) => {
            assert.equal(error.getStatus?.(), 403, String(error));
            return true;
          },
        );
        const events = (
          await migrator.query(
            `SELECT detail FROM cc.security_events
               WHERE event='access-denied' AND correlation_id=$1`,
            [correlationId],
          )
        ).rows;
        assert.deepEqual(
          events.map((row) => row.detail),
          ['devices:wipe'],
          'The route checks the Powerwash permission after the family guard.',
        );
        assert.deepEqual(
          await directPreview(commandsOnly, 'powerwash', digest, [
            target('b6-active'),
          ]),
          { outcome: 'forbidden' },
          'SQL refuses the Powerwash preview without devices:wipe.',
        );
      },
    );

    await check(
      'B6 a person with only devices:status receives 403 for a Deprovision preview',
      async () => {
        const correlationId = randomUUID();
        await assert.rejects(
          controllerFor('status').preview(
            routeRequest(statusOnly, statusNames, correlationId),
            {
              ...key,
              statusAction: 'deprovision',
              deprovisionReason: RETIRING,
            },
          ),
          (error) => {
            assert.equal(error.getStatus?.(), 403, String(error));
            return true;
          },
        );
        const events = (
          await migrator.query(
            `SELECT detail FROM cc.security_events
               WHERE event='access-denied' AND correlation_id=$1`,
            [correlationId],
          )
        ).rows;
        assert.deepEqual(
          events.map((row) => row.detail),
          ['devices:deprovision'],
        );
        assert.deepEqual(
          await directPreview(
            statusOnly,
            'deprovision',
            digest,
            [target('b6-deprovision-target')],
            RETIRING,
          ),
          { outcome: 'forbidden' },
          'SQL refuses the Deprovision preview without devices:deprovision.',
        );
      },
    );

    await check(
      'B6 a Deprovision preview without a reason answers 400 before any person check',
      async () => {
        const correlationId = randomUUID();
        const rejection = await controllerFor('status')
          .preview(routeRequest(statusOnly, statusNames, correlationId), {
            ...key,
            statusAction: 'deprovision',
          })
          .then(
            () => null,
            (error) => error,
          );
        assert.ok(
          rejection,
          'The route refuses a Deprovision body without a reason.',
        );
        assert.equal(rejection.name, 'ZodError');
        // The Zod handler answers the generic 400 body of the exception filter.
        const response = {
          code: 0,
          body: null,
          status(code) {
            this.code = code;
            return this;
          },
          json(body) {
            this.body = body;
            return this;
          },
        };
        const host = {
          switchToHttp: () => ({
            getRequest: () => ({
              path: '/api/devices/status-changes/previews',
              correlationId,
            }),
            getResponse: () => response,
          }),
        };
        new ApplicationExceptionFilter().catch(rejection, host);
        assert.equal(response.code, 400);
        assert.equal(response.body.code, 'invalid-request');
        assert.equal(
          (
            await migrator.query(
              'SELECT count(*)::integer AS count FROM cc.device_update_previews WHERE created_by=$1',
              [statusOnly],
            )
          ).rows[0].count,
          0,
          'The refused body stores no preview.',
        );
      },
    );

    await check(
      'B6 a Powerwash preview of ACTIVE, DISABLED, and DEPROVISIONED devices lists two exclusion reasons',
      async () => {
        freshFor(wipeActor, ['b6-active', 'b6-disabled', 'b6-deprovisioned']);
        const preview = await actions.preview(
          wipeSession,
          current,
          'powerwash',
          key,
        );
        assert.equal(preview.action, 'powerwash');
        assert.equal(preview.commandType, 'REMOTE_POWERWASH');
        assert.equal(preview.statusAction, null);
        assert.equal(preview.deprovisionReason, null);
        assert.equal(preview.selected, 3);
        assert.equal(preview.eligible, 1);
        assert.equal(preview.excluded, 2);
        const page = await actions.targets(
          wipeSession,
          preview.previewId,
          COMMAND_PREVIEW_FAMILY,
          undefined,
          undefined,
          100,
        );
        assert.deepEqual(
          page.targets.map((row) => [
            row.deviceId,
            row.disposition,
            row.exclusionReason,
          ]),
          [
            ['b6-active', 'eligible', null],
            ['b6-deprovisioned', 'excluded', 'device-deprovisioned'],
            ['b6-disabled', 'excluded', 'device-disabled'],
          ],
        );
      },
    );

    await check(
      'B6 a Powerwash preview answers phrase-mismatch for WIPE and stores no manifest',
      async () => {
        freshFor(wipeActor, ['b6-powerwash']);
        const preview = await actions.preview(
          wipeSession,
          current,
          'powerwash',
          key,
        );
        assert.equal(preview.action, 'powerwash');
        const storedBefore = storedDocuments.length;
        const jobsBefore = (
          await adminRow(
            'SELECT count(*)::integer AS count FROM cc.device_update_previews WHERE created_by=$1 AND job_id IS NOT NULL',
            [wipeActor],
          )
        ).count;
        await assert.rejects(
          actions.confirm(
            wipeSession,
            current,
            preview.previewId,
            {
              manifestDigest: preview.manifestDigest,
              acknowledged: true,
              typedPhrase: 'WIPE',
            },
            COMMAND_PREVIEW_FAMILY,
          ),
          (error) => {
            assert.equal(error.getStatus(), 422, String(error));
            assert.deepEqual(error.getResponse(), {
              reason: 'phrase-mismatch',
            });
            return true;
          },
        );
        assert.equal(
          storedDocuments.length,
          storedBefore,
          'A mismatch stores no manifest.',
        );
        assert.equal(
          (
            await adminRow(
              'SELECT job_id FROM cc.device_update_previews WHERE preview_id=$1',
              [preview.previewId],
            )
          ).job_id,
          null,
          'A mismatch leaves the preview without a job.',
        );
        assert.equal(
          (
            await adminRow(
              'SELECT count(*)::integer AS count FROM cc.device_update_previews WHERE created_by=$1 AND job_id IS NOT NULL',
              [wipeActor],
            )
          ).count,
          jobsBefore,
          'A mismatch creates no job.',
        );
        // The right phrase still confirms, after trimming the typed spaces.
        const accepted = await actions.confirm(
          wipeSession,
          current,
          preview.previewId,
          {
            manifestDigest: preview.manifestDigest,
            acknowledged: true,
            typedPhrase: ' POWERWASH ',
          },
          COMMAND_PREVIEW_FAMILY,
        );
        assert.equal(accepted.existing, false);
        assert.match(accepted.receipt.displayId, /^CMD-\d{3,}$/);
        jobs.push(accepted.receipt.jobId);
      },
    );

    await check(
      'B6 a trimmed DEPROVISION phrase creates a Deprovision job with its reason',
      async () => {
        freshFor(wipeActor, ['b6-deprovision-target']);
        const preview = await actions.preview(
          wipeSession,
          current,
          'deprovision',
          key,
          undefined,
          SAME_MODEL,
        );
        assert.equal(preview.action, 'deprovision');
        assert.equal(preview.statusAction, 'deprovision');
        assert.equal(preview.commandType, null);
        assert.equal(preview.deprovisionReason, SAME_MODEL);
        assert.deepEqual(
          await adminRow(
            'SELECT action,deprovision_reason FROM cc.device_update_previews WHERE preview_id=$1',
            [preview.previewId],
          ),
          { action: 'deprovision', deprovision_reason: SAME_MODEL },
        );
        const confirmed = await actions.confirm(
          wipeSession,
          current,
          preview.previewId,
          {
            manifestDigest: preview.manifestDigest,
            acknowledged: true,
            typedPhrase: ' DEPROVISION ',
          },
          STATUS_PREVIEW_FAMILY,
        );
        assert.equal(confirmed.existing, false);
        assert.match(confirmed.receipt.displayId, /^STS-\d{3,}$/);
        jobs.push(confirmed.receipt.jobId);
        assert.deepEqual(
          await adminRow(`SELECT kind FROM cc.jobs WHERE job_id=$1`, [
            confirmed.receipt.jobId,
          ]),
          { kind: 'device-status' },
        );
        assert.deepEqual(
          await adminRow(
            `SELECT action,preview_id FROM cc.device_update_jobs WHERE job_id=$1`,
            [confirmed.receipt.jobId],
          ),
          { action: 'deprovision', preview_id: preview.previewId },
        );
        assert.deepEqual(
          await adminRow(
            `SELECT baseline_value,requested_value FROM cc.device_update_operations WHERE job_id=$1`,
            [confirmed.receipt.jobId],
          ),
          { baseline_value: 'ACTIVE', requested_value: 'DEPROVISIONED' },
        );
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
    throw new Error(`Device action checks failed: ${failures.join(' | ')}`);
  return results;
}
