/**
 * A Disable job and a Deprovision job against admin-sdk-mock v0.2.0 (addendum section 5).
 * The mock answers the batch endpoint in process. No live Google call runs here.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { JWT } from 'google-auth-library';
import { startMock } from '@campuscommander/admin-sdk-mock';
import {
  GoogleDeviceReader,
  validateServiceAccount,
} from '@campus/google-connection';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import { DeviceUpdateJobs } from './device-update.ts';

const scopes = ['device-inventory', 'device-changes'].map(
  (id) => GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope,
);

/** The reason the Deprovision test sends. One job holds one reason (D11). */
const deprovisionReason = 'DEPROVISION_REASON_RETIRING_DEVICE';

let mock;
let domain;
let credential;
let reader;
let activeId;
let disabledId;

/** One claimed operation of a status job: no field rows, and its requested value is the status. */
const op = (number, deviceId, value) => ({
  operationNumber: number,
  deviceId,
  serialNumber: `serial-${number}`,
  baselineValue: null,
  requestedValue: value,
  fields: [],
});

/** The cache stand-in of the mock tests. The mock is the subject, so no call is recorded. */
const cache = {
  publish: async () => undefined,
  increment: async () => undefined,
  remove: async () => undefined,
  removeMembers: async () => undefined,
  extendMembers: async () => undefined,
  setRecords: async () => undefined,
  close: async () => undefined,
};

/**
 * A database that answers the batch path and records its calls.
 * `targets` are the claimed operations of the job, in order.
 */
function database({ action, reason, targets }) {
  const calls = [];
  const deviceOf = (number) => targets[number - 1]?.deviceId;
  return {
    calls,
    async query(sql, values) {
      const name = (/cc\.(\w+)/.exec(sql) ?? /(\w+)\(\)/.exec(sql))[1];
      calls.push({ name, values });
      if (name === 'claim_device_update_batch')
        return {
          rows: [
            {
              result: {
                outcome: 'claimed',
                generation: 1,
                credentialId: randomUUID(),
                envelope: {},
                batchCount: 1,
                action,
                ...(reason === undefined ? {} : { deprovisionReason: reason }),
                operations: targets.map((target) =>
                  op(target.number, target.deviceId, target.value),
                ),
                readBack: [],
              },
            },
          ],
        };
      if (name === 'clock_timestamp') return { rows: [{ result: new Date() }] };
      if (name === 'renew_device_update_batch')
        return { rows: [{ result: new Date() }] };
      if (name === 'report_device_update_backoff')
        return { rows: [{ result: true }] };
      if (name === 'release_device_update_batch')
        return { rows: [{ result: null }] };
      if (name === 'settle_device_update_operations') {
        const results = JSON.parse(values[5]);
        return {
          rows: [
            {
              result: {
                outcome: 'settled',
                settled: results.map((result) => ({
                  operationNumber: result.operationNumber,
                  deviceId: deviceOf(result.operationNumber),
                  status: result.outcome,
                  batch: 0,
                })),
                published: results
                  .filter((result) => result.outcome === 'succeeded')
                  .map((result) => deviceOf(result.operationNumber)),
                removed: [],
                publication: null,
              },
            },
          ],
        };
      }
      throw new Error(`Unexpected call ${name}`);
    },
  };
}

/** One batch request of any action. */
const batchRequest = () => ({
  customerId: domain.customerId,
  jobId: randomUUID(),
  dispatchToken: randomUUID(),
  batch: 0,
  correlationId: randomUUID(),
});

/** Run one batch, and answer its result with the settlement rows the fake store received. */
async function run(db) {
  const jobs = new DeviceUpdateJobs(
    db,
    { open: () => credential },
    reader,
    cache,
  );
  const answer = await jobs.runBatch(
    batchRequest(),
    AbortSignal.timeout(60_000),
  );
  const settle = db.calls.find(
    (call) => call.name === 'settle_device_update_operations',
  );
  return {
    answer,
    results: settle === undefined ? null : JSON.parse(settle.values[5]),
  };
}

/**
 * Read one device with an unmodified Google client, so the answer comes from the mock.
 * The device observation drops the deprovision reason, so a raw read proves what Google stored.
 */
