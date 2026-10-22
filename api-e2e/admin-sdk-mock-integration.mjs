import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { MOCK_SCOPES, mockExitedError } from './admin-sdk-mock-fixture.mjs';
import { GOOGLE_SETUP_SCOPES } from '../libs/application-contracts/src/lib/google-capabilities.ts';
import { qualifyDeviceWritesOnMock } from './device-write-mock.mjs';
import {
  DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
  deviceWriteAccessMessage,
} from '../libs/application-contracts/src/lib/device-write-access-message.ts';

/** Google battery health values as Campus Commander classifies them. */
const batteryHealth = {
  BATTERY_HEALTH_NORMAL: 'normal',
  BATTERY_REPLACE_SOON: 'replace-soon',
  BATTERY_REPLACE_NOW: 'replace-now',
};
/** The mock reports at most this many rows per query in this flow. */
const queryLimit = 100;

/** The full sync timeout. The scale run records an unfinished sync as a finding. */
function syncTimeoutMs() {
  const seconds = Number(process.env.CC_MOCK_SYNC_TIMEOUT_SECONDS ?? 3600);
  assert.ok(
    Number.isFinite(seconds) && seconds > 0,
    'CC_MOCK_SYNC_TIMEOUT_SECONDS must be a positive number of seconds.',
  );
  return seconds * 1000;
}

/**
 * Call one Google hostname through the mock's published Google port.
 *
 * The container network aliases carry the names inside the harness network. From the
 * harness, the request dials loopback and keeps the hostname for TLS and routing.
 */
function mockGoogle({ mock, host, path, token }) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host,
        port: mock.googlePort,
        path,
        method: 'GET',
        ca: mock.ca,
        servername: host,
        lookup: (_name, _options, done) =>
          done(null, [{ address: '127.0.0.1', family: 4 }]),
        headers: {
          host,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        timeout: 20000,
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, text }),
        );
      },
    );
    request.on('error', reject);
    request.on('timeout', () =>
      request.destroy(new Error('The mock Google request timed out.')),
    );
    request.end();
  });
}

/** Mint an access token for the mock's administrator through the control API. */
async function mockToken(mock, scope) {
  const response = await fetch(
    `${mock.controlUrl}/domains/${mock.customerId}/tokens`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: mock.adminEmail, scopes: [scope] }),
    },
  );
  assert.equal(
    response.status,
    200,
    `The mock token request answered ${response.status}.`,
  );
  return (await response.json()).access_token;
}

/** The device telemetry the mock holds, read back over its Google surface. */
async function readMockTelemetry(mock, deviceId, scope) {
  const token = await mockToken(mock, scope);
  const host = 'chromemanagement.googleapis.com';
  const response = await mockGoogle({
    mock,
    host,
    path: `/v1/customers/${mock.customerId}/telemetry/devices/${encodeURIComponent(deviceId)}?readMask=deviceId,batteryInfo,batteryStatusReport`,
    token,
  });
  if (response.status === 404) return null;
  assert.equal(
    response.status,
    200,
    `The mock telemetry read answered ${response.status}: ${response.text}`,
  );
  return JSON.parse(response.text);
}

/** Every device the mock holds, read back over its Google surface. */
async function readMockDevices(mock) {
  const token = await mockToken(
    mock,
    'https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly',
  );
  const devices = [];
  let pageToken = '';
  for (;;) {
    const response = await mockGoogle({
      mock,
      host: 'admin.googleapis.com',
      path: `/admin/directory/v1/customer/${mock.customerId}/devices/chromeos?maxResults=300&projection=FULL${
        pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
      }`,
      token,
    });
    assert.equal(
      response.status,
      200,
      `The mock device list answered ${response.status}: ${response.text}`,
    );
    const body = JSON.parse(response.text);
    devices.push(...(body.chromeosdevices ?? []));
    if (!body.nextPageToken) return devices;
    pageToken = body.nextPageToken;
  }
}

/**
 * The battery class and capacity that Campus Commander derives from one telemetry
 * device: the newest report that names a known health value wins.
 * `libs/google-connection/src/lib/devices.ts` holds the same rule.
 */
