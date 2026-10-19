import { z } from 'zod';
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_HEALTH_FRESH_SECONDS,
  deviceWriteAccessSchema,
  googleCustomerIdSchema,
  type DeviceWriteAccess as DeviceWriteAccessState,
  type SessionResponse,
} from '@campus/application-contracts';
import {
  failure,
  scopedClient,
  type DelegatedCredential,
} from '@campus/google-connection';

/** The write capability of section 4.1, and the one scope its token carries. */
export const DEVICE_WRITE_SCOPE = GOOGLE_CAPABILITIES.find(
  (capability) => capability.id === 'device-changes',
)!.scope;

/** The projection before any check ran, from section 2.7. */
export const UNCHECKED_WRITE_ACCESS: DeviceWriteAccessState = Object.freeze({
  state: 'unchecked',
  scope: null,
  failure: null,
  checkedAt: null,
});

/** The minimum interval between two checks of one customer and generation. */
export const DEVICE_WRITE_ACCESS_INTERVAL_SECONDS = 30;

/** A check that arrives inside the interval of the previous check. */
export class WriteAccessBusyError extends Error {
  constructor() {
    super('A write access check is already running.');
    this.name = 'WriteAccessBusyError';
  }
}

/** The connected customer and generation that the check reads with. */
export interface DeviceWriteAccessContext {
  customerId: string;
  generation: number;
}

/** The credential source and the cached projection of one customer. */
export interface DeviceWriteAccessStore {
  /** Open the active credential for a caller that holds devices:write. Null means no connection. */
  credential(
    session: SessionResponse,
    context: DeviceWriteAccessContext,
  ): Promise<DelegatedCredential | null>;
  read(
    context: DeviceWriteAccessContext,
  ): Promise<DeviceWriteAccessState | null>;
  write(
    context: DeviceWriteAccessContext,
    access: DeviceWriteAccessState,
    seconds: number,
  ): Promise<void>;
}

/** One API call with a token that carries exactly one scope. */
export interface DeviceWriteClient {
  request(options: {
    url: string;
    method: 'GET';
    params: Record<string, unknown>;
  }): Promise<{ data: unknown }>;
}

export type DeviceWriteClientFactory = (
  credential: DelegatedCredential,
  scope: string,
  signal: AbortSignal,
) => Promise<DeviceWriteClient>;

/** The one list answer. An empty device collection still proves the grant. */
const listPageSchema = z.object({
  chromeosdevices: z.array(z.unknown()).max(300).optional(),
});
const checkTimeoutMilliseconds = 30_000;
const deniedCodes = ['delegation-not-authorized', 'scope-mismatch'];

function measuredAt(): string {
  return new Date().toISOString();
}

/**
 * Read and check the Google write scope. The check mints one token for the write
 * scope alone and lists one device. Only a scope failure denies access.
 */
export class DeviceWriteAccess {
  private readonly store: DeviceWriteAccessStore;
  private readonly getClient: DeviceWriteClientFactory;

  constructor(
    store: DeviceWriteAccessStore,
    getClient: DeviceWriteClientFactory = scopedClient,
  ) {
    this.store = store;
    this.getClient = getClient;
  }

  async read(
    _session: SessionResponse,
    context: DeviceWriteAccessContext,
  ): Promise<DeviceWriteAccessState> {
    return (await this.store.read(context)) ?? UNCHECKED_WRITE_ACCESS;
  }

  async check(
    session: SessionResponse,
    context: DeviceWriteAccessContext,
  ): Promise<DeviceWriteAccessState> {
    const customerId = googleCustomerIdSchema.parse(context.customerId);
    const credential = await this.store.credential(session, context);
    if (!credential) {
      await this.store.write(
        context,
        UNCHECKED_WRITE_ACCESS,
        GOOGLE_HEALTH_FRESH_SECONDS,
      );
      return UNCHECKED_WRITE_ACCESS;
    }
    let stage: 'token' | 'read' = 'token';
    let access: DeviceWriteAccessState;
    try {
      const client = await this.getClient(
        credential,
        DEVICE_WRITE_SCOPE,
        AbortSignal.timeout(checkTimeoutMilliseconds),
      );
      stage = 'read';
      listPageSchema.parse(
        (
          await client.request({
            url: `https://admin.googleapis.com/admin/directory/v1/customer/${customerId}/devices/chromeos`,
            method: 'GET',
            params: { maxResults: 1, fields: 'chromeosdevices(deviceId)' },
          })
        ).data ?? {},
      );
      access = {
        state: 'granted',
        scope: DEVICE_WRITE_SCOPE,
        failure: null,
        checkedAt: measuredAt(),
      };
    } catch (error) {
      const code = failure(error, stage).code;
      access = {
        state: deniedCodes.includes(code) ? 'denied' : 'unavailable',
        scope: DEVICE_WRITE_SCOPE,
        failure: code,
        checkedAt: measuredAt(),
      };
    }
    const parsed = deviceWriteAccessSchema.parse(access);
    await this.store.write(context, parsed, GOOGLE_HEALTH_FRESH_SECONDS);
    return parsed;
  }
}
