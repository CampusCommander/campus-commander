/**
 * Runs the device sync workers against a synthetic PostgreSQL and the admin SDK mock.
 *
 * A refresh read takes its stamp before the Google call. This file holds that answer, runs a newer
 * full sync that does not see the device, then releases the answer. The removal must stay, because
 * the presence observation is older than the absence. A later presence read restores the device.
 * A repeated 404 moves the tombstone and a 404 that a newer presence predates stores no removal.
 * An accepted write overlay stays through all of it, and a later list observation converges it.
 *
 * Docker and the qualified image in deployment/postgres/qualification.json are required.
 * Run the file inside `nx run worker:test`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { startMock } from '@campuscommander/admin-sdk-mock';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import {
  GoogleDeviceReader,
  validateServiceAccount,
} from '@campus/google-connection';
import {
  loadMigrations,
  migrate,
  provision,
} from '../../deployment/postgres/index.mjs';
import { DeviceSync } from './device-sync.ts';
import { EntitySyncBatch } from './entity-sync.ts';

const qualification = JSON.parse(
  await readFile(
    new URL('../../deployment/postgres/qualification.json', import.meta.url),
    'utf8',
  ),
);
const timeout = 120_000;
const scopes = ['device-inventory', 'device-telemetry'].map(
  (id) => GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope,
);

let mock;
let domain;
let credential;
let reader;
let container;
let volume;
let port;
let admin;
let migrator;
let runtime;

const secret = randomUUID() + randomUUID();
const subject = 'device-removal-fence@example.test';
const issuer = 'https://device-removal-fence.example.test';

const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

async function pool(userName, database) {
  const value = new pg.Pool({
    host: '127.0.0.1',
    port,
    user: userName,
    database,
    ['password']: secret,
    max: 4,
    connectionTimeoutMillis: 2_000,
  });
  await value.query('SELECT 1');
  return value;
}

async function connectAdmin() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const client = new pg.Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      database: 'postgres',
      ['password']: secret,
      connectionTimeoutMillis: 1_000,
    });
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error('The synthetic PostgreSQL did not start.');
}

/** A cache that records each call, so a test can assert the effects of one batch. */
const recordingCache = () => {
  const calls = { remove: [], setRecords: [], publish: [] };
  return {
    calls,
    extendMembers: async () => undefined,
    removeMembers: async () => undefined,
    remove: async (keys) => {
      calls.remove.push(keys);
    },
    setRecords: async (entries) => {
      calls.setRecords.push(entries.map((entry) => entry.key));
    },
    increment: async () => undefined,
    publish: async (_channel, message) => {
      calls.publish.push(JSON.parse(message));
    },
  };
};

const cipher = { open: () => credential };

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** The real reader. Each answer is captured first, so a test holds the answer itself. */
const holdingReader = (entered, release) => ({
  async deviceBatch(...args) {
    const answer = await reader.deviceBatch(...args);
    entered.resolve();
    await release.promise;
    return answer;
  },
  batteryBatch: (...args) => reader.batteryBatch(...args),
  devicePages: (...args) => reader.devicePages(...args),
  batteryPages: (...args) => reader.batteryPages(...args),
});

/** A page stream with no page. The absence is the test's controlled answer. */
async function* noPages() {
  for (const page of []) yield page;
}

/** A full sync that enumerates no device. */
const absentReader = () => ({
  devicePages: noPages,
  batteryPages: noPages,
});

/** A refresh read that answers the named devices as present, through the real reader. */
const answeringReader = (present) => ({
  async deviceBatch(_credential, _customerId, ids) {
    const answer = await reader.deviceBatch(
      credential,
      domain.customerId,
      ids,
      AbortSignal.timeout(timeout),
    );
    return {
      devices: answer.devices.filter((device) => present(device.deviceId)),
      missing: ids.filter((id) => !present(id)),
    };
  },
  async batteryBatch(_credential, customerId, ids) {
    return reader.batteryBatch(
      credential,
      customerId,
      ids,
      AbortSignal.timeout(timeout),
    );
  },
});