export function expectedBattery(telemetry) {
  const design = Number(telemetry.batteryInfo?.[0]?.designCapacity);
  const reports = (telemetry.batteryStatusReport ?? [])
    .map((report) => ({
      reportedAt: new Date(report.reportTime).toISOString(),
      health: batteryHealth[report.batteryHealth] ?? null,
      capacityPercent:
        Number.isFinite(design) && design > 0
          ? Math.min(
              200,
              Math.round((Number(report.fullChargeCapacity) * 100) / design),
            )
          : null,
    }))
    .sort(
      (left, right) =>
        Date.parse(right.reportedAt) - Date.parse(left.reportedAt),
    );
  return reports.find((report) => report.health !== null) ?? null;
}

/** Sign in as the review administrator through the simulated provider. */
async function reviewSignIn({ request, ca, publicOrigin }) {
  const start = await request(`${publicOrigin}/api/auth/login`, { ca });
  assert.equal(start.status, 303, start.text);
  const cookie = start.headers['set-cookie'][0].split(';')[0];
  const authorize = new URL(start.headers.location);
  authorize.searchParams.set('review_identity', 'administrator');
  const granted = await request(authorize, { ca });
  assert.equal(granted.status, 303, granted.text);
  const finish = await request(new URL(granted.headers.location), {
    ca,
    cookie,
  });
  assert.equal(finish.status, 303, finish.text);
  const sessionCookie = finish.headers['set-cookie']
    ?.find((entry) => entry.startsWith('__Host-cc-session='))
    ?.split(';')[0];
  assert.ok(
    sessionCookie,
    `The review sign-in returned no session: ${finish.status} ${String(finish.headers.location)}`,
  );
  return sessionCookie;
}

/**
 * B6 C4: run the real scoped client and the real write-access check against the
 * mock, with a recording transport at the provider request bound. The probe
 * asserts the issued scope set and every Directory request.
 */
async function qualifyWriteAccessProvider(mock) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      './libs/application-contracts/test-register.mjs',
      'api-e2e/device-write-access-provider-probe.mjs',
    ],
    {
      cwd: process.cwd(),
      timeout: 120_000,
      env: {
        ...process.env,
        CC_PROBE_CA: mock.caFile,
        CC_PROBE_PORT: String(mock.googlePort),
        CC_PROBE_CUSTOMER: mock.customerId,
        CC_PROBE_KEY: mock.keyFile,
        CC_PROBE_SUBJECT: mock.adminEmail,
      },
    },
  );
  const trace = JSON.parse(stdout.trim().split('\n').at(-1));
  await mkdir('dist/client-review', { recursive: true });
  await writeFile(
    'dist/client-review/device-write-access-provider-trace.json',
    `${JSON.stringify(trace, null, 2)}\n`,
    { mode: 0o600 },
  );
  return trace;
}

/**
 * Drive the review environment through the same API endpoints as the UI:
 * connect the mock credential, run Refresh all, and check the published devices
 * against the mock's own count and telemetry.
 *
 * Every failure path consults the mock watch before the caller tears the
 * environment down. A stopped mock explains the run, whatever request failed
 * first, so a request error never hides the container log.
 */
export async function qualifyAdminSdkMockIntegration(options) {
  const { watch } = options;
  try {
    return await runAdminSdkMockIntegration(options);
  } catch (error) {
    const log = watch?.exitedLog?.() ?? null;
    throw log === null ? error : mockExitedError(log, error);
  }
}

