import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CacheModule } from '../cache/cache.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DatabaseModule } from '../database/database.module';
import { JobServiceModule } from '../jobs/job-service.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { StorageModule } from '../storage/storage.module';
import { DeviceEventsService } from './device-events.service';
import {
  DeviceCommandsController,
  DeviceStatusChangesController,
} from './device-actions.controller';
import { DeviceActionsService } from './device-actions.service';
import { DeviceUpdatesController } from './device-updates.controller';
import { DeviceUpdatesService } from './device-updates.service';
import { DeviceWriteAccessService } from './device-write-access.service';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  imports: [
    AuthModule,
    CacheModule,
    ConfigurationModule,
    DatabaseModule,
    JobServiceModule,
    OrchestrationModule,
    StorageModule,
  ],
  controllers: [
    DeviceUpdatesController,
    DeviceCommandsController,
    DeviceStatusChangesController,
    DevicesController,
  ],
  providers: [
    DevicesService,
    DeviceEventsService,
    DeviceUpdatesService,
    DeviceActionsService,
    DeviceWriteAccessService,
  ],
  // One subscriber connection serves the devices stream and the jobs stream.
  exports: [DeviceEventsService],
})
export class DevicesModule {}
