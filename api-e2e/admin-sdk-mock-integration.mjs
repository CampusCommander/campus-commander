import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { MOCK_SCOPES, mockExitedError } from './admin-sdk-mock-fixture.mjs';

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
  const checkWriteAccess = async () => {
    const response = await call('/api/devices/updates/access/check', {
      method: 'POST',
      headers: headers(),
      body: {},
    });
    assert.ok([200, 201].includes(response.status), response.text);
    return JSON.parse(response.text);
  };

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
  return [
    `the mock credential connects with the mock administrator and customer ${mock.customerId}: pass`,
    `Refresh all publishes ${state.deviceCount} devices in ${syncSeconds.toFixed(1)} seconds: pass`,
    `the published count equals the mock count and a device battery class matches the mock telemetry: pass`,
    'the write scope check lists one device for the mock administrator and sends no write: pass',
    'removing the write scope denies access, and a delegation grant through the mock control restores granted: pass',
    'a revoked delegation denies access, and a 403 on the list reads unavailable with permission-denied: pass',
  ];
}
