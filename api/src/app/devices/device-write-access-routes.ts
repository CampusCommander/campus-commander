import type {
  DeviceSyncState,
  DeviceWriteAccess,
  SessionResponse,
} from '@campus/application-contracts';
import type { DeviceUpdateAuthorizer } from './device-updates-actions';
import {
  UNCHECKED_WRITE_ACCESS,
  type DeviceWriteAccessContext,
} from './device-write-access';

/** The one action that the write-access routes require, from section 2.1. */
export const WRITE_ACCESS_ACTION = 'devices:write';

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

/**
 * The access state of the connected customer. A caller without devices:write
 * receives 403. A caller without a connection reads unchecked.
 */
export class DeviceWriteAccessRoutes {
  private readonly devices: WriteAccessDevices;
  private readonly auth: DeviceUpdateAuthorizer;
  private readonly access: WriteAccessProjection;

  constructor(
    devices: WriteAccessDevices,
    auth: DeviceUpdateAuthorizer,
    access: WriteAccessProjection,
  ) {
    this.devices = devices;
    this.auth = auth;
    this.access = access;
  }

  async read(
    session: SessionResponse,
    correlationId: string,
  ): Promise<DeviceWriteAccess> {
    const context = await this.context(session, correlationId);
    if (!context) return UNCHECKED_WRITE_ACCESS;
    return this.access.read(session, context);
  }

  async check(
    session: SessionResponse,
    correlationId: string,
  ): Promise<DeviceWriteAccess> {
    const context = await this.context(session, correlationId);
    if (!context) return UNCHECKED_WRITE_ACCESS;
    return this.access.check(session, context);
  }

  /** Read the connection, then require devices:write at its district scope. */
  private async context(
    session: SessionResponse,
    correlationId: string,
  ): Promise<DeviceWriteAccessContext | null> {
    const sync = await this.devices.sync(session);
    if (!sync) return null;
    await this.auth.authorize(
      session,
      WRITE_ACCESS_ACTION,
      { kind: 'district', customerId: sync.customerId },
      correlationId,
    );
    return { customerId: sync.customerId, generation: sync.generation };
  }
}
