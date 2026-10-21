import { Injectable } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { DeviceActions } from './device-actions';

@Injectable()
export class DeviceActionsService extends DeviceActions {
  constructor(
    database: DatabaseService,
    cache: CacheService,
    storage: StorageService,
  ) {
    super(database, cache, storage);
  }
}
