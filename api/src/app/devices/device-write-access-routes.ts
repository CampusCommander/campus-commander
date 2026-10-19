import type {
  DeviceWriteAccess,
  SessionResponse,
} from '@campus/application-contracts';
import { DEVICE_WRITE_ACCESS_BUSY_ANSWER } from '@campus/application-contracts';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import {
  UNCHECKED_WRITE_ACCESS,
  WriteAccessBusyError,
  WriteAccessDeadlineError,
  type DeviceWriteAccessContext,
} from './device-write-access';

/** The port that resolves the connection and answers the cached projection. */
export interface WriteAccessPort {
  /**
   * Resolve the connected customer through cc.device_writer. The function requires
   * devices:write and raises 42501 for every other caller. Null means no connection.
   */
  connection(
    session: SessionResponse,
  ): Promise<DeviceWriteAccessContext | null>;
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
 * The access state of the connected customer. Both routes authorize devices:write
 * through cc.device_writer before they read the connection or the cache.
 */
export class DeviceWriteAccessRoutes {
  private readonly access: WriteAccessPort;

  constructor(access: WriteAccessPort) {
    this.access = access;
  }

  async read(
    session: SessionResponse,
    _correlationId: string,
  ): Promise<DeviceWriteAccess> {
    const context = await this.access.connection(session);
    if (!context) return UNCHECKED_WRITE_ACCESS;
    return this.access.read(session, context);
  }

  async check(
    session: SessionResponse,
    _correlationId: string,
  ): Promise<DeviceWriteAccess> {
    const context = await this.access.connection(session);
    if (!context) return UNCHECKED_WRITE_ACCESS;
    try {
      return await this.access.check(session, context);
    } catch (error) {
      if (error instanceof WriteAccessBusyError)
        throw new HttpException(
          { reason: DEVICE_WRITE_ACCESS_BUSY_ANSWER.reason },
          DEVICE_WRITE_ACCESS_BUSY_ANSWER.status,
        );
      if (error instanceof WriteAccessDeadlineError)
        throw new ServiceUnavailableException({
          reason: 'device-store-unavailable',
        });
      throw error;
    }
  }
}
