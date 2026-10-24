import { Injectable } from '@nestjs/common';
import { GoogleDeviceReader } from '@campus/google-connection';
import { DatabaseService } from '../database/database.service';
import { DeviceFreshRead } from './device-fresh-read';
import { DeviceWriteAccessService } from './device-write-access.service';

/** The edit route's fresh read: the API's Postgres client, the write credential, and Google. */
@Injectable()
export class DeviceFreshReadService extends DeviceFreshRead {
  constructor(database: DatabaseService, access: DeviceWriteAccessService) {
    const reader = new GoogleDeviceReader();
    super(database, {
      credential: (session, context) => access.credential(session, context),
      read: (credential, customerId, ids, signal) =>
        reader.deviceBatch(credential, customerId, ids, signal),
    });
  }
}