async function rawDevice(deviceId) {
  const auth = new JWT({
    email: credential.serviceAccount.client_email,
    key: credential.serviceAccount.private_key,
    keyId: credential.serviceAccount.private_key_id,
    scopes: [scopes[0]],
    subject: credential.subject,
  });
  const { data } = await auth.request({
    url: `https://admin.googleapis.com/admin/directory/v1/customer/${encodeURIComponent(domain.customerId)}/devices/chromeos/${encodeURIComponent(deviceId)}`,
    method: 'GET',
    params: { projection: 'FULL' },
    retry: false,
  });
  return data;
}

before(async () => {
  mock = await startMock();
  mock.useInProcess();
  domain = await mock.createDomain({ tier: 'small', seed: 'status-jobs' });
  const key = mock.credential(domain.customerId, scopes);
  credential = {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };
  reader = new GoogleDeviceReader();
  const devices = [];
  for await (const page of reader.devicePages(
    credential,
    domain.customerId,
    AbortSignal.timeout(60_000),
  ))
    devices.push(...page);
  activeId = devices.find((device) => device.status === 'ACTIVE').deviceId;
  disabledId = devices.find((device) => device.status === 'DISABLED').deviceId;
});

after(async () => {
  await mock?.close();
});

test('a Disable job on the mock settles each device and reports a status conflict', async () => {
  const db = database({
    action: 'disable',
    targets: [
      { number: 1, deviceId: activeId, value: 'DISABLED' },
      { number: 2, deviceId: disabledId, value: 'DISABLED' },
    ],
  });
  const { answer, results } = await run(db);
  assert.deepEqual(answer, {
    outcome: 'settled',
    failure: null,
    published: 1,
    removed: 0,
  });
  // Google answers HTTP 200 with one element per device (section 3).
  assert.deepEqual(results, [
    {
      operationNumber: 1,
      outcome: 'succeeded',
      verifiedBy: 'write-response',
      googleStatus: null,
      googleReason: null,
      quotaRetries: 0,
      transientRetries: 0,
    },
    {
      operationNumber: 2,
      outcome: 'failed',
      outcomeReason: 'status-conflict',
      googleReason: 'A device with status DISABLED does not allow this action.',
      value: null,
      googleStatus: null,
      quotaRetries: 0,
      transientRetries: 0,
    },
  ]);
  assert.equal(
    db.calls.some((call) => call.name === 'release_device_update_batch'),
    true,
    'Every operation settled, so the batch lease is released.',
  );
});

test('a Deprovision job on the mock settles ACTIVE and DISABLED targets and reports a deprovisioned target', async () => {
  const first = await run(
    database({
      action: 'deprovision',
      reason: deprovisionReason,
      targets: [
        { number: 1, deviceId: activeId, value: 'DEPROVISIONED' },
        { number: 2, deviceId: disabledId, value: 'DEPROVISIONED' },
      ],
    }),
  );
  assert.deepEqual(first.answer, {
    outcome: 'settled',
    failure: null,
    published: 2,
    removed: 0,
  });
  assert.deepEqual(
    first.results.map((result) => [
      result.operationNumber,
      result.outcome,
      result.outcomeReason ?? null,
    ]),
    [
      [1, 'succeeded', null],
      [2, 'succeeded', null],
    ],
    'An ACTIVE and a DISABLED device both accept a Deprovision.',
  );
  // The mock refuses a Deprovision without a reason, so a stored reason proves the job sent one.
  for (const deviceId of [activeId, disabledId]) {
    const stored = await rawDevice(deviceId);
    assert.equal(stored.status, 'DEPROVISIONED', deviceId);
    assert.equal(
      stored.deprovisionReason,
      deprovisionReason,
      `${deviceId} holds the reason of the job`,
    );
  }
  // A second job on a device that is now DEPROVISIONED fails with Google's code 9.
  const second = await run(
    database({
      action: 'deprovision',
      reason: deprovisionReason,
      targets: [{ number: 1, deviceId: activeId, value: 'DEPROVISIONED' }],
    }),
  );
  assert.deepEqual(
    second.results.map((result) => [
      result.outcome,
      result.outcomeReason,
      result.googleReason,
    ]),
    [
      [
        'failed',
        'status-conflict',
        'A device with status DEPROVISIONED does not allow this action.',
      ],
    ],
  );
});
