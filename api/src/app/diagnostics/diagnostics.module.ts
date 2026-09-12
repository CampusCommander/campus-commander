import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DatabaseModule } from '../database/database.module';
import { CacheModule } from '../cache/cache.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { StorageModule } from '../storage/storage.module';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';

@Module({
  imports: [
    AuthModule,
    ConfigurationModule,
    DatabaseModule,
    CacheModule,
    OrchestrationModule,
    StorageModule,
  ],
  controllers: [DiagnosticsController],
  providers: [DiagnosticsService],
})
export class DiagnosticsModule {}
