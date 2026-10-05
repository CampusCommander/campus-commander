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
import { GoogleConnectionError, failure, scopedClient } from './provider';

const directory = 'https://admin.googleapis.com/admin/directory/v1';
const management = 'https://chromemanagement.googleapis.com/v1';
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
        report.batteryHealth && Object.hasOwn(healthByGoogle, report.batteryHealth)
          ? healthByGoogle[report.batteryHealth]
          : null;
      return [{ reportedAt, health, capacityPercent: percent(report.fullChargeCapacity) }];
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

/** Read device inventory and battery telemetry with one exact-scope token per capability. */
export class GoogleDeviceReader {
  private async *pages<T>(
    credential: DelegatedCredential,
    scope: string,
    signal: AbortSignal,
    limit: number | undefined,
    load: (client: OAuth2Client, pageToken: string | undefined) => Promise<{
      items: T[];
      nextPageToken: string | undefined;
    }>,
  ): AsyncGenerator<T[]> {
    let client = await scopedClient(credential, scope, signal, limit);
    let issuedAt = Date.now();
    let pageToken: string | undefined;
    for (let page = 0; page < maximumPages; page++) {
      if (Date.now() - issuedAt > tokenRenewalMilliseconds) {
        client = await scopedClient(credential, scope, signal, limit);
        issuedAt = Date.now();
      }
      let result;
      try {
        result = await load(client, pageToken);
      } catch (error) {
        throw failure(error);
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
      undefined,
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
}
