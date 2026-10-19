import { Injectable } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { DeviceUpdates } from './device-updates';

@Injectable()
export class DeviceUpdatesService extends DeviceUpdates {
  constructor(
    database: DatabaseService,
    cache: CacheService,
    storage: StorageService,
  ) {
    super(database, cache, storage);
  }
}