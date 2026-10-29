import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { JobService } from '../jobs/job-service';
import { StorageService } from '../storage/storage.service';
import { DeviceImportExecute } from './device-import-execute';

@Injectable()
export class DeviceImportExecuteService extends DeviceImportExecute {
  constructor(
    database: DatabaseService,
    storage: StorageService,
    jobs: JobService,
  ) {
    super(database, storage, jobs);
  }
}