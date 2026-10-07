import { z } from 'zod';
import type { OAuth2Client } from 'google-auth-library';
import {
  GOOGLE_CAPABILITIES,
  batteryObservationSchema,
  deviceObservationSchema,
  googleCustomerIdSchema,
  type BatteryHealth,
  type BatteryObservation,
  type DeviceObservation,
} from '@campus/application-contracts';
import type { DelegatedCredential } from './credential';
import {
  BATCH_DEFAULTS,
  BatchServiceError,
  GoogleBatchService,
  type BatchFailure,
} from './batch';
import { GoogleConnectionError, failure, scopedClient } from './provider';

const directory = 'https://admin.googleapis.com/admin/directory/v1';
const management = 'https://chromemanagement.googleapis.com/v1';
/** A full page of 300 devices with long notes exceeds the default 256 KB limit. */
const devicePageLimit = 4 * 1024 * 1024;
const telemetryLimit = 8 * 1024 * 1024;
const maximumPages = 10_000;
const reportLimit = 30;
const tokenRenewalMilliseconds = 45 * 60_000;

const healthByGoogle: Readonly<Record<string, BatteryHealth>> = {
  BATTERY_HEALTH_NORMAL: 'normal',
  BATTERY_REPLACE_SOON: 'replace-soon',
  BATTERY_REPLACE_NOW: 'replace-now',
};

const devicePage = z.object({
  nextPageToken: z.string().min(1).max(4096).optional(),
  chromeosdevices: z
    .array(
      z.object({
        deviceId: z.string().min(1).max(128),
        serialNumber: z.string().max(256).optional(),
        model: z.string().max(256).optional(),
        annotatedAssetId: z.string().max(256).optional(),
        orgUnitPath: z.string().min(1).max(4096),
        lastSync: z.string().max(64).optional(),
        annotatedLocation: z.string().max(4096).optional(),
        notes: z.string().max(4096).optional(),
        status: z.string().max(64).optional(),
      }),
    )
    .max(300)
    .optional(),
});
type DirectoryDevice = NonNullable<
  z.infer<typeof devicePage>['chromeosdevices']
>[number];

const telemetryPage = z.object({
  nextPageToken: z.string().min(1).max(4096).optional(),
  devices: z
    .array(
      z.object({
        deviceId: z.string().min(1).max(128).optional(),
        batteryInfo: z
          .array(z.object({ designCapacity: z.coerce.number().optional() }))
          .max(16)
          .optional(),
        batteryStatusReport: z
          .array(
            z.object({
              reportTime: z.string().max(64),
              fullChargeCapacity: z.coerce.number().optional(),
              batteryHealth: z.string().max(64).optional(),
            }),
          )
          .max(1000)
          .optional(),
      }),
    )
    .max(1000)
    .optional(),
});
type TelemetryDevice = NonNullable<
  z.infer<typeof telemetryPage>['devices']
>[number];

const batchEndpoint = 'https://www.googleapis.com/batch/admin/directory_v1';
const directoryPath = '/admin/directory/v1';
const deviceFields =
  'deviceId,serialNumber,model,annotatedAssetId,orgUnitPath,lastSync,annotatedLocation,notes,status';
const batchLimit = 1000;
/** 250 devices with full notes and locations stay under this. */
const batchResponseLimit = 4 * 1024 * 1024;
const directoryDevice = devicePage.shape.chromeosdevices.unwrap().element;
const telemetryConcurrency = 4;
const telemetryDevice = telemetryPage.shape.devices.unwrap().element;
function scopeFor(id: 'device-inventory' | 'device-telemetry'): string {
  return GOOGLE_CAPABILITIES.find((capability) => capability.id === id)!.scope;
}

function blank(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value;
}

function instant(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function deviceObservation(device: DirectoryDevice): DeviceObservation {
  return deviceObservationSchema.parse({
    deviceId: device.deviceId,
    serialNumber: device.serialNumber ?? '',
    model: blank(device.model),
    assetTag: blank(device.annotatedAssetId),
    orgUnitPath: device.orgUnitPath,
    lastContact: instant(device.lastSync),
    annotatedLocation: blank(device.annotatedLocation),
    notes: blank(device.notes),
    status: blank(device.status),
  });
}

/** Google classifies health. Campus Commander only converts capacities to a percentage. */
export function batteryObservation(
  device: TelemetryDevice,
): BatteryObservation | null {
  if (!device.deviceId) return null;
  const design = device.batteryInfo?.[0]?.designCapacity;
  const percent = (full: number | undefined) =>
    design !== undefined && design > 0 && full !== undefined && full >= 0
      ? Math.min(200, Math.round((full * 100) / design))
      : null;
  const reports = (device.batteryStatusReport ?? [])
    .flatMap((report) => {
      const reportedAt = instant(report.reportTime);
      if (!reportedAt) return [];
      const health =
        report.batteryHealth &&
        Object.hasOwn(healthByGoogle, report.batteryHealth)
          ? healthByGoogle[report.batteryHealth]
          : null;
      return [
        {
          reportedAt,
          health,
          capacityPercent: percent(report.fullChargeCapacity),
        },
      ];
    })
    .sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt))
    .slice(0, reportLimit);
  const classified = reports.find((report) => report.health !== null);
  return batteryObservationSchema.parse({
    deviceId: device.deviceId,
    battery: classified?.health
      ? {
          status: 'reported',
          health: classified.health,
          capacityPercent: classified.capacityPercent,
          reportedAt: classified.reportedAt,
        }
      : { status: 'no-report' },
    reports,
  });
}

