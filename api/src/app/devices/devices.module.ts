import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CacheModule } from '../cache/cache.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DatabaseModule } from '../database/database.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  imports: [
    AuthModule,
    CacheModule,
    ConfigurationModule,
    DatabaseModule,
    OrchestrationModule,
  ],
  controllers: [DevicesController],
  providers: [DevicesService],
})
export class DevicesModule {}