async function runAdminSdkMockIntegration({
  mock,
  watch,
  request,
  ca,
  publicOrigin,
  redis,
  customer,
  migrator,
  kestra,
  docker,
  restartApi,
  restartWorker,
  redisName,
  connectRedis,
  restartRedis,
  baseCommit,
}) {
  // Every step below depends on the running mock. A stopped container fails
  // this flow with the mock log instead of a later connection error.
  const check = () => watch?.assertRunning();
  check();
  let cookie = await reviewSignIn({ request, ca, publicOrigin });
  // The idle window slides on every request. An expired session signs in again.
  const session = async () => {
    check();
    const response = await request(`${publicOrigin}/api/auth/session`, {
      ca,
      cookie,
    });
    if (response.status === 401) {
      cookie = await reviewSignIn({ request, ca, publicOrigin });
      return JSON.parse(
        (await request(`${publicOrigin}/api/auth/session`, { ca, cookie }))
          .text,
      );
    }
    assert.equal(response.status, 200, response.text);
    return JSON.parse(response.text);
  };
  let active = await session();
  const headers = () => ({
    origin: publicOrigin,
    'x-csrf-token': active.csrfToken,
  });
  // Every call carries the session cookie.
  const call = async (path, options = {}) => {
    check();
    return request(`${publicOrigin}${path}`, { ca, cookie, ...options });
  };

  const staged = await call('/api/google-connection/candidates', {
    method: 'POST',
    headers: headers(),
    body: {
      id: randomUUID(),
      clientId: mock.key.client_id,
      subject: mock.adminEmail,
      serviceAccount: mock.key,
    },
  });
  assert.equal(staged.status, 201, staged.text);
  const candidate = JSON.parse(staged.text);
  assert.equal(candidate.status, 'ready');
  assert.equal(candidate.observation.customerId, mock.customerId);
  const confirmed = await call(
    `/api/google-connection/candidates/${candidate.id}/confirm`,
    {
      method: 'POST',
      headers: headers(),
      body: { customerId: mock.customerId, confirmed: true },
    },
  );
  assert.ok([200, 201].includes(confirmed.status), confirmed.text);
  const connection = JSON.parse(
    (await call('/api/google-connection')).text,
  ).connection;
  assert.equal(connection.customerId, mock.customerId);
  assert.equal(
    (await call('/api/google-connection')).text.includes(mock.key.private_key),
    false,
  );

  const startedAt = Date.now();
  const started = await call('/api/devices/sync', {
    method: 'POST',
    headers: headers(),
    body: {},
  });
  assert.ok([200, 201].includes(started.status), started.text);
  const deadline = startedAt + syncTimeoutMs();
  let state;
  for (;;) {
    const response = await call('/api/devices/sync');
    if (response.status === 401) {
      // The idle window slides on every request. A restart re-signs in.
      cookie = await reviewSignIn({ request, ca, publicOrigin });
      active = await session();
      continue;
    }
    assert.equal(response.status, 200, response.text);
    state = JSON.parse(response.text).sync;
    if (state.status !== 'running') break;
    assert.ok(
      Date.now() < deadline,
      `The full sync did not settle within ${syncTimeoutMs() / 1000} seconds.`,
    );
    await delay(2000);
  }
  const syncSeconds = (Date.now() - startedAt) / 1000;
  assert.equal(state.status, 'ready', JSON.stringify(state));
  assert.equal(state.telemetryFailure, null);

  const counts = await mock.counts();
  assert.equal(state.deviceCount, counts.devices);
  const page = JSON.parse(
    (
      await call('/api/devices/query', {
        method: 'POST',
        headers: headers(),
        body: { limit: queryLimit },
      })
    ).text,
  ).page;
  assert.equal(page.total, counts.devices);
  assert.equal(page.matching, counts.devices);

  // U1: the sync stores the annotated user that the mock seeds.
  const seeded = await readMockDevices(mock);
  const withUser = seeded.find((device) => device.annotatedUser);
  const withoutUser = seeded.find((device) => !device.annotatedUser);
  assert.ok(withUser, 'The mock seed annotates one device with a user.');
  assert.ok(
    withoutUser,
    'The mock seed leaves one device without an annotated user.',
  );
  const withUserRecord = JSON.parse(
    (await call(`/api/devices/${withUser.deviceId}`)).text,
  ).device;
  assert.equal(withUserRecord.annotatedUser, withUser.annotatedUser);
  const withoutUserRecord = JSON.parse(
    (await call(`/api/devices/${withoutUser.deviceId}`)).text,
  ).device;
  assert.equal(withoutUserRecord.annotatedUser, null);
  const userPage = JSON.parse(
    (
      await call('/api/devices/query', {
        method: 'POST',
        headers: headers(),
        body: {
          predicates: [
            {
              field: 'annotatedUser',
              operator: 'equals',
              value: withUser.annotatedUser,
            },
          ],
          limit: queryLimit,
        },
      })
    ).text,
  ).page;
  const expectedUsers = (
    await migrator.query(
      'SELECT device_id FROM cc.devices WHERE customer_id=$1 AND removed_at IS NULL AND lower(annotated_user)=lower($2) ORDER BY device_id',
      [mock.customerId, withUser.annotatedUser],
    )
  ).rows.map((row) => row.device_id);
  assert.ok(
    expectedUsers.includes(withUser.deviceId),
    'The stored row holds the seeded annotated user.',
  );
  assert.deepEqual(
    userPage.rows.map((row) => row.deviceId),
    expectedUsers,
    'The annotated-user text filter returns the seeded device.',
  );
  assert.equal(userPage.matching, expectedUsers.length);
  assert.equal(userPage.rows[0].annotatedUser, withUser.annotatedUser);
  const sortedPage = JSON.parse(
    (
      await call('/api/devices/query', {
        method: 'POST',
        headers: headers(),
        body: {
          sort: { field: 'annotatedUser', direction: 'asc' },
          limit: 1000,
        },
      })
    ).text,
  ).page;
  const expectedOrder = (
    await migrator.query(
      'SELECT device_id FROM cc.devices WHERE customer_id=$1 AND removed_at IS NULL ORDER BY annotated_user ASC NULLS LAST,device_id ASC',
      [mock.customerId],
    )
  ).rows.map((row) => row.device_id);
  assert.equal(sortedPage.rows.length, counts.devices);
  assert.deepEqual(
    sortedPage.rows.map((row) => row.deviceId),
    expectedOrder,
    'The annotated-user sort returns every device in the column order.',
  );
  assert.ok(
    sortedPage.rows.some((row) => row.deviceId === withUser.deviceId),
    'The annotated-user sort returns the seeded device.',
  );
  assert.equal(
    sortedPage.rows.at(-1).annotatedUser,
    null,
    'The annotated-user sort places a device without the value last.',
  );

  let compared = null;
  for (const row of page.rows.filter(
    (entry) => entry.battery.status === 'reported',
  )) {
    const telemetry = await readMockTelemetry(
      mock,
      row.deviceId,
      'https://www.googleapis.com/auth/chrome.management.telemetry.readonly',
    );
    const expected = telemetry ? expectedBattery(telemetry) : null;
    if (!expected) continue;
    const detail = JSON.parse(
      (await call(`/api/devices/${row.deviceId}`)).text,
    ).device;
    assert.equal(detail.battery.status, 'reported');
    assert.equal(detail.battery.health, expected.health);
    assert.equal(detail.battery.capacityPercent, expected.capacityPercent);
    assert.equal(
      Date.parse(detail.battery.reportedAt),
      Date.parse(expected.reportedAt),
    );
    compared = {
      deviceId: row.deviceId,
      health: expected.health,
      capacityPercent: expected.capacityPercent,
      reportedAt: expected.reportedAt,
    };
    break;
  }
  assert.ok(compared, 'No synced device matched the mock battery telemetry.');

  // B6: the write scope, its check, and the write-access projection.
  // Every Google call in this block goes to the mock. The scope removal, the
  // delegation grant, and the list fault use the mock control API.
  const writeScope =
    'https://www.googleapis.com/auth/admin.directory.device.chromeos';
  const control = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${mock.controlUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    assert.ok(
      [200, 201, 204].includes(response.status),
      `The mock control API answered ${response.status} for ${path}.`,
    );
    return response.status === 204 ? null : response.json();
  };
  const clearFaults = () =>
    control(`/domains/${mock.customerId}/faults`, { method: 'DELETE' });
  const addFault = (rule) =>
    control(`/domains/${mock.customerId}/faults`, {
      method: 'POST',
      body: rule,
    });
  const writeAccess = async () => {
    const response = await call('/api/devices/updates/access');
    assert.equal(response.status, 200, response.text);
    return JSON.parse(response.text);
  };
  // The check holds a 30-second interval per customer and generation. Each
  // unrelated assertion clears that key so the next check runs. The application
  // Redis user cannot list keys, so build the small known key set instead.
  const clearBusy = async () => {
    const keys = [];
    for (let generation = 1; generation <= 8; generation += 1)
      keys.push(`cc:device-write-access-busy:${customer}:${generation}`);
    await redis.del(keys);
  };
  const postCheck = () =>
    call('/api/devices/updates/access/check', {
      method: 'POST',
      headers: headers(),
      body: {},
    });
  const checkWriteAccess = async () => {
    await clearBusy();
    const response = await postCheck();
    assert.ok([200, 201].includes(response.status), response.text);
    return JSON.parse(response.text);
  };
  assert.equal(
    GOOGLE_SETUP_SCOPES.includes(writeScope),
    true,
    'The setup scopes include the write scope.',
  );
  assert.equal(
    MOCK_SCOPES.includes(writeScope),
    true,
    'The mock grants the write scope to the delegation client.',
  );

  await clearFaults();
  assert.deepEqual(
    await writeAccess(),
    { state: 'unchecked', scope: null, failure: null, checkedAt: null },
    'write access starts unchecked without a check',
  );
  const granted = await checkWriteAccess();
  assert.equal(
    granted.state,
    'granted',
    `the write scope check grants access: ${JSON.stringify(granted)}`,
  );
  assert.equal(granted.scope, writeScope, 'the check names the write scope');
  assert.equal(granted.failure, null, 'a granted check carries no failure');
  assert.ok(
    Number.isFinite(Date.parse(granted.checkedAt)),
    'a granted check records its time',
  );
  // C7: the check holds one interval per customer and generation.
  const repeat = await postCheck();
  assert.equal(
    repeat.status,
    429,
    `a second check inside the interval answers 429: ${repeat.text}`,
  );
  assert.equal(
    JSON.parse(repeat.text).reason,
    'busy',
    'a busy check answers the busy route reason',
  );
  assert.deepEqual(
    await writeAccess(),
    granted,
    'GET answers the cached check',
  );

  // The mock keeps a remaining count for each fault. A patch fault that still
  // waits after the check proves that the check sent no write.
  const patchFault = await addFault({
    kind: 'status',
    method: 'directory.chromeosdevices.patch',
    status: 500,
    reason: 'backendError',
    count: 1,
  });
  assert.equal(
    (await checkWriteAccess()).state,
    'granted',
    'the check grants access while a patch fault waits',
  );
  const waiting = (await control(`/domains/${mock.customerId}/faults`)).find(
    (fault) => fault.id === patchFault.id,
  );
  assert.equal(
    waiting.remaining,
    1,
    'the check sends no write, so the patch fault never runs',
  );
  await clearFaults();

  // Removing the write scope denies the check and the cached projection.
  await addFault({
    kind: 'remove-scope',
    clientId: mock.key.client_id,
    scope: writeScope,
  });
  const denied = await checkWriteAccess();
  assert.equal(
    denied.state,
    'denied',
    `removing the write scope denies access: ${JSON.stringify(denied)}`,
  );
  assert.equal(
    denied.failure,
    'delegation-not-authorized',
    'a removed write scope reports delegation-not-authorized',
  );
  const deniedRead = await writeAccess();
  assert.equal(
    deniedRead.state,
    'denied',
    'GET answers the denied state after the scope removal',
  );
  assert.equal(
    deniedRead.failure,
    'delegation-not-authorized',
    'GET answers the denied failure after the scope removal',
  );
  assert.equal(
    deviceWriteAccessMessage(deniedRead),
    DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
    'GET carries the exact scope-named denied message',
  );

  // A delegation grant through the mock control restores granted.
  await clearFaults();
  await control(
    `/domains/${mock.customerId}/delegation/${mock.key.client_id}`,
    {
      method: 'PUT',
      body: { scopes: MOCK_SCOPES },
    },
  );
  assert.equal(
    (await checkWriteAccess()).state,
    'granted',
    'a delegation grant through the mock control restores granted',
  );

  // A revoked delegation denies the check.
  await addFault({
    kind: 'revoke-delegation',
    clientId: mock.key.client_id,
  });
  const revoked = await checkWriteAccess();
  assert.equal(
    revoked.state,
    'denied',
    `a revoked delegation denies access: ${JSON.stringify(revoked)}`,
  );
  assert.equal(
    revoked.failure,
    'delegation-not-authorized',
    'a revoked delegation reports delegation-not-authorized',
  );
  await clearFaults();
  assert.equal(
    (await checkWriteAccess()).state,
    'granted',
    'clearing the revocation grants access again',
  );

  // A 403 on the list is unavailable, never denied.
  await addFault({
    kind: 'status',
    method: 'directory.chromeosdevices.list',
    status: 403,
    reason: 'forbidden',
    count: 1,
  });
  const forbidden = await checkWriteAccess();
  assert.equal(
    forbidden.state,
    'unavailable',
    `a 403 on the list reads unavailable: ${JSON.stringify(forbidden)}`,
  );
  assert.equal(
    forbidden.failure,
    'permission-denied',
    'a 403 on the list reports permission-denied',
  );
  await clearFaults();
  assert.equal(
    (await checkWriteAccess()).state,
    'granted',
    'the check recovers after the list fault clears',
  );

  // C4: the real scoped client records one write-scope token, one
  // introspection, and one Directory GET with maxResults=1 against the mock.
  const providerTrace = await qualifyWriteAccessProvider(mock);
  assert.equal(
    providerTrace.result.state,
    'granted',
    'the provider probe grants the write scope',
  );

  // Refresh Selected re-reads the selected devices through the get-by-IDs pipeline.
  const refreshResults = [];
  {
    const chosen = page.rows.slice(0, 3).map((row) => row.deviceId);
    assert.equal(chosen.length, 3, 'The grid holds three devices to refresh.');
    const tabId = randomUUID();
    const key = { gridId: 'devices', tabId };
    const changed = await call('/api/devices/selection/ops', {
      method: 'POST',
      headers: headers(),
      body: { ...key, ops: [{ op: 'select', ids: chosen }] },
    });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(
      JSON.parse(changed.text).selection.selectedCount,
      3,
      'The stored selection holds three devices.',
    );
    const subscriber = redis.duplicate();
    const events = [];
    subscriber.on('error', () => undefined);
    await subscriber.connect();
    await subscriber.subscribe(
      `cc:entity-events:${mock.customerId}`,
      (message) => {
        try {
          events.push(JSON.parse(message));
        } catch {
          /* The assertion below reports a malformed message. */
        }
      },
    );
    try {
      const refreshed = await call('/api/devices/selection/refresh', {
        method: 'POST',
        headers: headers(),
        body: key,
      });
      assert.equal(refreshed.status, 201, refreshed.text);
      const answer = JSON.parse(refreshed.text).refresh;
      assert.equal(answer.selected, 3);
      assert.ok(answer.jobId, 'Refresh Selected starts one job.');
      const deadline = Date.now() + 60_000;
      let batch;
      for (;;) {
        batch = events.find(
          (event) =>
            event.type === 'entity-batch' && event.jobId === answer.jobId,
        );
        if (batch) break;
        assert.ok(
          Date.now() < deadline,
          `Refresh Selected published no entity-batch for three devices: ${JSON.stringify(events)}`,
        );
        await delay(500);
      }
      assert.deepEqual([...batch.deviceIds].sort(), [...chosen].sort());
      let job;
      const jobDeadline = Date.now() + 60_000;
      for (;;) {
        const listed = await call(
          '/api/jobs?action=refresh-inventory&limit=100',
        );
        assert.equal(listed.status, 200, listed.text);
        job = JSON.parse(listed.text).jobs.find(
          (entry) => entry.jobId === answer.jobId,
        );
        if (job?.status === 'completed') break;
        assert.ok(
          Date.now() < jobDeadline,
          `The Refresh Selected job did not complete: ${JSON.stringify(job)}`,
        );
        await delay(500);
      }
      assert.match(job.displayId, /^REF-\d{3,}$/);
      assert.deepEqual(job.scope, { kind: 'devices', deviceCount: 3 });
      refreshResults.push(
        'Refresh Selected publishes an entity-batch for three devices and the Jobs list shows a completed REF job with three devices: pass',
      );
    } finally {
      await subscriber.unsubscribe(`cc:entity-events:${mock.customerId}`);
      await subscriber.quit();
    }
  }

  // Refresh Domain reads the domain details again, then runs the full device sync.
  {
    const before = JSON.parse(
      (await call('/api/google-connection')).text,
    ).connection;
    assert.ok(
      before?.observedAt,
      'The connection records an observation time before Refresh Domain.',
    );
    const refreshed = await call('/api/devices/domain/refresh', {
      method: 'POST',
      headers: headers(),
      body: {},
    });
    assert.equal(refreshed.status, 201, refreshed.text);
    const answer = JSON.parse(refreshed.text).refresh;
    assert.deepEqual(answer.domain, { status: 'refreshed', reason: null });
    assert.equal(answer.sync.status, 'running');
    const after = JSON.parse(
      (await call('/api/google-connection')).text,
    ).connection;
    assert.ok(
      Date.parse(after.observedAt) > Date.parse(before.observedAt),
      'Refresh Domain records a newer observation time.',
    );
    const deadline = Date.now() + syncTimeoutMs();
    let domainState;
    for (;;) {
      const response = await call('/api/devices/sync');
      assert.equal(response.status, 200, response.text);
      domainState = JSON.parse(response.text).sync;
      if (domainState.status !== 'running') break;
      assert.ok(
        Date.now() < deadline,
        `The Refresh Domain sync did not settle within ${syncTimeoutMs() / 1000} seconds.`,
      );
      await delay(2000);
    }
    assert.equal(domainState.status, 'ready', JSON.stringify(domainState));
    refreshResults.push(
      'Refresh Domain answers refreshed, records a newer observation time, and the full sync ends ready: pass',
    );
  }

  const quota = await mock.quota();
  const record = {
    tier: mock.tier,
    delays: mock.delays,
    devices: state.deviceCount,
    syncSeconds,
    battery: compared,
    quota,
  };
  await mkdir('dist/client-review', { recursive: true });
  await writeFile(
    'dist/client-review/admin-sdk-mock-run.json',
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    `Admin SDK mock run: tier ${mock.tier}, ${state.deviceCount} devices, sync ${syncSeconds.toFixed(1)} s\n`,
  );
  process.stdout.write(
    `Mock battery for ${compared.deviceId}: ${compared.health} at ${compared.capacityPercent} percent of design capacity\n`,
  );
  process.stdout.write(
    `Mock quota buckets after the sync: ${JSON.stringify(quota.buckets.map(({ api, projectId, subject, snapshot }) => ({ api, projectId, subject, count: snapshot.count, limit: snapshot.limit })))}\n`,
  );
  const writeResults = await qualifyDeviceWritesOnMock({
    migrator,
    mock,
    kestra,
    customer,
    call,
    headers,
    redis,
    writeScope,
    session,
  });
  // Q1b: the adversarial attacks run after the P2 checks in the same fresh installation.
  if (process.env.CC_Q1_ATTACKS === '1') {
    const { runDeviceWriteAttacks } = await import(
      './device-write-attacks.mjs'
    );
    const summary = await runDeviceWriteAttacks({
      docker,
      mock,
      kestra,
      migrator,
      redis,
      request,
      ca,
      publicOrigin,
      customer,
      restartApi,
      restartWorker,
      redisName,
      kestraName: kestra.kestraName,
      workerName: kestra.workerName,
      connectRedis,
      restartRedis,
      baseCommit,
    });
    const failed = summary.results.filter((result) => result.status === 'fail');
    const unverified = summary.results.filter(
      (result) => result.status === 'unverified',
    );
    const observed = summary.results.filter(
      (result) => result.status === 'observed',
    );
    writeResults.push(
      `Q1b attacks: ${summary.results.length} ran, ${failed.length} with a failed check${
        failed.length === 0
          ? ''
          : ` (${failed.map((result) => result.id).join(', ')})`
      }, ${unverified.length} with no check${
        unverified.length === 0
          ? ''
          : ` (${unverified.map((result) => result.id).join(', ')})`
      }, ${observed.length} observations only${
        observed.length === 0
          ? ''
          : ` (${observed.map((result) => result.id).join(', ')})`
      }: ${failed.length === 0 ? 'pass' : 'fail'}`,
    );
    // R2: a genuine failed check must fail the test. The complete result record
    // stays in dist/q1b/attacks.json, and the ruling-authorized S8 and S9
    // outcomes are classified by the results themselves: S8 carries its revised
    // end state, and S9's closed window reads unverified, which is not a fail.
    if (failed.length > 0) {
      const detail = failed
        .map((result) => {
          const labels = result.checks
            .filter((check) => !check.pass)
            .map((check) => check.label);
          return `${result.id}: ${labels.join('; ')}`;
        })
        .join(' | ');
      const ids = failed.map((result) => result.id).join(', ');
      throw new Error(
        `Q1b attacks reported failed checks (${ids}): ${detail}. The complete record is dist/q1b/attacks.json.`,
      );
    }
  }
  return [
    `the mock credential connects with the mock administrator and customer ${mock.customerId}: pass`,
    `Refresh all publishes ${state.deviceCount} devices in ${syncSeconds.toFixed(1)} seconds: pass`,
    `the published count equals the mock count and a device battery class matches the mock telemetry: pass`,
    'the write scope check lists one device for the mock administrator and sends no write: pass',
    'the provider probe mints one write-scope token and sends one GET with maxResults=1 to the mock: pass',
    'removing the write scope denies access, and a delegation grant through the mock control restores granted: pass',
    'a revoked delegation denies access, and a 403 on the list reads unavailable with permission-denied: pass',
    ...refreshResults,
    ...writeResults,
  ];
}
