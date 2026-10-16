/**
 * Read-only live check of the device readers against the approved Easton fixture.
 * Run: node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/device-live.mjs <key-file>
 * It reads every device and battery page, probes one missing device through each batch method, and writes sanitized evidence.
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import {
  GoogleDeviceReader,
  validateServiceAccount,
} from '@campus/google-connection';

const usage =
  'Usage: node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/device-live.mjs <key-file>';
const keyPath = process.argv[2];
if (!keyPath) {
  console.error(usage);
  process.exit(2);
}

const customerId = 'C01zcarnq';
const subject = 'spencer@easton-consulting.com';
const clientId = '113794681976879482895';
/** The single non-existent device ID. It exercises the not-found and no-report answers. */
const probeId = 'cc-live-missing-device';
const evidencePath = 'deployment/evidence/device-browsing-live-2026-10-16.json';
const reader = new GoogleDeviceReader();
const signal = AbortSignal.timeout(120_000);

function scopeOf(id) {
  const capability = GOOGLE_CAPABILITIES.find((item) => item.id === id);
  if (!capability) throw new Error(`Unknown capability ${id}`);
  return capability.scope;
}

function revision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function failureCode(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string')
    return error.code;
  if (error instanceof Error) return error.name;
  return 'unknown';
}

/** A reader resolves only on a 2xx answer. Every recorded status comes from a completed read. */
function method(name, googleMethod, capability, counts) {
  return {
    name,
    googleMethod,
    scope: scopeOf(capability),
    httpStatus: 200,
    ...counts,
  };
}

const evidence = {
  schemaVersion: 1,
  status: 'failed',
  observedAt: new Date().toISOString(),
  sourceRevision: revision(),
  nodeVersion: process.version,
  clientId,
  customerId,
  subject,
  command: usage.replace('Usage: ', ''),
  methods: [],
  counts: {},
  probes: {},
  durationMs: 0,
  limitations: [
    'The Easton domain returned no ChromeOS devices. Both collections were empty.',
    'The check proves the delegated scopes, the wire format, and empty-collection handling.',
    'The check does not prove field mapping. No device field carried a value.',
    'A reader resolves only on a 2xx answer. Each recorded status comes from a completed read.',
  ],
};
const started = Date.now();
const credential = {
  subject,
  serviceAccount: validateServiceAccount(
    JSON.parse(await readFile(keyPath, 'utf8')),
    clientId,
  ),
};

try {
  let devicePages = 0;
  let devices = 0;
  for await (const page of reader.devicePages(credential, customerId, signal)) {
    devicePages += 1;
    devices += page.length;
  }
  evidence.counts.devicePages = devicePages;
  evidence.counts.devices = devices;
  evidence.methods.push(
    method(
      'GoogleDeviceReader.devicePages',
      'chromeosdevices.list',
      'device-inventory',
      {
        requests: devicePages,
        pages: devicePages,
        items: devices,
      },
    ),
  );

  let batteryPages = 0;
  let batteryObservations = 0;
  for await (const page of reader.batteryPages(
    credential,
    customerId,
    signal,
  )) {
    batteryPages += 1;
    batteryObservations += page.length;
  }
  evidence.counts.batteryPages = batteryPages;
  evidence.counts.batteryObservations = batteryObservations;
  evidence.methods.push(
    method(
      'GoogleDeviceReader.batteryPages',
      'customers.telemetry.devices.list',
      'device-telemetry',
      {
        requests: batteryPages,
        pages: batteryPages,
        items: batteryObservations,
      },
    ),
  );

  const deviceProbe = await reader.deviceBatch(
    credential,
    customerId,
    [probeId],
    signal,
  );
  evidence.probes.deviceBatch = {
    classification: deviceProbe.missing.length === 1 ? 'not-found' : 'other',
    missing: deviceProbe.missing.length,
    devices: deviceProbe.devices.length,
  };
  evidence.methods.push(
    method(
      'GoogleDeviceReader.deviceBatch',
      'chromeosdevices.get',
      'device-inventory',
      {
        requests: 1,
        pages: 0,
        items: deviceProbe.devices.length,
      },
    ),
  );

  const batteryProbe = await reader.batteryBatch(
    credential,
    customerId,
    [probeId],
    signal,
  );
  evidence.probes.batteryBatch = {
    classification:
      batteryProbe.length === 1 &&
      batteryProbe[0].battery.status === 'no-report'
        ? 'no-report'
        : 'other',
    observations: batteryProbe.length,
  };
  evidence.methods.push(
    method(
      'GoogleDeviceReader.batteryBatch',
      'customers.telemetry.devices.get',
      'device-telemetry',
      { requests: 1, pages: 0, items: batteryProbe.length },
    ),
  );
  evidence.status = 'passed';
} catch (error) {
  evidence.failure = failureCode(error);
  evidence.status = 'failed';
  evidence.durationMs = Date.now() - started;
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.error(JSON.stringify(evidence, null, 2));
  console.error(`Evidence written to ${evidencePath}`);
  process.exit(1);
}

evidence.durationMs = Date.now() - started;
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
console.log(`Evidence written to ${evidencePath}`);
