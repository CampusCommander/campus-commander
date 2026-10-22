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
  const devices = await module('api/src/app/devices/devices.service.ts');
  const auth = await module('api/src/app/auth/auth.service.ts');
  const database = await module('api/src/app/database/database.service.ts');
  return {
    DeviceActions: actions.DeviceActions,
    COMMAND_PREVIEW_FAMILY: actions.COMMAND_PREVIEW_FAMILY,
    STATUS_PREVIEW_FAMILY: actions.STATUS_PREVIEW_FAMILY,
    actionManifestDigest: actions.actionManifestDigest,
    DEVICE_COMMAND_ROUTE_ACTIONS: guards.DEVICE_COMMAND_ROUTE_ACTIONS,
    DEVICE_STATUS_ROUTE_ACTIONS: guards.DEVICE_STATUS_ROUTE_ACTIONS,
    requireDeviceActions: guards.requireDeviceActions,
    selectionStorageKey: selection.selectionStorageKey,
    DeviceCommandsController: controller.DeviceCommandsController,
    DeviceStatusChangesController: controller.DeviceStatusChangesController,
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
    DEVICE_COMMAND_ROUTE_ACTIONS,
    DEVICE_STATUS_ROUTE_ACTIONS,
    requireDeviceActions,
    selectionStorageKey,
    DeviceCommandsController,
    DeviceStatusChangesController,
    DevicesService,
    AuthService,
    DatabaseService,
  } = await load();
  const actor = randomUUID();
  const createdPrincipals = [actor];
  const key = {
    gridId: 'devices',
    tabId: '66666666-6666-4666-8666-666666666666',
  };
  const selectionKey = selectionStorageKey(actor, key);
  const selections = new Map();
  const cache = { get: async (name) => selections.get(name) ?? null };
  const storage = { storeJson: async () => randomUUID() };
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
    for (const id of createdPrincipals.slice(1)) await removePrincipal(id);
    await removePrincipal(actor);
    await migrator.query(
      "DELETE FROM cc.devices WHERE customer_id=$1 AND device_id LIKE 'b3a-%'",
      [customer],
    );
  };
  const directPreview = async (principal, action, digest, targets) =>
    (
      await runtime.query(
        `SELECT cc.create_device_update_preview($1::uuid,$2::integer,$3::text,$4::integer,
           $5::text,$6::jsonb,$7::text,$8::jsonb,$9::integer) AS result`,
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
      'B3A the route guards require the read, Bulk Actions, and family action in order',
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
          DEVICE_COMMAND_ROUTE_ACTIONS,
        );
        await requireDeviceActions(
          auth,
          session,
          customer,
          randomUUID(),
          DEVICE_STATUS_ROUTE_ACTIONS,
        );
        assert.deepEqual(calls, [
          'devices:read',
          'devices:bulk-actions',
          'devices:commands',
          'devices:read',
          'devices:bulk-actions',
          'devices:status',
        ]);
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
