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
  type DeviceOrgUnitTreeEntry,
} from '@campus/application-contracts';
import type { DelegatedCredential } from './credential';
import {
  BATCH_DEFAULTS,
  BatchServiceError,
  GoogleBatchService,
  type BatchFailure,
  type BatchResult,
  type BatchResponseEvent,
  type BatchRoundEvent,
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
/** The default 256 KiB response limit holds about 1,500 organization units. */
const orgUnitTreeLimit = 4 * 1024 * 1024;
const orgUnitTreeMaxUnits = 10_000;
const directoryDevice = devicePage.shape.chromeosdevices.unwrap().element;
const telemetryConcurrency = 4;
const telemetryDevice = telemetryPage.shape.devices.unwrap().element;

/** The part answer of one annotated-location PATCH. Other fields stay out of the body. */
const writtenDevice = z.object({
  deviceId: z.string().min(1).max(128).optional(),
  annotatedLocation: z.string().max(4096).nullable().optional(),
});
export type WrittenDevice = z.infer<typeof writtenDevice>;

/** One approved write: the device and its final value. Clear sends null. */
export interface AnnotatedLocationWrite {
  deviceId: string;
  value: string | null;
}

export interface AnnotatedLocationBatchOptions {
  /** Parts of one multipart request. The worker setting defaults to 250. */
  batchSize?: number;
  onSend?(requestIds: readonly string[]): void | Promise<void>;
  onResponse?(event: BatchResponseEvent<WrittenDevice>): void | Promise<void>;
  onBatch?(event: BatchRoundEvent): void | Promise<void>;
}

/** The command ID format of the Directory API and the operation check. */
const commandIdPattern = /^[0-9]{1,20}$/;
/** Google accepts 1 to 50 device IDs in one batchChangeStatus part. */
const statusPartLimit = 50;

/** The status actions this build sends. */
export type DeviceStatusAction = 'disable' | 'reenable';
const statusActionNames: Readonly<Record<DeviceStatusAction, string>> = {
  disable: 'CHANGE_CHROME_OS_DEVICE_STATUS_ACTION_DISABLE',
  reenable: 'CHANGE_CHROME_OS_DEVICE_STATUS_ACTION_REENABLE',
};

/** One device and its approved status change. */
export interface DeviceStatusChange {
  deviceId: string;
  action: DeviceStatusAction;
}

/** One batchChangeStatus part: up to 50 device IDs under one action. */
export interface DeviceStatusPart {
  /** The caller key of the part. */
  id: string;
  action: DeviceStatusAction;
  deviceIds: string[];
}

/** The answer of one device in a 2xx batchChangeStatus part (design section 3). */
export interface DeviceStatusResult {
  deviceId: string;
  outcome: 'succeeded' | 'failed' | 'unknown';
  /** `not-found` reads google.rpc.Code 5, `status-conflict` code 9. */
  reason:
    | 'not-found'
    | 'status-conflict'
    | 'rejected'
    | 'invalid-response'
    | null;
  /** Google's message. Google sends a google.rpc.Code, not an HTTP status. */
  googleReason: string | null;
}

/** One device answer, or the failed part that covers it. */
export interface DeviceStatusAnswer {
  deviceId: string;
  /** Present when the part answered HTTP 2xx. */
  result: DeviceStatusResult | null;
  /** Present when the part failed. The caller classifies it by the step 4 rules. */
  failure: BatchFailure | null;
}

/** A status change run: one answer per change in request order, and the parts sent. */
export interface DeviceStatusBatch {
  answers: DeviceStatusAnswer[];
  parts: DeviceStatusPart[];
}

export interface DeviceStatusBatchOptions {
  /** Parts of one multipart request. The worker setting defaults to 250. */
  batchSize?: number;
  onSend?(parts: readonly DeviceStatusPart[]): void | Promise<void>;
  onResponse?(
    event: BatchResponseEvent<DeviceStatusResult[]>,
  ): void | Promise<void>;
  onBatch?(event: BatchRoundEvent): void | Promise<void>;
}

/** A batch call of one result type per request. */
export interface DeviceBatchOptions<T> {
  /** Parts of one multipart request. The worker setting defaults to 250. */
  batchSize?: number;
  onSend?(requestIds: readonly string[]): void | Promise<void>;
  onResponse?(event: BatchResponseEvent<T>): void | Promise<void>;
  onBatch?(event: BatchRoundEvent): void | Promise<void>;
}

/** One command to issue. Reboot carries no payload. */
export interface DeviceCommandIssue {
  deviceId: string;
  /** The Directory command type. The first build sends `REBOOT`. */
  commandType: string;
  /** A JSON payload string, as the Directory API expects. */
  payload?: string;
}

/** The 2xx answer of one issueCommand call. */
export interface IssuedDeviceCommand {
  commandId: string;
}

/** One command to read. */
export interface DeviceCommandPoll {
  deviceId: string;
  commandId: string;
}

/** The observed command of one getCommand answer. */
export interface DeviceCommandObservation {
  commandId: string;
  /** PENDING, SENT_TO_CLIENT, ACKED_BY_CLIENT, EXECUTED_BY_CLIENT, EXPIRED, or another value. */
  state: string;
  issuedAt: string | null;
  expiresAt: string | null;
  /** The result of EXECUTED_BY_CLIENT, when Google reports one. */
  result: string | null;
  executedAt: string | null;
  errorMessage: string | null;
}

const issuedCommand = z.object({
  commandId: z.string().regex(commandIdPattern),
});

/** A getCommand answer. A state outside the five passes through for the caller to report. */
const commandResource = z.object({
  commandId: z.string().regex(commandIdPattern),
  state: z.string().min(1).max(64),
  issueTime: z.string().max(64).optional(),
  commandExpireTime: z.string().max(64).optional(),
  commandResult: z
    .object({
      result: z.string().min(1).max(64),
      executeTime: z.string().max(64).optional(),
      errorMessage: z.string().max(4096).optional(),
    })
    .optional(),
});

const statusElement = z.object({
  deviceId: z.string().min(1).max(128),
  response: z.object({}).optional(),
  error: z
    .object({
      code: z.number().int(),
      message: z.string().max(4096).optional(),
    })
    .optional(),
});

const statusBody = z.object({
  changeChromeOsDeviceStatusResults: z.array(z.unknown()).optional(),
});

/** The device ID one raw status element names, or null when it names none. */
function statusElementId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const deviceId = (raw as { deviceId?: unknown }).deviceId;
  return typeof deviceId === 'string' ? deviceId : null;
}

