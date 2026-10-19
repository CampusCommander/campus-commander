import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DatabaseModule } from '../database/database.module';
import { DevicesModule } from '../devices/devices.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  // DevicesModule exports the one DeviceEventsService subscriber connection of the API instance.
  // ConfigurationModule provides the ConfigurationService that AuthGuard resolves.
  imports: [AuthModule, ConfigurationModule, DatabaseModule, DevicesModule],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}
