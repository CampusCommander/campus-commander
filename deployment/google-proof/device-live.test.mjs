/**
 * Transport regression coverage for the device live check.
 * The first version of the check wrote an assumed HTTP 200 and counted pages as requests.
 * These tests drive the production readers with synthetic transport answers.
 * The check must record what the transport answered.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JWT, OAuth2Client } from 'google-auth-library';
import '../../libs/application-contracts/test-register.mjs';

const { runCheck } = await import('./device-live.mjs');
const { GoogleDeviceReader } = await import('@campus/google-connection');

const credential = {
  subject: 'fixture@example.invalid',
  serviceAccount: {
    client_email: 'fixture@project.iam.gserviceaccount.com',
    private_key: 'synthetic-private-key',
    private_key_id: 'fixture',
  },
};
const deviceListUrl =
  /^https:\/\/admin\.googleapis\.com\/admin\/directory\/v1\/customer\/[^/]+\/devices\/chromeos$/;
const telemetryListUrl =
  /^https:\/\/chromemanagement\.googleapis\.com\/v1\/customers\/[^/]+\/telemetry\/devices$/;
const batchUrl = 'https://www.googleapis.com/batch/admin/directory_v1';
const batchBoundary = 'batch_reply';
/** One multipart answer. The outer POST answers 200. The single GET part answers 404. */
const batchReply = [
  `--${batchBoundary}`,
  'Content-Type: application/http',
  'Content-ID: <response-cc-1>',
  '',
  'HTTP/1.1 404 Not Found',
  'Content-Type: application/json',
  '',
  '{"error":{"code":404,"errors":[{"reason":"notFound"}]}}',
  '',
  `--${batchBoundary}--`,
  '',
].join('\r\n');

function httpError(status, reason) {
  const error = new Error(`HTTP ${status}`);
  error.response = { status, data: { error: { errors: [{ reason }] } } };
  return error;
}

/** Answer every reader call from one table. The table sees the URL and may throw. */
function transport(t, answer) {
  const urls = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    return { token: 'fixture-token' };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async function () {
    return { scopes: [...this.scopes], expiry_date: Date.now() + 3_500_000 };
  });
  t.mock.method(OAuth2Client.prototype, 'request', async function (options) {
    urls.push(options.url);
    const value = answer(options.url);
    if (value instanceof Error) throw value;
    return value;
  });
  return urls;
}

const answerFor = (url) => {
  if (url === batchUrl)
    return {
      status: 200,
      headers: { 'content-type': `multipart/mixed; boundary=${batchBoundary}` },
      data: batchReply,
    };
  if (telemetryListUrl.test(url)) return { status: 200, data: { devices: [] } };
  if (deviceListUrl.test(url))
    return { status: 200, data: { chromeosdevices: [] } };
  // The telemetry read for the missing device answers 404. The reader maps it to no-report.
  throw httpError(404, 'notFound');
};

/** The reader with a retry wait that does not slow the test. */
function fastReader() {
  return new GoogleDeviceReader({ sleep: async () => {}, backoff: () => 1 });
}

async function run(t, reader) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-device-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'evidence.json');
  const evidence = await runCheck(credential, { output, reader });
  return { evidence, written: JSON.parse(await readFile(output, 'utf8')) };
}

const methodOf = (evidence, name) => {
  const found = evidence.methods.find((item) => item.name.endsWith(name));
  assert.ok(found, `the evidence holds a ${name} entry`);
  return found;
};

test('the check records the observed 404 of the telemetry probe, not an assumed 200', async (t) => {
  transport(t, answerFor);
  const { evidence, written } = await run(t);

  assert.equal(evidence.status, 'passed');
  assert.deepEqual(written, evidence);
  assert.equal(methodOf(evidence, 'devicePages').httpStatus, 200);
  assert.equal(methodOf(evidence, 'batteryPages').httpStatus, 200);
  assert.equal(methodOf(evidence, 'deviceBatch').httpStatus, 200);
  assert.deepEqual(methodOf(evidence, 'deviceBatch').partStatuses, [404]);
  assert.equal(methodOf(evidence, 'batteryBatch').httpStatus, 404);
  assert.deepEqual(methodOf(evidence, 'batteryBatch').statuses, [404]);
  assert.deepEqual(evidence.probes, {
    deviceBatch: { classification: 'not-found', missing: 1, devices: 0 },
    batteryBatch: { classification: 'no-report', observations: 1 },
  });
  assert.ok(!JSON.stringify(evidence).includes('fixture-token'));
});

test('the check counts a reader-owned quota retry as a second request', async (t) => {
  let deviceReads = 0;
  transport(t, (url) => {
    if (deviceListUrl.test(url)) {
      deviceReads += 1;
      if (deviceReads === 1) throw httpError(429, 'rateLimitExceeded');
    }
    return answerFor(url);
  });
  const { evidence } = await run(t, fastReader());

  assert.equal(evidence.status, 'passed');
  assert.equal(deviceReads, 2);
  const pages = methodOf(evidence, 'devicePages');
  assert.equal(pages.requests, 2);
  assert.deepEqual(pages.statuses, [429, 200]);
  assert.equal(pages.httpStatus, 200);
  assert.equal(pages.pages, 1);
  assert.equal(methodOf(evidence, 'batteryPages').requests, 1);
});