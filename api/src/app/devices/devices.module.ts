import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CacheModule } from '../cache/cache.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DatabaseModule } from '../database/database.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { StorageModule } from '../storage/storage.module';
import { DeviceEventsService } from './device-events.service';
import { DeviceUpdatesController } from './device-updates.controller';
import { DeviceUpdatesService } from './device-updates.service';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  imports: [
    AuthModule,
    CacheModule,
    ConfigurationModule,
    DatabaseModule,
    OrchestrationModule,
    StorageModule,
  ],
  controllers: [DeviceUpdatesController, DevicesController],
  providers: [DevicesService, DeviceEventsService, DeviceUpdatesService],
})
export class DevicesModule {}