const quotaBackoff = (attempt: number) =>
  Math.min(60_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 500);

/** Wait for a quota backoff. An abort ends the wait with the quota failure. */
async function quotaSleep(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) throw new GoogleConnectionError('quota');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new GoogleConnectionError('quota'));
    };
    signal.addEventListener('abort', abort, { once: true });
    timer.unref();
  });
}

/** Map a final batch failure to the existing failure vocabulary. */
function batchFailure(failed: BatchFailure): GoogleConnectionError {
  if (failed.kind === 'quota') return new GoogleConnectionError('quota');
  if (failed.kind === 'invalid-response') return new GoogleConnectionError('invalid-response');
  if (failed.kind === 'aborted' || failed.status === 0)
    return new GoogleConnectionError('network-failure');
  return failure({ response: { status: failed.status, data: failed.body } });
}

export interface GoogleDeviceReaderOptions {
  batch?: GoogleBatchService;
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>;
  backoff?(attempt: number): number;
}

/** Read device inventory and battery telemetry with one exact-scope token per capability. */
export class GoogleDeviceReader {
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly backoff: (attempt: number) => number;
  private readonly batch: GoogleBatchService;

  constructor(options: GoogleDeviceReaderOptions = {}) {
    this.sleep = options.sleep ?? quotaSleep;
    this.backoff = options.backoff ?? quotaBackoff;
    this.batch = options.batch ?? new GoogleBatchService();
  }

  /** Follow page tokens. A quota answer retries the same page up to 25 times, then fails with quota. */
  private async *pages<T>(
    credential: DelegatedCredential,
    scope: string,
    signal: AbortSignal,
    limit: number | undefined,
    load: (
      client: OAuth2Client,
      pageToken: string | undefined,
    ) => Promise<{
      items: T[];
      nextPageToken: string | undefined;
    }>,
  ): AsyncGenerator<T[]> {
    let client = await scopedClient(credential, scope, signal, limit);
    let issuedAt = Date.now();
    let pageToken: string | undefined;
    for (let page = 0; page < maximumPages; page++) {
      let result;
      for (let attempt = 0; ; attempt++) {
        if (Date.now() - issuedAt > tokenRenewalMilliseconds) {
          client = await scopedClient(credential, scope, signal, limit);
          issuedAt = Date.now();
        }
        try {
          result = await load(client, pageToken);
          break;
        } catch (error) {
          const classified = failure(error);
          if (classified.code !== 'quota' || attempt >= BATCH_DEFAULTS.maxQuotaRetries)
            throw classified;
          await this.sleep(this.backoff(attempt), signal);
          if (signal.aborted) throw new GoogleConnectionError('quota');
        }
      }
      yield result.items;
      if (!result.nextPageToken) return;
      pageToken = result.nextPageToken;
    }
    throw new GoogleConnectionError('invalid-response');
  }

  devicePages(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): AsyncGenerator<DeviceObservation[]> {
    googleCustomerIdSchema.parse(customerId);
    return this.pages(
      credential,
      scopeFor('device-inventory'),
      signal,
      devicePageLimit,
      async (client, pageToken) => {
        const data = devicePage.parse(
          (
            await client.request({
              url: `${directory}/customer/${customerId}/devices/chromeos`,
              method: 'GET',
              params: {
                maxResults: 300,
                projection: 'FULL',
                fields:
                  'nextPageToken,chromeosdevices(deviceId,serialNumber,model,annotatedAssetId,orgUnitPath,lastSync,annotatedLocation,notes,status)',
                ...(pageToken ? { pageToken } : {}),
              },
            })
          ).data,
        );
        return {
          items: (data.chromeosdevices ?? []).map(deviceObservation),
          nextPageToken: data.nextPageToken,
        };
      },
    );
  }

