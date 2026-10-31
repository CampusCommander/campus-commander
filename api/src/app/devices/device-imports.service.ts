import { Injectable } from '@nestjs/common';
import { DriveService } from '../drive/drive.service';
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
    drive: DriveService,
  ) {
    super(database, storage, orchestration, drive);
  }
}
