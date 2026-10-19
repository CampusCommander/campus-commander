import type {
  DeviceWriteAccess as DeviceWriteAccessState,
  SessionResponse,
} from '@campus/application-contracts';
import type { DelegatedCredential } from '@campus/google-connection';

/** The Google scope that the write-access check mints, from section 4.1. */
export const DEVICE_WRITE_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.device.chromeos';

/** The projection before any check ran, from section 2.7. */
export const UNCHECKED_WRITE_ACCESS: DeviceWriteAccessState = Object.freeze({
  state: 'unchecked',
  scope: null,
  failure: null,
  checkedAt: null,
});

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

const unavailableClient: DeviceWriteClientFactory = async () => {
  throw new Error('No device write client is configured.');
};

function emptyAccess(): DeviceWriteAccessState {
  return {} as DeviceWriteAccessState;
}

/** Stub: the check and the cache projection are not implemented yet. */
export class DeviceWriteAccess {
  constructor(
    _store: DeviceWriteAccessStore,
    _getClient: DeviceWriteClientFactory = unavailableClient,
  ) {}

  async read(
    _session: SessionResponse,
    _context: DeviceWriteAccessContext,
  ): Promise<DeviceWriteAccessState> {
    return emptyAccess();
  }

  async check(
    _session: SessionResponse,
    _context: DeviceWriteAccessContext,
  ): Promise<DeviceWriteAccessState> {
    return emptyAccess();
  }
}
