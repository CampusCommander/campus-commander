import type {
  DeviceSyncState,
  DeviceWriteAccess,
  SessionResponse,
} from '@campus/application-contracts';
import type { DeviceUpdateAuthorizer } from './device-updates-actions';
import type { DeviceWriteAccessContext } from './device-write-access';

export interface WriteAccessDevices {
  sync(session: SessionResponse): Promise<DeviceSyncState | null>;
}

export interface WriteAccessProjection {
  read(
    session: SessionResponse,
    context: DeviceWriteAccessContext,
  ): Promise<DeviceWriteAccess>;
  check(
    session: SessionResponse,
    context: DeviceWriteAccessContext,
  ): Promise<DeviceWriteAccess>;
}

/** Stub: the access routes are not implemented yet. */
export class DeviceWriteAccessRoutes {
  constructor(
    _devices: WriteAccessDevices,
    _auth: DeviceUpdateAuthorizer,
    _access: WriteAccessProjection,
  ) {}

  async read(
    _session: SessionResponse,
    _correlationId: string,
  ): Promise<DeviceWriteAccess> {
    return {} as DeviceWriteAccess;
  }

  async check(
    _session: SessionResponse,
    _correlationId: string,
  ): Promise<DeviceWriteAccess> {
    return {} as DeviceWriteAccess;
  }
}
