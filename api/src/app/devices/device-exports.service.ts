import { Injectable } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { DatabaseService } from '../database/database.service';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { StorageService } from '../storage/storage.service';
import { DeviceExports } from './device-exports';

@Injectable()
export class DeviceExportsService extends DeviceExports {
  constructor(
    database: DatabaseService,
    cache: CacheService,
    storage: StorageService,
    orchestration: OrchestrationService,
  ) {
    super(database, cache, storage, orchestration);
  }
}