before(async () => {
  container = `cc-device-fence-${randomUUID().slice(0, 8)}`;
  docker(
    'run',
    '-d',
    '--name',
    container,
    '--label',
    'campus-commander.test=CC-DEVICE-FENCE',
    '-e',
    ['POSTGRES_PASSWORD', secret].join('='),
    '-p',
    '127.0.0.1::5432',
    qualification.image,
  );
  volume = docker(
    'inspect',
    '-f',
    '{{range .Mounts}}{{.Name}}{{end}}',
    container,
  );
  port = Number(docker('port', container, '5432/tcp').split(':').at(-1));
  admin = await connectAdmin();
  const credentials = Object.fromEntries([
    ['password', secret],
    ['migrationPassword', secret],
  ]);
  await provision(admin, {
    application: {
      database: 'cc-app',
      role: 'cc-app',
      migrationRole: 'cc-migrator',
      ...credentials,
    },
    kestra: { database: 'cc-kestra', role: 'cc-kestra', ...credentials },
  });
  await admin.end();
  migrator = await pool('cc-migrator', 'cc-app');
  await migrate(migrator, {
    runtimeRole: 'cc-app',
    migrations: await loadMigrations(),
  });
  runtime = await pool('cc-app', 'cc-app');

  mock = await startMock();
  mock.useInProcess();
  domain = await mock.createDomain({ tier: 'small', seed: 'device-fence' });
  const key = mock.credential(domain.customerId, scopes);
  credential = {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };
  reader = new GoogleDeviceReader();
  await migrator.query(
    `INSERT INTO cc.application_principals(id,issuer,subject,display_name)
     VALUES($1,$2,$3,'Device removal fence fixture')`,
    [randomUUID(), issuer, subject],
  );
  await migrator.query(
    `INSERT INTO cc.application_grants(principal_id,action,scope)
     SELECT id,'devices:read',jsonb_build_object('kind','district','customerId',$2::text)
     FROM cc.application_principals WHERE issuer=$1 AND subject=$3`,
    [issuer, domain.customerId, subject],
  );
  const credentialId = randomUUID();
  await migrator.query(
    `INSERT INTO cc.google_credentials(id,generation,customer_id,envelope,client_id,delegated_subject)
     VALUES($1,1,$2,$3,'1234567890',$4)`,
    [
      credentialId,
      domain.customerId,
      JSON.stringify({
        format: 1,
        keyId: 'fixture',
        iv: 'abcdefghijklmnop',
        tag: 'abcdefghijklmnopqrstuv',
        ciphertext: 'Zml4dHVyZQ',
      }),
      domain.adminEmail,
    ],
  );
  await migrator.query(
    `INSERT INTO cc.google_connection(customer_id,credential_id,generation,observation,observed_at,
       confirmed_by,encryption_key_id,active)
     SELECT $1,$2,1,$3,now(),id,'fixture',true FROM cc.application_principals
     WHERE issuer=$4 AND subject=$5`,
    [
      domain.customerId,
      credentialId,
      JSON.stringify({
        customerId: domain.customerId,
        primaryDomain: domain.primaryDomain,
        domains: [
          {
            name: domain.primaryDomain,
            primary: true,
            verified: true,
            aliases: [],
          },
        ],
      }),
      issuer,
      subject,
    ],
  );
});

after(async () => {
  await runtime?.end().catch(() => undefined);
  await migrator?.end().catch(() => undefined);
  await mock?.close().catch(() => undefined);
  if (container) docker('rm', '-f', container);
  if (volume) {
    try {
      docker('volume', 'rm', volume);
    } catch {
      /* The volume left with its container. */
    }
  }
});

async function principal() {
  const { rows } = await migrator.query(
    'SELECT id,permission_version FROM cc.application_principals WHERE issuer=$1 AND subject=$2',
    [issuer, subject],
  );
  return rows[0];
}

/** Run one full sync through the production worker. */
async function fullSync(syncReader = reader) {
  const actor = await principal();
  const syncId = randomUUID();
  await runtime.query(
    'SELECT cc.request_device_sync($1,$2,$3,1,$4,$5) AS result',
    [
      actor.id,
      actor.permission_version,
      domain.customerId,
      syncId,
      randomUUID(),
    ],
  );
  return new DeviceSync(runtime, cipher, syncReader, recordingCache(), {
    sleep: async () => undefined,
    backoff: () => 0,
  }).run(
    {
      customerId: domain.customerId,
      syncId,
      correlationId: randomUUID(),
    },
    AbortSignal.timeout(timeout),
  );
}

/** Run one refresh batch through the production worker. */
async function refresh(ids, batchReader, cacheImpl = recordingCache()) {
  const actor = await principal();
  const jobId = randomUUID();
  await runtime.query(
    'SELECT cc.create_entity_sync_job($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [
      actor.id,
      actor.permission_version,
      domain.customerId,
      'device',
      JSON.stringify(ids),
      1000,
      jobId,
      randomUUID(),
    ],
  );
  return new EntitySyncBatch(runtime, cipher, batchReader, cacheImpl, {
    sleep: async () => undefined,
    backoff: () => 0,
  }).run(
    {
      customerId: domain.customerId,
      jobId,
      batch: 0,
      correlationId: randomUUID(),
    },
    AbortSignal.timeout(timeout),
  );
}

