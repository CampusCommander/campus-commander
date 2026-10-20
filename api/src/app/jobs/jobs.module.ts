import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CacheModule } from '../cache/cache.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DatabaseModule } from '../database/database.module';
import { DevicesModule } from '../devices/devices.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { JobServiceModule } from './job-service.module';
import { JobServiceProcess } from './job-service.process';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  // DevicesModule exports the one DeviceEventsService subscriber connection of the API instance.
  // ConfigurationModule provides the ConfigurationService that AuthGuard resolves.
  imports: [
    AuthModule,
    CacheModule,
    ConfigurationModule,
    DatabaseModule,
    DevicesModule,
    JobServiceModule,
    OrchestrationModule,
  ],
  controllers: [JobsController],
  providers: [JobsService, JobServiceProcess],
})
export class JobsModule {}