/**
 * Read one batchChangeStatus answer (design section 3). Google answers HTTP 200
 * even when every device fails, so each requested device reads its own element.
 */
export function statusResults(
  body: unknown,
  deviceIds: readonly string[],
): DeviceStatusResult[] {
  const invalid = (deviceId: string): DeviceStatusResult => ({
    deviceId,
    outcome: 'unknown',
    reason: 'invalid-response',
    googleReason: null,
  });
  const parsed = statusBody.safeParse(body);
  if (!parsed.success) return deviceIds.map((deviceId) => invalid(deviceId));
  const rawElements = parsed.data.changeChromeOsDeviceStatusResults ?? [];
  const rawIds = rawElements.map(statusElementId);
  return deviceIds.map((deviceId) => {
    // Count raw elements before parsing. A malformed duplicate still repeats the ID.
    const index = rawIds.indexOf(deviceId);
    if (index === -1 || rawIds.indexOf(deviceId, index + 1) !== -1)
      return invalid(deviceId);
    const parsedElement = statusElement.safeParse(rawElements[index]);
    if (!parsedElement.success) return invalid(deviceId);
    const element = parsedElement.data;
    if (element.error !== undefined && element.response !== undefined)
      return invalid(deviceId);
    if (element.error !== undefined) {
      const code = element.error.code;
      return {
        deviceId,
        outcome: 'failed',
        reason:
          code === 5
            ? 'not-found'
            : code === 9
              ? 'status-conflict'
              : 'rejected',
        googleReason: element.error.message ?? null,
      };
    }
    if (element.response === undefined) return invalid(deviceId);
    return { deviceId, outcome: 'succeeded', reason: null, googleReason: null };
  });
}

