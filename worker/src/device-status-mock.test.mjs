/**
 * A Disable job against admin-sdk-mock v0.2.0 (addendum section 5).
 * The mock answers the batch endpoint in process. No live Google call runs here.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
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

let mock;
let domain;
let credential;
let reader;
let activeId;
let disabledId;

/** One claimed operation of a status job. */
const op = (number, deviceId, value) => ({
  operationNumber: number,
  deviceId,
  serialNumber: `serial-${number}`,
  baselineValue: null,
  requestedValue: value,
});

/** A database that answers the batch path and records its calls. */
function database(devices) {
  const calls = [];
  const deviceOf = (number) => devices.get(number);
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
                action: 'disable',
                operations: [
                  op(1, activeId, 'DISABLED'),
                  op(2, disabledId, 'DISABLED'),
                ],
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
  const db = database(
    new Map([
      [1, activeId],
      [2, disabledId],
    ]),
  );
  const jobs = new DeviceUpdateJobs(db, { open: () => credential }, reader, {
    publish: async () => undefined,
    increment: async () => undefined,
    remove: async () => undefined,
    removeMembers: async () => undefined,
    extendMembers: async () => undefined,
    setRecords: async () => undefined,
    close: async () => undefined,
  });
  const answer = await jobs.runBatch(
    {
      customerId: domain.customerId,
      jobId: randomUUID(),
      dispatchToken: randomUUID(),
      batch: 0,
      correlationId: randomUUID(),
    },
    AbortSignal.timeout(60_000),
  );
  const settle = db.calls.find(
    (call) => call.name === 'settle_device_update_operations',
  );
  assert.deepEqual(answer, {
    outcome: 'settled',
    failure: null,
    published: 1,
    removed: 0,
  });
  // Google answers HTTP 200 with one element per device (section 3).
  assert.deepEqual(JSON.parse(settle.values[5]), [
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
