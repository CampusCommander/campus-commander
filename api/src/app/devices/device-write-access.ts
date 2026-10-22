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

/** The margin that ends a running check before its reservation expires. */
export const DEVICE_WRITE_ACCESS_DEADLINE_MARGIN_SECONDS = 5;

/** The overall deadline of one check, from its reservation. */
export const DEVICE_WRITE_ACCESS_DEADLINE_MILLISECONDS =
  (DEVICE_WRITE_ACCESS_INTERVAL_SECONDS -
    DEVICE_WRITE_ACCESS_DEADLINE_MARGIN_SECONDS) *
  1000;

/** A check that arrives inside the interval of the previous check. */
export class WriteAccessBusyError extends Error {
  constructor() {
    super('A write access check is already running.');
    this.name = 'WriteAccessBusyError';
  }
}

/** A check that reached its deadline before the credential arrived. */
export class WriteAccessDeadlineError extends Error {
  constructor() {
    super('The write access check reached its deadline.');
    this.name = 'WriteAccessDeadlineError';
  }
}

/** The connected customer and generation that the check reads with. */
export interface DeviceWriteAccessContext {
  customerId: string;
  generation: number;
}

/** The credential source and the cached projection of one customer. */
export interface DeviceWriteAccessStore {
  /**
   * Reserve the one-check interval for this customer and generation. False means
   * a check already holds it, so no credential leaves and no token mints.
   */
  reserve(context: DeviceWriteAccessContext): Promise<boolean>;
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
const deniedCodes = ['delegation-not-authorized', 'scope-mismatch'];

/** The check options. Production uses the deadline of the card. */
export interface DeviceWriteAccessOptions {
  /** The overall deadline of one check, from its reservation. */
  deadlineMilliseconds?: number;
}

function measuredAt(): string {
  return new Date().toISOString();
}

/** Resolve a promise before the deadline, or reject with the deadline error. */
export function beforeDeadline<T>(
  work: Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void work.catch(() => undefined);
    throw new WriteAccessDeadlineError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WriteAccessDeadlineError()), remaining);
    timer.unref?.();
  });
  void work.catch(() => undefined);
  return Promise.race([work, expired]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Read and check the Google write scope. The check mints one token for the write
 * scope alone and lists one device. Only a scope failure denies access.
 */
export class DeviceWriteAccess {
  private readonly store: DeviceWriteAccessStore;
  private readonly getClient: DeviceWriteClientFactory;
  private readonly deadlineMilliseconds: number;

  constructor(
    store: DeviceWriteAccessStore,
    getClient: DeviceWriteClientFactory = scopedClient,
    options: DeviceWriteAccessOptions = {},
  ) {
    this.store = store;
    this.getClient = getClient;
    this.deadlineMilliseconds =
      options.deadlineMilliseconds ?? DEVICE_WRITE_ACCESS_DEADLINE_MILLISECONDS;
  }

  async read(
    _session: SessionResponse,
    context: DeviceWriteAccessContext,
  ): Promise<DeviceWriteAccessState> {
    return (await this.store.read(context)) ?? UNCHECKED_WRITE_ACCESS;
  }

  /**
   * Open the active credential of one generation for a caller that holds devices:write.
   * cc.device_write_credential enforces that action and answers 42501 for every other caller.
   */
  async credential(
    session: SessionResponse,
    context: DeviceWriteAccessContext,
  ): Promise<DelegatedCredential | null> {
    return this.store.credential(session, context);
  }

  async check(
    session: SessionResponse,
    context: DeviceWriteAccessContext,
  ): Promise<DeviceWriteAccessState> {
    const customerId = googleCustomerIdSchema.parse(context.customerId);
    if (!(await this.store.reserve(context))) throw new WriteAccessBusyError();
    // One deadline covers the credential read and every provider request. It
    // ends before the reservation key expires, so no second check can start
    // while this one still reads or mints.
    const deadline = Date.now() + this.deadlineMilliseconds;
    const credential = await beforeDeadline(
      this.store.credential(session, context),
      deadline,
    );
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
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // The credential arrived after the deadline, so no token mints.
      access = {
        state: 'unavailable',
        scope: DEVICE_WRITE_SCOPE,
        failure: 'network-failure',
        checkedAt: measuredAt(),
      };
    } else {
      try {
        const client = await this.getClient(
          credential,
          DEVICE_WRITE_SCOPE,
          AbortSignal.timeout(remaining),
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
    }
    const parsed = deviceWriteAccessSchema.parse(access);
    await this.store.write(context, parsed, GOOGLE_HEALTH_FRESH_SECONDS);
    return parsed;
  }
}