/** Group changes into parts of up to 50 devices. A new action starts a new part. */
function statusParts(
  changes: readonly DeviceStatusChange[],
): DeviceStatusPart[] {
  const parts: DeviceStatusPart[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.deviceId))
      throw new GoogleConnectionError('invalid-response');
    seen.add(change.deviceId);
    const last = parts[parts.length - 1];
    if (
      last !== undefined &&
      last.action === change.action &&
      last.deviceIds.length < statusPartLimit
    ) {
      last.deviceIds.push(change.deviceId);
      continue;
    }
    parts.push({
      id: `status-${parts.length + 1}`,
      action: change.action,
      deviceIds: [change.deviceId],
    });
  }
  return parts;
}

/** One read-back answer per device. */
export type DeviceState =
  | { deviceId: string; status: 'found'; device: DeviceObservation }
  | { deviceId: string; status: 'missing' }
  | { deviceId: string; status: 'failed'; failure: BatchFailure };

export function scopeFor(
  id: 'device-inventory' | 'device-telemetry' | 'device-changes',
): string {
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
  if (failed.kind === 'invalid-response')
    return new GoogleConnectionError('invalid-response');
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
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
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
          if (
            classified.code !== 'quota' ||
            attempt >= BATCH_DEFAULTS.maxQuotaRetries
          )
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
   * Read the whole organization unit tree with the one read-only OU scope (design section 6).
   * A tree above 10,000 units answers invalid-response. Returned paths keep Google's casing.
   */
  async readOrgUnitTree(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): Promise<DeviceOrgUnitTreeEntry[]> {
    googleCustomerIdSchema.parse(customerId);
    signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const client = await scopedClient(
      credential,
      GOOGLE_CAPABILITIES.find(
        (capability) => capability.id === 'school-ou-references',
      )!.scope,
      signal,
      orgUnitTreeLimit,
    );
    let page: {
      organizationUnits: {
        orgUnitId: string;
        name: string;
        orgUnitPath: string;
        parentOrgUnitId?: string;
      }[];
    };
    try {
      page = z
        .object({
          organizationUnits: z
            .array(
              z.object({
                orgUnitId: z.string().min(1).max(128),
                name: z.string().min(1).max(256),
                orgUnitPath: z.string().min(1).max(4096).startsWith('/'),
                /** The root carries no parent fields. */
                parentOrgUnitId: z.string().min(1).max(128).optional(),
              }),
            )
            .min(1)
            .max(orgUnitTreeMaxUnits),
        })
        .parse(
          (
            await client.request({
              url: `${directory}/customer/${customerId}/orgunits`,
              method: 'GET',
              params: {
                type: 'all_including_parent',
                fields:
                  'organizationUnits(orgUnitId,name,orgUnitPath,parentOrgUnitId)',
              },
            })
          ).data,
        );
    } catch (error) {
      throw failure(error, 'read');
    }
    return page.organizationUnits.map((unit) => ({
      orgUnitId: unit.orgUnitId,
      name: unit.name,
      orgUnitPath: unit.orgUnitPath,
      parentOrgUnitId: unit.parentOrgUnitId ?? null,
    }));
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
    if (ids.length > batchLimit)
      throw new GoogleConnectionError('invalid-response');
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
          error.code === 'malformed-response'
            ? 'invalid-response'
            : 'request-failed',
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
   * One annotated-location PATCH per device through the batch service. The body names one field.
   * Clear sends null. The write scope comes from the `device-changes` capability.
   * Part failures stay in the result; the caller classifies them (design section 7.1).
   */
  async patchAnnotatedLocations(
    credential: DelegatedCredential,
    customerId: string,
    writes: readonly AnnotatedLocationWrite[],
    signal: AbortSignal,
    options: AnnotatedLocationBatchOptions = {},
  ): Promise<BatchResult<WrittenDevice>> {
    googleCustomerIdSchema.parse(customerId);
    if (writes.length > batchLimit)
      throw new GoogleConnectionError('invalid-response');
    const mint: { failure?: GoogleConnectionError } = {};
    const result = await this.batch.execute({
      batchUrl: batchEndpoint,
      requests: writes.map((write) => ({
        id: String(write.deviceId),
        method: 'PATCH' as const,
        path: `${directoryPath}/customer/${customerId}/devices/chromeos/${encodeURIComponent(write.deviceId)}`,
        query: { projection: 'FULL', fields: deviceFields },
        body: { annotatedLocation: write.value },
      })),
      parse: (body) => writtenDevice.parse(body) as WrittenDevice,
      getClient: async (runSignal) => {
        try {
          return await scopedClient(
            credential,
            scopeFor('device-changes'),
            runSignal,
            batchResponseLimit,
          );
        } catch (error) {
          mint.failure = failure(error, 'token');
          throw mint.failure;
        }
      },
      signal,
      options: { batchSize: options.batchSize ?? BATCH_DEFAULTS.batchSize },
      ...(options.onSend ? { onSend: options.onSend } : {}),
      ...(options.onResponse ? { onResponse: options.onResponse } : {}),
      ...(options.onBatch ? { onBatch: options.onBatch } : {}),
    });
    // A mint failure ends every waiting request without an event. The caller keeps
    // the code as the job failure (design section 7.2).
    if (mint.failure && !signal.aborted) throw mint.failure;
    return result;
  }

  /**
   * One issueCommand POST per device through the batch service. The write scope comes
   * from the `device-changes` capability. A quota answer never repeats: a second POST
   * sends a second command. A 2xx answer without a digit commandId fails as
   * `invalid-response`, which the caller reports as unknown.
   */
  async issueDeviceCommands(
    credential: DelegatedCredential,
    customerId: string,
    commands: readonly DeviceCommandIssue[],
    signal: AbortSignal,
    options: DeviceBatchOptions<IssuedDeviceCommand> = {},
  ): Promise<BatchResult<IssuedDeviceCommand>> {
    googleCustomerIdSchema.parse(customerId);
    if (commands.length > batchLimit)
      throw new GoogleConnectionError('invalid-response');
    const mint: { failure?: GoogleConnectionError } = {};
    const result = await this.batch.execute<IssuedDeviceCommand>({
      batchUrl: batchEndpoint,
      requests: commands.map((command) => ({
        id: command.deviceId,
        method: 'POST' as const,
        path: `${directoryPath}/customer/${customerId}/devices/chromeos/${encodeURIComponent(command.deviceId)}:issueCommand`,
        body: {
          commandType: command.commandType,
          ...(command.payload === undefined
            ? {}
            : { payload: command.payload }),
        },
      })),
      parse: (body) => issuedCommand.parse(body),
      getClient: async (runSignal) => {
        try {
          return await scopedClient(
            credential,
            scopeFor('device-changes'),
            runSignal,
            batchResponseLimit,
          );
        } catch (error) {
          mint.failure = failure(error, 'token');
          throw mint.failure;
        }
      },
      signal,
      options: {
        batchSize: options.batchSize ?? BATCH_DEFAULTS.batchSize,
        // A repeat of an accepted POST sends a second command (design section 3).
        maxQuotaRetries: 0,
      },
      ...(options.onSend ? { onSend: options.onSend } : {}),
      ...(options.onResponse ? { onResponse: options.onResponse } : {}),
      ...(options.onBatch ? { onBatch: options.onBatch } : {}),
    });
    if (mint.failure && !signal.aborted) throw mint.failure;
    return result;
  }

  /**
   * One getCommand GET per operation through the batch service. The read-only inventory
   * token serves every poll, so a later write-scope removal stops no poll. Quota and
   * transient answers keep the default retries; a GET repeats safely.
   */
  async deviceCommands(
    credential: DelegatedCredential,
    customerId: string,
    polls: readonly DeviceCommandPoll[],
    signal: AbortSignal,
    options: DeviceBatchOptions<DeviceCommandObservation> = {},
  ): Promise<BatchResult<DeviceCommandObservation>> {
    googleCustomerIdSchema.parse(customerId);
    if (polls.length > batchLimit)
      throw new GoogleConnectionError('invalid-response');
    for (const poll of polls)
      if (!commandIdPattern.test(poll.commandId))
        throw new GoogleConnectionError('invalid-response');
    const polled = new Map(
      polls.map((poll) => [poll.deviceId, poll.commandId]),
    );
    const mint: { failure?: GoogleConnectionError } = {};
    const result = await this.batch.execute<DeviceCommandObservation>({
      batchUrl: batchEndpoint,
      requests: polls.map((poll) => ({
        id: poll.deviceId,
        method: 'GET' as const,
        path: `${directoryPath}/customer/${customerId}/devices/chromeos/${encodeURIComponent(poll.deviceId)}/commands/${poll.commandId}`,
      })),
      parse: (body, request) => {
        const resource = commandResource.parse(body);
        // A poll settles the operation that issued the command, not another one.
        if (polled.get(request.id) !== resource.commandId)
          throw new GoogleConnectionError('invalid-response');
        return {
          commandId: resource.commandId,
          state: resource.state,
          issuedAt: instant(resource.issueTime),
          expiresAt: instant(resource.commandExpireTime),
          result: resource.commandResult?.result ?? null,
          executedAt: instant(resource.commandResult?.executeTime),
          errorMessage: resource.commandResult?.errorMessage ?? null,
        };
      },
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
      options: { batchSize: options.batchSize ?? BATCH_DEFAULTS.batchSize },
      ...(options.onSend ? { onSend: options.onSend } : {}),
      ...(options.onResponse ? { onResponse: options.onResponse } : {}),
      ...(options.onBatch ? { onBatch: options.onBatch } : {}),
    });
    if (mint.failure && !signal.aborted) throw mint.failure;
    return result;
  }

  /**
   * One batchChangeStatus POST part per group of up to 50 devices, in request order.
   * Google answers HTTP 200 even when every device fails, so `statusResults` reads
   * each device element. A failed part returns its failure for every device it held.
   */
  async changeDeviceStatus(
    credential: DelegatedCredential,
    customerId: string,
    changes: readonly DeviceStatusChange[],
    signal: AbortSignal,
    options: DeviceStatusBatchOptions = {},
  ): Promise<DeviceStatusBatch> {
    googleCustomerIdSchema.parse(customerId);
    const parts = statusParts(changes);
    const partById = new Map(parts.map((part) => [part.id, part]));
    const send = options.onSend;
    const mint: { failure?: GoogleConnectionError } = {};
    const result = await this.batch.execute<DeviceStatusResult[]>({
      batchUrl: batchEndpoint,
      requests: parts.map((part) => ({
        id: part.id,
        method: 'POST' as const,
        path: `${directoryPath}/customer/${customerId}/devices/chromeos:batchChangeStatus`,
        body: {
          deviceIds: part.deviceIds,
          changeChromeOsDeviceStatusAction: statusActionNames[part.action],
        },
      })),
      parse: (body, request) =>
        statusResults(body, partById.get(request.id)?.deviceIds ?? []),
      getClient: async (runSignal) => {
        try {
          return await scopedClient(
            credential,
            scopeFor('device-changes'),
            runSignal,
            batchResponseLimit,
          );
        } catch (error) {
          mint.failure = failure(error, 'token');
          throw mint.failure;
        }
      },
      signal,
      options: { batchSize: options.batchSize ?? BATCH_DEFAULTS.batchSize },
      ...(send
        ? {
            onSend: async (ids: readonly string[]) => {
              const sent = ids.flatMap((id) => {
                const part = partById.get(id);
                return part ? [part] : [];
              });
              await send(sent);
            },
          }
        : {}),
      ...(options.onResponse ? { onResponse: options.onResponse } : {}),
      ...(options.onBatch ? { onBatch: options.onBatch } : {}),
    });
    if (mint.failure && !signal.aborted) throw mint.failure;
    const answers = new Map<string, DeviceStatusAnswer>();
    for (const part of parts) {
      const pages = result.succeeded.get(part.id);
      if (pages) {
        for (const answer of pages[pages.length - 1])
          answers.set(answer.deviceId, {
            deviceId: answer.deviceId,
            result: answer,
            failure: null,
          });
        continue;
      }
      const failure = result.failed.get(part.id) ?? {
        kind: 'invalid-response' as const,
        status: 0,
        reason: 'missing-part',
        attempts: { quota: 0, transient: 0 },
        body: null,
      };
      for (const deviceId of part.deviceIds)
        answers.set(deviceId, { deviceId, result: null, failure });
    }
    return {
      answers: changes.map(
        (change) =>
          answers.get(change.deviceId) ?? {
            deviceId: change.deviceId,
            result: {
              deviceId: change.deviceId,
              outcome: 'unknown',
              reason: 'invalid-response',
              googleReason: null,
            },
            failure: null,
          },
      ),
      parts,
    };
  }

  /**
   * One GET per device through the batch service. It returns one result per ID.
   * `deviceBatch` stops on the first failure; a read-back settles each operation on its own.
   */
  async deviceStates(
    credential: DelegatedCredential,
    customerId: string,
    deviceIds: readonly string[],
    signal: AbortSignal,
  ): Promise<DeviceState[]> {
    googleCustomerIdSchema.parse(customerId);
    const ids = [...new Set(deviceIds)];
    if (ids.length === 0) return [];
    if (ids.length > batchLimit)
      throw new GoogleConnectionError('invalid-response');
    const mint: { failure?: GoogleConnectionError } = {};
    const states = new Map<string, DeviceState>();
    const result = await this.batch.execute({
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
    });
    // A mint failure fails every part without an event. The caller settles each
    // operation as unknown with verification-failed (ruling 1).
    if (mint.failure && !signal.aborted) throw mint.failure;
    for (const id of ids) {
      const pages = result.succeeded.get(id);
      if (pages) {
        states.set(id, {
          deviceId: id,
          status: 'found',
          device: pages[pages.length - 1],
        });
        continue;
      }
      const failed = result.failed.get(id);
      if (failed?.kind === 'not-found') {
        states.set(id, { deviceId: id, status: 'missing' });
        continue;
      }
      states.set(id, {
        deviceId: id,
        status: 'failed',
        failure: failed ?? {
          kind: 'invalid-response',
          status: 0,
          reason: 'missing-part',
          attempts: { quota: 0, transient: 0 },
          body: null,
        },
      });
    }
    return ids.map(
      (id) =>
        states.get(id) ?? {
          deviceId: id,
          status: 'failed',
          failure: {
            kind: 'invalid-response',
            status: 0,
            reason: 'missing-part',
            attempts: { quota: 0, transient: 0 },
            body: null,
          },
        },
    );
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
          results.push({
            deviceId: id,
            battery: { status: 'no-report' },
            reports: [],
          });
          return;
        }
        throw failure(error);
      }
    };
    // The first hard failure stops new reads. Reads already in flight settle before it surfaces.
    const stop: { error?: GoogleConnectionError } = {};
    await Promise.all(
      Array.from(
        { length: Math.min(telemetryConcurrency, queue.length) },
        async () => {
          while (!stop.error) {
            const id = queue.shift();
            if (id === undefined) return;
            try {
              await readOne(id);
            } catch (error) {
              stop.error ??= failure(error);
            }
          }
        },
      ),
    );
    if (stop.error) throw stop.error;
    return results.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }
}
