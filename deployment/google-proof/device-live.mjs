/**
 * Read-only live check of the device readers against the approved Easton fixture.
 * Run: node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/device-live.mjs <key-file>
 * It reads every device and battery page, probes one missing device through each batch method, and writes sanitized evidence.
 * A transport observer records the HTTP answer of every reader request. The readers stay unchanged.
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import {
  GoogleDeviceReader,
  validateServiceAccount,
} from '@campus/google-connection';
import {
  headerValue,
  parseMultipartResponse,
} from '../../libs/google-connection/src/lib/batch.ts';

export const usage =
  'Usage: node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/device-live.mjs <key-file>';
const evidencePath = 'deployment/evidence/device-browsing-live-2026-10-16.json';
const customerId = 'C01zcarnq';
const subject = 'spencer@easton-consulting.com';
const clientId = '113794681976879482895';
/** The single non-existent device ID. It exercises the not-found and no-report answers. */
const probeId = 'cc-live-missing-device';
const batchEndpoint = 'https://www.googleapis.com/batch/admin/directory_v1';

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

function urlOf(options) {
  return typeof options?.url === 'string' ? options.url : '';
}

/** The HTTP status of one transport answer, or null when the answer carried none. */
function statusOf(response) {
  return Number.isInteger(response?.status) ? response.status : null;
}

/**
 * The part statuses of a batch answer. The Directory batch wraps every GET answer in one multipart body.
 * A parse doubt returns undefined. The reader parses the same body, so it reports its own failure.
 */
function batchPartStatuses(url, response) {
  try {
    if (url !== batchEndpoint) return undefined;
    const contentType = headerValue(response?.headers, 'content-type') ?? '';
    if (!/^multipart\//i.test(contentType) || typeof response?.data !== 'string')
      return undefined;
    return parseMultipartResponse(contentType, response.data).map(
      (part) => part.status,
    );
  } catch {
    return undefined;
  }
}

/**
 * Record the transport answer of every reader request.
 * The readers call `OAuth2Client.prototype.request` for each Google read, so this wrapper sees each answer.
 * The wrapper passes the answer through unchanged and rethrows every error unchanged.
 */
export function observeReaderRequests() {
  const records = [];
  const original = OAuth2Client.prototype.request;
  OAuth2Client.prototype.request = async function (options) {
    try {
      const response = await original.call(this, options);
      records.push({
        url: urlOf(options),
        status: statusOf(response),
        partStatuses: batchPartStatuses(urlOf(options), response),
      });
      return response;
    } catch (error) {
      records.push({
        url: urlOf(options),
        status: statusOf(error?.response),
        partStatuses: undefined,
      });
      throw error;
    }
  };
  return {
    records,
    stop() {
      OAuth2Client.prototype.request = original;
    },
  };
}

/** The observed answers of one reader call. `requests` counts every attempt, a retry included. */
function observation(records, from) {
  const slice = records.slice(from);
  const statuses = slice.map((record) => record.status);
  const partStatuses = slice.flatMap((record) => record.partStatuses ?? []);
  return {
    httpStatus: statuses.at(-1) ?? null,
    statuses,
    requests: slice.length,
    ...(partStatuses.length > 0 ? { partStatuses } : {}),
  };
}

function method(name, googleMethod, capability, observed, counts) {
  return {
    name,
    googleMethod,
    scope: scopeOf(capability),
    httpStatus: observed.httpStatus,
    statuses: observed.statuses,
    requests: observed.requests,
    pages: counts.pages,
    items: counts.items,
    ...(observed.partStatuses ? { partStatuses: observed.partStatuses } : {}),
  };
}

const limitations = [
  'The Easton domain returned no ChromeOS devices. Both collections were empty.',
  'The check proves the delegated scopes, the wire format, and empty-collection handling.',
  'The check does not prove field mapping. No device field carried a value.',
  'Every recorded status is the observed transport answer of that request.',
  'A batch entry records the outer multipart status in httpStatus. Its partStatuses list the answered GET statuses.',
  'The missing-device probes classify the answer to one unknown device ID.',
];

/**
 * Run the four production reader calls, record their observed answers, and write the evidence.
 * `options.reader` and `options.output` exist for the regression test. A live run uses both defaults.
 */
export async function runCheck(credential, options = {}) {
  const reader = options.reader ?? new GoogleDeviceReader();
  const output = options.output ?? evidencePath;
  const signal = options.signal ?? AbortSignal.timeout(120_000);
  const observer = observeReaderRequests();
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
    limitations,
  };
  const started = Date.now();

  try {
    let from = observer.records.length;
    let devicePages = 0;
    let devices = 0;
    for await (const page of reader.devicePages(
      credential,
      customerId,
      signal,
    )) {
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
        observation(observer.records, from),
        { pages: devicePages, items: devices },
      ),
    );

    from = observer.records.length;
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
        observation(observer.records, from),
        { pages: batteryPages, items: batteryObservations },
      ),
    );

    from = observer.records.length;
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
        observation(observer.records, from),
        { pages: 0, items: deviceProbe.devices.length },
      ),
    );

    from = observer.records.length;
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
        observation(observer.records, from),
        { pages: 0, items: batteryProbe.length },
      ),
    );
    evidence.status = 'passed';
  } catch (error) {
    evidence.failure = failureCode(error);
  } finally {
    observer.stop();
  }

  evidence.durationMs = Date.now() - started;
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

async function main() {
  const keyPath = process.argv[2];
  if (!keyPath) {
    console.error(usage);
    process.exit(2);
  }
  const credential = {
    subject,
    serviceAccount: validateServiceAccount(
      JSON.parse(await readFile(keyPath, 'utf8')),
      clientId,
    ),
  };
  const evidence = await runCheck(credential);
  if (evidence.status === 'passed') {
    console.log(JSON.stringify(evidence, null, 2));
    console.log(`Evidence written to ${evidencePath}`);
    return;
  }
  console.error(JSON.stringify(evidence, null, 2));
  console.error(`Evidence written to ${evidencePath}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();