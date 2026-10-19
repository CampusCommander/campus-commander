import { Injectable } from '@nestjs/common';
import type { SessionResponse } from '@campus/application-contracts';
import { CacheService } from '../cache/cache.service';
import { ConfigurationService } from '../configuration/configuration.service';
import { DatabaseService } from '../database/database.service';
import {
  DeviceWriteAccess,
  type DeviceWriteAccessContext,
} from './device-write-access';
import {
  createDeviceWriteAccessStore,
  createWriteAccessConnection,
} from './device-write-access-store';
import type { WriteAccessPort } from './device-write-access-routes';

@Injectable()
export class DeviceWriteAccessService
  extends DeviceWriteAccess
  implements WriteAccessPort
{
  private readonly resolve: (
    session: SessionResponse,
  ) => Promise<DeviceWriteAccessContext | null>;

  constructor(
    database: DatabaseService,
    cache: CacheService,
    configuration: ConfigurationService,
  ) {
    super(createDeviceWriteAccessStore(database, cache, configuration));
    this.resolve = createWriteAccessConnection(database);
  }

  /** Resolve the connection through cc.device_writer, which requires devices:write. */
  connection(
    session: SessionResponse,
  ): Promise<DeviceWriteAccessContext | null> {
    return this.resolve(session);
  }
}
