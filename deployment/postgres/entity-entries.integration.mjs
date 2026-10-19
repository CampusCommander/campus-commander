import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from 'redis';
import * as contracts from '@campus/application-contracts';
import { redisImage } from '../redis/runtime.mjs';

// The namespace import keeps this suite loadable before the entry schema lands.
const { entityEntrySchema, entityKey, isStale } = contracts;
const workspace = resolve(import.meta.dirname, '../..');
// The API and the worker depend on the deployment package, so this harness loads their source
// at run time. A static import would make the project graph circular (design section 5.11).
const load = (path) => import(pathToFileURL(resolve(workspace, path)).href);

// The P3 checks of design section 8.3: entry versions, both writers, and the read check.
// Every check runs against a real Redis and the integration PostgreSQL instance.
export async function qualifyEntityEntries({ runtime, migrator, issuer }) {
  const [{ DevicePager }, { EntitySyncBatch }] = await Promise.all([
    load('api/src/app/devices/device-pager.ts'),
    load('worker/src/entity-sync.ts'),
  ]);
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const wasActive = connection.active;
  await migrator.query('UPDATE cc.google_connection SET active=true');
  const actor = randomUUID();
  const other = randomUUID();
  const results = [];
  const failures = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const statement = (text, values = []) =>
    runtime.query(text, values).then((r) => r.rows);
  const result = (text, values = []) =>
    runtime.query(text, values).then((r) => r.rows[0].result);
  const admin = (text, values = []) =>
    migrator.query(text, values).then((r) => r.rows);
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
  const docker = (...args) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const container = `cc-p3-redis-${randomBytes(6).toString('hex')}`;
  let client;
  try {
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      container,
      '-p',
      '127.0.0.1::6379',
      redisImage,
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
      '--protected-mode',
      'no',
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if (docker('exec', container, 'redis-cli', 'ping') === 'PONG') break;
      } catch {
        /* Retry bounded startup. */
      }
      await sleep(100);
    }
    const port = Number(
      docker('port', container, '6379/tcp').split(':').at(-1),
    );
    client = createClient({
      url: `redis://127.0.0.1:${port}`,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: false },
    });
    client.on('error', () => {
      /* A failed command reports its own error. */
    });
    await client.connect();
    await client.ping();

    for (const id of [actor, other])
      await migrator.query(
        'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
        [id, issuer, id],
      );
    for (const id of [actor, other])
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [
          id,
          'devices:read',
          JSON.stringify({ kind: 'district', customerId: customer }),
        ],
      );

    const observation = (deviceId, annotatedLocation) => ({
      deviceId,
      serialNumber: `SN-${deviceId}`,
      model: 'Lenovo 100e Gen 4',
      assetTag: null,
      orgUnitPath: '/School A',
      lastContact: '2026-10-01T12:00:00.000Z',
      annotatedLocation,
      notes: null,
      status: 'ACTIVE',
    });
    const battery = (deviceId) => ({
      deviceId,
      battery: {
        status: 'reported',
        health: 'normal',
        capacityPercent: 80,
        reportedAt: '2026-10-01T11:00:00.000Z',
      },
      reports: [],
    });
    const cacheOf = ({ seconds, ...overrides } = {}) => ({
      async setRecords(entries) {
        for (const entry of entries)
          await client.set(entry.key, entry.value, {
            EX: seconds ?? entry.seconds,
          });
      },
      async remove(keys) {
        if (keys.length) await client.del(keys);
      },
      async removeMembers(key, members) {
        if (members.length) await client.zRem(key, members);
      },
      async extendMembers() {
        /* No in-flight reclamation in these checks. */
      },
      async increment(key) {
        await client.incr(key);
      },
      async publish() {
        /* The readers in these checks read Redis directly. */
      },
      async close() {
        /* The client belongs to the check runner. */
      },
      ...overrides,
    });
    const pagerCache = {
      get: (key) => client.get(key),
      getMany: (keys) => client.mGet([...keys]),
      listSlice: async () => ({ length: 0, ids: [] }),
      replaceList: async () => undefined,
      remove: (key) => client.del(key),
    };
    const cipher = { open: () => ({ synthetic: true }) };
    const refresh = async (deviceId, annotatedLocation, cache) => {
      const jobId = randomUUID();
      await result(
        'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
        [
          actor,
          customer,
          'device',
          JSON.stringify([deviceId]),
          1000,
          jobId,
          randomUUID(),
        ],
      );
      const reader = {
        async deviceBatch(_credential, _customerId, ids) {
          return {
            devices: ids.map((id) => observation(id, annotatedLocation)),
            missing: [],
          };
        },
        async batteryBatch() {
          return [];
        },
      };
      return new EntitySyncBatch(
        runtime,
        cipher,
        reader,
        cache ?? cacheOf(),
      ).run(
        {
          customerId: customer,
          jobId,
          batch: 0,
          correlationId: randomUUID(),
        },
        AbortSignal.timeout(15000),
      );
    };
    const request = async (principal = actor) => {
      const id = randomUUID();
      const state = await result(
        'SELECT cc.request_device_sync($1,1,$2,$3,$4,$5) AS result',
        [principal, customer, generation, id, randomUUID()],
      );
      return { id, state };
    };
    const fullSync = async (
      devices,
      telemetryFailure = null,
      principal = actor,
    ) => {
      const { id } = await request(principal);
      const attempt = randomUUID();
      await result('SELECT cc.claim_device_sync($1,$2,$3) AS result', [
        customer,
        id,
        attempt,
      ]);
      await result('SELECT cc.stage_devices($1,$2,$3,$4) AS result', [
        customer,
        id,
        attempt,
        JSON.stringify(devices),
      ]);
      return result('SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result', [
        customer,
        id,
        attempt,
        null,
        telemetryFailure,
      ]);
    };
    const hydrate = async (ids, options = {}) => {
      const tracked = [];
      const rows = async (sql) => {
        const page = (await runtime.query(sql.text, sql.values)).rows;
        tracked.push(page);
        return page;
      };
      const read = await new DevicePager(pagerCache).hydrate(
        customer,
        ids,
        rows,
        options.now ?? Date.now(),
      );
      return { ...read, tracked };
    };
    const storedEntry = async (deviceId) => {
      const raw = await client.get(entityKey('device', customer, deviceId));
      assert.notEqual(raw, null, 'The writer stores an entry.');
      assert.ok(entityEntrySchema, 'entityEntrySchema exists');
      return entityEntrySchema.parse(JSON.parse(raw));
    };
    const gate = () => {
      let open;
      let entered;
      const opened = new Promise((resolve) => {
        open = resolve;
      });
      const enteredP = new Promise((resolve) => {
        entered = resolve;
      });
      return {
        opened,
        entered: enteredP,
        open: () => open(),
        enter: () => entered(),
      };
    };
    // The writer reads its entry, then waits here before it stores that entry.
    const pausedCache = (control) => {
      let first = true;
      return cacheOf({
        async setRecords(entries) {
          if (first) {
            first = false;
            control.enter();
            await control.opened;
          }
          for (const entry of entries)
            await client.set(entry.key, entry.value, { EX: entry.seconds });
        },
      });
    };

    // A synthetic empty inventory starts every check from a known state.
    await fullSync([]);

    const versionOf = async (deviceId) =>
      Number(
        (
          await admin(
            'SELECT record_version FROM cc.devices WHERE customer_id=$1 AND device_id=$2',
            [customer, deviceId],
          )
        )[0].record_version,
      );
    const telemetryVersion = async () =>
      Number(
        (
          await admin(
            'SELECT telemetry_version FROM cc.device_sync_state WHERE customer_id=$1',
            [customer],
          )
        )[0].telemetry_version,
      );
    const telemetryRequester = async () =>
      (
        await admin(
          'SELECT telemetry_failure_requested_by FROM cc.device_sync_state WHERE customer_id=$1',
          [customer],
        )
      )[0].telemetry_failure_requested_by;
    const elements = async (deviceId) =>
      result('SELECT cc.read_device_records($1,$2) AS result', [
        customer,
        JSON.stringify([deviceId]),
      ]);

    await check(
      'each device writer raises the record version and an unchanged update keeps it',
      async () => {
        const id = 'p3v-writer';
        const at = new Date().toISOString();
        const write = (devices, kind = 'list') =>
          result('SELECT cc.upsert_devices($1,$2,$3,$4) AS result', [
            customer,
            JSON.stringify(devices),
            at,
            kind,
          ]);
        await write([observation(id, null)]);
        assert.equal(await versionOf(id), 1);
        await write([observation(id, null)]);
        assert.equal(
          await versionOf(id),
          1,
          'An unchanged update keeps the version.',
        );
        await write([{ ...observation(id, null), serialNumber: 'SN-changed' }]);
        assert.equal(await versionOf(id), 2);
        await result('SELECT cc.upsert_device_batteries($1,$2) AS result', [
          customer,
          JSON.stringify([battery(id)]),
        ]);
        assert.equal(
          await versionOf(id),
          3,
          'A battery update raises the version.',
        );
        const [element] = await result(
          'SELECT cc.read_device_records($1,$2) AS result',
          [customer, JSON.stringify([id])],
        );
        assert.equal(
          element.version,
          (await versionOf(id)) + (await telemetryVersion()),
        );
        assert.equal(element.record.deviceId, id);
        const [paged] = await result(
          'SELECT cc.page_device_records($1,$2,$3) AS result',
          [customer, 'p3v-', 10],
        );
        assert.equal(
          paged.version,
          (await versionOf(id)) + (await telemetryVersion()),
        );
        await result('SELECT cc.soft_delete_devices($1,$2) AS result', [
          customer,
          JSON.stringify([id]),
        ]);
        assert.equal(
          await versionOf(id),
          4,
          'A soft delete raises the version.',
        );
        const read = await result(
          'SELECT cc.read_device_records($1,$2) AS result',
          [customer, JSON.stringify([id])],
        );
        assert.deepEqual(read, [], 'The read returns present devices only.');
      },
    );

    await check(
      'a telemetry failure raises the telemetry version and each element carries the sum',
      async () => {
        await refresh('p3v-telemetry', 'telemetry');
        await fullSync([observation('p3v-telemetry', 'telemetry')], null);
        const cleared = await telemetryVersion();
        const clearedRecord = await versionOf('p3v-telemetry');
        assert.equal(
          (await elements('p3v-telemetry'))[0].version,
          clearedRecord + cleared,
        );
        await fullSync([observation('p3v-telemetry', 'telemetry')], 'quota');
        assert.equal(await telemetryVersion(), cleared + 1);
        assert.equal(
          (await elements('p3v-telemetry'))[0].version,
          (await versionOf('p3v-telemetry')) + cleared + 1,
        );
      },
    );

    await check(
      'a finish that keeps the telemetry failure and changes its requester keeps the telemetry version',
      async () => {
        await fullSync([observation('p3v-telemetry', 'telemetry')], 'quota');
        assert.equal(await telemetryRequester(), actor);
        const before = await telemetryVersion();
        await fullSync(
          [observation('p3v-telemetry', 'telemetry')],
          'quota',
          other,
        );
        assert.equal(
          await telemetryVersion(),
          before,
          'The requester alone does not raise the version.',
        );
        assert.equal(await telemetryRequester(), other);
      },
    );

    await check(
      'the refresh writer stores an entry the reader serves',
      async () => {
        await refresh('p3e-hit', 'hit-value');
        const entry = await storedEntry('p3e-hit');
        assert.equal(entry.record.deviceId, 'p3e-hit');
        assert.equal(entry.record.annotatedLocation, 'hit-value');
        assert.equal('removedAt' in entry.record, false);
        assert.ok(entry.version >= 1);
        const read = await hydrate(['p3e-hit']);
        assert.equal(read.rows[0].annotatedLocation, 'hit-value');
        assert.equal(read.tracked.length, 1);
        assert.equal(
          read.tracked[0][0].serial_number,
          null,
          'A current entry adds no row columns.',
        );
      },
    );

    await check('an overwritten entry reads the newer row', async () => {
      await refresh('p3e-overwrite', 'A');
      const control = gate();
      const paused = refresh('p3e-overwrite', 'A-old', pausedCache(control));
      await control.entered;
      await refresh('p3e-overwrite', 'B');
      control.open();
      await paused;
      const entry = await storedEntry('p3e-overwrite');
      assert.equal(entry.record.annotatedLocation, 'A-old');
      const read = await hydrate(['p3e-overwrite']);
      assert.equal(read.rows[0].annotatedLocation, 'B');
    });

    await check(
      'an entry stored after a Redis restart reads the newer row',
      async () => {
        await refresh('p3e-loss', 'A');
        const control = gate();
        const paused = refresh('p3e-loss', 'A-old', pausedCache(control));
        await control.entered;
        await refresh('p3e-loss', 'B');
        await client.flushDb();
        control.open();
        await paused;
        const entry = await storedEntry('p3e-loss');
        assert.equal(entry.record.annotatedLocation, 'A-old');
        const read = await hydrate(['p3e-loss']);
        assert.equal(read.rows[0].annotatedLocation, 'B');
      },
    );

    await check('an expired newer entry reads the newer row', async () => {
      await refresh('p3e-expired', 'A');
      const control = gate();
      const paused = refresh('p3e-expired', 'A-old', pausedCache(control));
      await control.entered;
      // The test clock gives the newer entry one second in the cache.
      await refresh('p3e-expired', 'B', cacheOf({ seconds: 1 }));
      await sleep(1200);
      assert.equal(
        await client.get(entityKey('device', customer, 'p3e-expired')),
        null,
        'The newer entry expired.',
      );
      control.open();
      await paused;
      const entry = await storedEntry('p3e-expired');
      assert.equal(entry.record.annotatedLocation, 'A-old');
      const read = await hydrate(['p3e-expired']);
      assert.equal(read.rows[0].annotatedLocation, 'B');
    });

    await check('a telemetry failure rejects the waiting entry', async () => {
      const { id } = await request();
      const attempt = randomUUID();
      await result('SELECT cc.claim_device_sync($1,$2,$3) AS result', [
        customer,
        id,
        attempt,
      ]);
      await result('SELECT cc.stage_devices($1,$2,$3,$4) AS result', [
        customer,
        id,
        attempt,
        JSON.stringify([observation('p3e-telemetry', 'telemetry-value')]),
      ]);
      await result('SELECT cc.stage_device_batteries($1,$2,$3,$4) AS result', [
        customer,
        id,
        attempt,
        JSON.stringify([battery('p3e-telemetry')]),
      ]);
      await result('SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result', [
        customer,
        id,
        attempt,
        null,
        null,
      ]);
      await refresh('p3e-telemetry', 'telemetry-value');
      const waiting = await storedEntry('p3e-telemetry');
      assert.equal(waiting.record.battery.status, 'reported');
      await fullSync(
        [observation('p3e-telemetry', 'telemetry-value')],
        'quota',
      );
      // The entry keeps the record of the old telemetry state at the new record version.
      // A reader that omits the telemetry version accepts it and serves the old battery.
      await client.set(
        entityKey('device', customer, 'p3e-telemetry'),
        JSON.stringify({
          ...waiting,
          version: await versionOf('p3e-telemetry'),
        }),
        { EX: 3600 },
      );
      const read = await hydrate(['p3e-telemetry']);
      assert.equal(read.rows[0].battery.status, 'unavailable');
      await fullSync([observation('p3e-telemetry', 'telemetry-value')], null);
    });

    await check(
      'a removed device reads the removed row from Postgres',
      async () => {
        await refresh('p3e-removed', 'A');
        const control = gate();
        const paused = refresh('p3e-removed', 'paused', pausedCache(control));
        await control.entered;
        await refresh('p3e-removed', 'newer');
        await fullSync([observation('p3e-removed-other', null)]);
        const removed = (
          await admin(
            'SELECT removed_at FROM cc.devices WHERE customer_id=$1 AND device_id=$2',
            [customer, 'p3e-removed'],
          )
        )[0];
        assert.ok(removed.removed_at instanceof Date);
        control.open();
        await paused;
        const entry = await storedEntry('p3e-removed');
        assert.equal(entry.record.annotatedLocation, 'paused');
        const read = await hydrate(['p3e-removed']);
        assert.equal(read.rows[0].annotatedLocation, 'newer');
      },
    );

    await check(
      'a current entry past its freshness reads stale true',
      async () => {
        await refresh('p3e-late', 'late-value');
        await migrator.query(
          "UPDATE cc.devices SET last_entity_sync=clock_timestamp()-interval '25 hours' WHERE customer_id=$1 AND device_id=$2",
          [customer, 'p3e-late'],
        );
        const current = (
          await result('SELECT cc.read_device_records($1,$2) AS result', [
            customer,
            JSON.stringify(['p3e-late']),
          ])
        )[0];
        await client.set(
          entityKey('device', customer, 'p3e-late'),
          JSON.stringify(current),
          { EX: 3600 },
        );
        const read = await hydrate(['p3e-late']);
        assert.equal(read.rows[0].stale, true);
        assert.equal(
          read.tracked[0][0].serial_number,
          null,
          'A current entry adds no row columns.',
        );
      },
    );

    await check(
      'an unreadable, foreign, or malformed entry reads Postgres',
      async () => {
        await refresh('p3e-broken', 'broken-value');
        await refresh('p3e-foreign', 'foreign-value');
        await refresh('p3e-shape', 'shape-value');
        await refresh('p3e-valid', 'valid-value');
        await client.set(
          entityKey('device', customer, 'p3e-broken'),
          '{not json',
        );
        const foreign = await storedEntry('p3e-foreign');
        await client.set(
          entityKey('device', customer, 'p3e-foreign'),
          JSON.stringify({
            ...foreign,
            record: { ...foreign.record, deviceId: 'p3e-other' },
          }),
        );
        const shape = await storedEntry('p3e-shape');
        await client.set(
          entityKey('device', customer, 'p3e-shape'),
          JSON.stringify({ record: shape.record }),
        );
        const valid = await storedEntry('p3e-valid');
        await client.set(
          entityKey('device', customer, 'p3e-valid'),
          JSON.stringify({
            ...valid,
            record: { ...valid.record, serialNumber: 'R-p3e-valid' },
          }),
        );
        const read = await hydrate([
          'p3e-broken',
          'p3e-foreign',
          'p3e-shape',
          'p3e-valid',
        ]);
        assert.deepEqual(
          read.rows.map((row) => row.serialNumber),
          ['SN-p3e-broken', 'SN-p3e-foreign', 'SN-p3e-shape', 'R-p3e-valid'],
        );
      },
    );

    await check(
      'a 1,000-row page of full hits stays within the budget',
      async () => {
        const ids = Array.from(
          { length: 1000 },
          (_, index) => `p3b-${String(index).padStart(4, '0')}`,
        );
        await result('SELECT cc.upsert_devices($1,$2,$3,$4) AS result', [
          customer,
          JSON.stringify(ids.map((id) => observation(id, null))),
          new Date().toISOString(),
          'list',
        ]);
        const entries = await result(
          'SELECT cc.page_device_records($1,$2,$3) AS result',
          [customer, 'p3b-', 1000],
        );
        assert.equal(entries.length, 1000);
        for (const entry of entries)
          await client.set(
            entityKey('device', customer, entry.record.deviceId),
            JSON.stringify(entry),
            { EX: 3600 },
          );
        const now = Date.now();
        const baseline = async () => {
          assert.ok(entityEntrySchema, 'entityEntrySchema exists');
          const raw = await client.mGet(
            ids.map((id) => entityKey('device', customer, id)),
          );
          return raw.flatMap((value) => {
            if (value === null) return [];
            const entry = entityEntrySchema.parse(JSON.parse(value));
            return [
              {
                ...entry.record,
                stale: isStale('device', entry.record.lastEntitySync, now),
              },
            ];
          });
        };
        const layout = async () => {
          const read = await hydrate(ids, { now });
          assert.equal(read.rows.length, 1000);
          assert.equal(read.tracked[0].length, 1000);
          return read.rows;
        };
        for (let round = 0; round < 5; round++) {
          await baseline();
          await layout();
        }
        const measure = async (run) => {
          const samples = [];
          for (let round = 0; round < 25; round++) {
            const started = process.hrtime.bigint();
            await run();
            samples.push(Number(process.hrtime.bigint() - started) / 1e6);
          }
          samples.sort((left, right) => left - right);
          return samples[Math.ceil(samples.length * 0.95) - 1];
        };
        const without = await measure(baseline);
        const withCheck = await measure(layout);
        const added = withCheck - without;
        process.stderr.write(
          `entry budget p95 without=${without.toFixed(2)}ms with=${withCheck.toFixed(2)}ms added=${added.toFixed(2)}ms\n`,
        );
        assert.ok(
          added < 20,
          `The check added ${added.toFixed(2)}ms to the p95, above the 20ms budget.`,
        );
      },
    );
  } finally {
    try {
      client?.destroy();
    } catch {
      /* The client did not connect. */
    }
    try {
      docker('rm', '-f', '-v', container);
    } catch {
      /* The container was not created. */
    }
    try {
      await migrator.query(
        'UPDATE cc.device_sync_state SET sync_id=NULL,sync_actor=NULL,sync_generation=NULL,sync_attempt=NULL,sync_expires_at=NULL,failure=NULL,failure_requested_by=NULL,telemetry_failure_requested_by=NULL WHERE customer_id=$1',
        [customer],
      );
      await migrator.query(
        'DELETE FROM cc.jobs WHERE requested_by=ANY($1::uuid[])',
        [[actor, other]],
      );
      await migrator.query(
        'DELETE FROM cc.application_grants WHERE principal_id=ANY($1::uuid[])',
        [[actor, other]],
      );
      await migrator.query(
        'DELETE FROM cc.application_principals WHERE id=ANY($1::uuid[])',
        [[actor, other]],
      );
      await migrator.query(
        "DELETE FROM cc.devices WHERE customer_id=$1 AND device_id LIKE 'p3%'",
        [customer],
      );
      await migrator.query('UPDATE cc.google_connection SET active=$1', [
        wasActive,
      ]);
    } catch {
      /* A failed cleanup leaves fixture rows in a disposable database. */
    }
  }
  if (failures.length)
    throw new Error(`Entity entry checks failed: ${failures.join(' | ')}`);
  return results;
}
