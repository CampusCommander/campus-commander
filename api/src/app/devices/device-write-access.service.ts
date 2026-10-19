import { Injectable } from '@nestjs/common';
import { DeviceWriteAccess } from './device-write-access';

/** Stub: the store adapter is not implemented yet. */
@Injectable()
export class DeviceWriteAccessService extends DeviceWriteAccess {
  constructor() {
    super({
      credential: async () => null,
      read: async () => null,
      write: async () => undefined,
    });
  }
}