async function stored(deviceId) {
  const { rows } = await runtime.query(
    `SELECT removed_at,last_entity_sync,annotated_location
     FROM cc.devices WHERE customer_id=$1 AND device_id=$2`,
    [domain.customerId, deviceId],
  );
  return rows[0];
}

async function presentDevices() {
  const { rows } = await runtime.query(
    `SELECT device_id FROM cc.devices WHERE customer_id=$1 AND removed_at IS NULL
     ORDER BY device_id`,
    [domain.customerId],
  );
  return rows.map((row) => row.device_id);
}

test('the full sync stores every mock device, and an ordinary refresh read keeps it', async () => {
  const state = await fullSync();
  assert.equal(state.failure, null);
  const devices = await presentDevices();
  assert.ok(devices.length > 1, 'the mock domain seeds more than one device');
  assert.equal(state.deviceCount, devices.length);
  const [deviceId] = devices;
  const cache = recordingCache();
  const refreshed = await refresh(
    [deviceId],
    answeringReader(() => true),
    cache,
  );
  assert.equal(refreshed.failure, null);
  assert.deepEqual(refreshed.updated, [deviceId]);
  assert.deepEqual(refreshed.removed, []);
  assert.equal((await stored(deviceId)).removed_at, null);
});

test('a held older refresh answer cannot clear a removal that a newer full sync made', async () => {
  assert.equal((await fullSync()).failure, null);
  const devices = await presentDevices();
  const deviceId = devices[0];
  // The refresh stamps its read before the Google call, then holds the answer it received.
  const entered = deferred();
  const release = deferred();
  const olderCache = recordingCache();
  const held = refresh([deviceId], holdingReader(entered, release), olderCache);
  await entered.promise;
  // A newer full sync enumerates no device, so the device is absent at a later observation.
  const removal = await fullSync(absentReader());
  assert.equal(removal.failure, null);
  const removedAt = (await stored(deviceId)).removed_at;
  assert.ok(
    removedAt instanceof Date,
    'the newer full sync marks the device removed',
  );
  // The held answer is older than that absence, so the store refuses the presence.
  release.resolve();
  const refused = await held;
  assert.equal(refused.failure, null);
  assert.deepEqual(
    refused.updated,
    [],
    'the older read stores no present device',
  );
  assert.deepEqual(refused.removed, []);
  assert.equal(
    (await stored(deviceId)).removed_at.toISOString(),
    removedAt.toISOString(),
    'the newer removal stays after the older answer lands',
  );
  assert.deepEqual(
    olderCache.calls.remove.flat(),
    [],
    'a refused presence owns no cache key',
  );
  const event = olderCache.calls.publish.find(
    (message) => message.type === 'entity-batch',
  );
  assert.deepEqual(event.deviceIds, []);
  assert.deepEqual(event.removedIds, []);

  // An ordinary later presence observation restores the device.
  const restored = await refresh(
    [deviceId],
    answeringReader(() => true),
  );
  assert.equal(restored.failure, null);
  assert.deepEqual(restored.updated, [deviceId]);
  assert.equal((await stored(deviceId)).removed_at, null);
});

test('a repeated 404 moves the tombstone, so a held presence answer that both absences predate cannot restore the device', async () => {
  assert.equal((await fullSync()).failure, null);
  const devices = await presentDevices();
  const deviceId = devices[0];
  const first = await refresh(
    [deviceId],
    answeringReader(() => false),
  );
  assert.equal(first.failure, null);
  assert.deepEqual(
    first.removed,
    [deviceId],
    'the first 404 removes the device',
  );
  const firstRemoval = (await stored(deviceId)).removed_at;
  assert.ok(firstRemoval instanceof Date);

  // A later successful refresh reads the device and holds its answer.
  const entered = deferred();
  const release = deferred();
  const held = refresh([deviceId], holdingReader(entered, release));
  await entered.promise;
  // A newer 404 answers while the presence read is held.
  const newer = await refresh(
    [deviceId],
    answeringReader(() => false),
  );
  assert.equal(newer.failure, null);
  assert.deepEqual(newer.removed, [deviceId]);
  const advanced = (await stored(deviceId)).removed_at;
  assert.ok(
    advanced > firstRemoval,
    'the repeated absence moves the tombstone forward',
  );
  release.resolve();
  const older = await held;
  assert.equal(older.failure, null);
  assert.deepEqual(
    older.updated,
    [],
    'the held presence read stores no device',
  );
  assert.equal(
    (await stored(deviceId)).removed_at.toISOString(),
    advanced.toISOString(),
    'the newest removal stays',
  );

  const restored = await refresh(
    [deviceId],
    answeringReader(() => true),
  );
  assert.equal(restored.failure, null);
  assert.deepEqual(restored.updated, [deviceId]);
  assert.equal((await stored(deviceId)).removed_at, null);
});