  batteryPages(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): AsyncGenerator<BatteryObservation[]> {
    googleCustomerIdSchema.parse(customerId);
    return this.pages(
      credential,
      scopeFor('device-telemetry'),
      signal,
      telemetryLimit,
      async (client, pageToken) => {
        const data = telemetryPage.parse(
          (
            await client.request({
              url: `${management}/customers/${customerId}/telemetry/devices`,
              method: 'GET',
              params: {
                readMask: 'deviceId,batteryInfo,batteryStatusReport',
                pageSize: 200,
                ...(pageToken ? { pageToken } : {}),
              },
            })
          ).data,
        );
        return {
          items: (data.devices ?? []).flatMap((device) => {
            const observation = batteryObservation(device);
            return observation ? [observation] : [];
          }),
          nextPageToken: data.nextPageToken,
        };
      },
    );
  }

  /**
   * Directory reads through the batch service. A 404 names a removed device.
   * Quota and server errors retry per part. Any other final failure fails the batch.
   * `onRound` runs after each multipart round, so the caller can extend its claim.
   */
  async deviceBatch(
    credential: DelegatedCredential,
    customerId: string,
    deviceIds: readonly string[],
    signal: AbortSignal,
    onRound?: () => Promise<void>,
  ): Promise<{ devices: DeviceObservation[]; missing: string[] }> {
    googleCustomerIdSchema.parse(customerId);
    const ids = [...new Set(deviceIds)];
    if (ids.length === 0) return { devices: [], missing: [] };
    if (ids.length > batchLimit) throw new GoogleConnectionError('invalid-response');
    const mint: { failure?: GoogleConnectionError } = {};
    let result;
    try {
      result = await this.batch.execute({
        batchUrl: batchEndpoint,
        requests: ids.map((id) => ({
          id,
          method: 'GET' as const,
          path: `${directoryPath}/customer/${customerId}/devices/chromeos/${encodeURIComponent(id)}`,
          query: { projection: 'FULL', fields: deviceFields },
        })),
        parse: (body) => deviceObservation(directoryDevice.parse(body)),
        getClient: async (runSignal) => {
          try {
            return await scopedClient(
              credential,
              scopeFor('device-inventory'),
              runSignal,
              batchResponseLimit,
            );
          } catch (error) {
            mint.failure = failure(error, 'token');
            throw mint.failure;
          }
        },
        signal,
        ...(onRound ? { onBatch: onRound } : {}),
      });
    } catch (error) {
      if (error instanceof BatchServiceError)
        throw new GoogleConnectionError(
          error.code === 'malformed-response' ? 'invalid-response' : 'request-failed',
        );
      throw error;
    }
    if (mint.failure) throw mint.failure;
    const devices: DeviceObservation[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const pages = result.succeeded.get(id);
      if (pages) {
        devices.push(...pages);
        continue;
      }
      const failed = result.failed.get(id);
      if (failed?.kind === 'not-found') missing.push(id);
      else if (failed) throw batchFailure(failed);
    }
    return { devices, missing };
  }

  /**
   * One telemetry read per device, four at a time. A device without telemetry has no report.
   * The first other failure stops new reads and surfaces after the reads in flight settle.
   */
  async batteryBatch(
    credential: DelegatedCredential,
    customerId: string,
    deviceIds: readonly string[],
    signal: AbortSignal,
  ): Promise<BatteryObservation[]> {
    googleCustomerIdSchema.parse(customerId);
    if (deviceIds.length === 0) return [];
    const client = await scopedClient(
      credential,
      scopeFor('device-telemetry'),
      signal,
      telemetryLimit,
    );
    const results: BatteryObservation[] = [];
    const queue = [...deviceIds];
    const readOne = async (id: string) => {
      try {
        const data = telemetryDevice.parse(
          (
            await client.request({
              url: `${management}/customers/${customerId}/telemetry/devices/${encodeURIComponent(id)}`,
              method: 'GET',
              params: { readMask: 'deviceId,batteryInfo,batteryStatusReport' },
            })
          ).data,
        );
        const observation = batteryObservation({ ...data, deviceId: id });
        if (observation) results.push(observation);
      } catch (error) {
        const status = z
          .object({ response: z.object({ status: z.number() }) })
          .safeParse(error).data?.response.status;
        if (status === 404) {
          results.push({ deviceId: id, battery: { status: 'no-report' }, reports: [] });
          return;
        }
        throw failure(error);
      }
    };
    // The first hard failure stops new reads. Reads already in flight settle before it surfaces.
    const stop: { error?: GoogleConnectionError } = {};
    await Promise.all(
      Array.from({ length: Math.min(telemetryConcurrency, queue.length) }, async () => {
        while (!stop.error) {
          const id = queue.shift();
          if (id === undefined) return;
          try {
            await readOne(id);
          } catch (error) {
            stop.error ??= failure(error);
          }
        }
      }),
    );
    if (stop.error) throw stop.error;
    return results.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }
}
