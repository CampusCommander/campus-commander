import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { StorageService } from '../storage/storage.service';
import { DeviceImports } from './device-imports';

@Injectable()
export class DeviceImportsService extends DeviceImports {
  constructor(
    database: DatabaseService,
    storage: StorageService,
    orchestration: OrchestrationService,
  ) {
    super(database, storage, orchestration);
  }
}