test('an older 404 that a newer presence read precedes reports no removal and evicts no cache key', async () => {
  assert.equal((await fullSync()).failure, null);
  const devices = await presentDevices();
  const deviceId = devices[0];
  const entered = deferred();
  const release = deferred();
  const olderCache = recordingCache();
  // The refresh reads a 404 and holds that answer.
  const held = refresh(
    [deviceId],
    {
      async deviceBatch() {
        const answer = { devices: [], missing: [deviceId] };
        entered.resolve();
        await release.promise;
        return answer;
      },
      async batteryBatch() {
        return [];
      },
    },
    olderCache,
  );
  await entered.promise;
  // A newer presence read commits first and stamps the row.
  const newer = await refresh(
    [deviceId],
    answeringReader(() => true),
  );
  assert.equal(newer.failure, null);
  assert.deepEqual(newer.updated, [deviceId]);
  release.resolve();
  const refused = await held;
  assert.equal(refused.failure, null);
  assert.deepEqual(refused.removed, [], 'the store refused the older removal');
  assert.equal(
    (await stored(deviceId)).removed_at,
    null,
    'the newer presence read keeps the device',
  );
  assert.deepEqual(
    olderCache.calls.remove.flat(),
    [],
    'a refused removal evicts no cache key',
  );
  const event = olderCache.calls.publish.find(
    (message) => message.type === 'entity-batch',
  );
  assert.deepEqual(event.removedIds, []);
});

test('an accepted write overlay stays through the removal fence, and the read and list controls still move and converge it', async () => {
  // A normal full sync lists every device with its inventory value.
  assert.equal((await fullSync()).failure, null);
  const deviceId = (await presentDevices())[0];
  const inventoryLocation = (await stored(deviceId)).annotated_location;
  assert.notEqual(
    inventoryLocation,
    'Room 12',
    'the accepted write differs from the inventory value',
  );
  // The accepted write overlays Room 12 until a list observation converges on the same value.
  const { rows } = await migrator.query(
    `SELECT job_id FROM cc.jobs WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [domain.customerId],
  );
  const writerJob = rows[0].job_id;
  await migrator.query(
    `INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,
       expires_at)
     VALUES($1,$2,'annotatedLocation','Room 12',clock_timestamp(),'write-response',$3,
       clock_timestamp()+interval '36 hours')`,
    [domain.customerId, deviceId, writerJob],
  );
  const overlay = async () =>
    (
      await runtime.query(
        `SELECT value,source,job_id FROM cc.device_write_overlays
         WHERE customer_id=$1 AND device_id=$2 AND field='annotatedLocation'`,
        [domain.customerId, deviceId],
      )
    ).rows[0];
  // A newer full sync removes the device. The removal leaves the accepted write alone.
  assert.equal((await fullSync(absentReader())).failure, null);
  assert.ok(
    (await stored(deviceId)).removed_at instanceof Date,
    'the newer full sync marks the device removed',
  );
  assert.equal(
    (await overlay())?.value,
    'Room 12',
    'the removal keeps the accepted write',
  );
  assert.equal(
    (await overlay())?.job_id,
    writerJob,
    'the overlay keeps the accepted job',
  );
  // A later presence read restores the device and moves the overlay to the observed value.
  const restored = await refresh(
    [deviceId],
    answeringReader(() => true),
  );
  assert.equal(restored.failure, null);
  assert.deepEqual(restored.updated, [deviceId]);
  assert.equal((await stored(deviceId)).removed_at, null);
  const moved = await overlay();
  assert.equal(moved?.value, inventoryLocation, 'the read moves the overlay');
  assert.equal(moved?.source, 'refresh-read');
  assert.equal(moved?.job_id, writerJob, 'the move keeps the accepted job');
  // A list observation that answers the overlay value converges it.
  assert.equal((await fullSync()).failure, null);
  assert.equal(await overlay(), undefined, 'the list converges the overlay');
  assert.equal(
    (await stored(deviceId)).annotated_location,
    inventoryLocation,
    'the list stores the inventory value',
  );
});
