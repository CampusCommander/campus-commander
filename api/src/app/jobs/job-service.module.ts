import { Module } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { CacheModule } from '../cache/cache.module';
import { DatabaseService } from '../database/database.service';
import { DatabaseModule } from '../database/database.module';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { JobService } from './job-service';

/**
 * The one job service instance of the API process (design section 6.5). JobsModule hosts its timers.
 * DevicesModule imports it only to trigger admission after a confirmation commits.
 */
@Module({
  imports: [CacheModule, DatabaseModule, OrchestrationModule],
  providers: [
    {
      provide: JobService,
      useFactory: (
        database: DatabaseService,
        cache: CacheService,
        orchestration: OrchestrationService,
      ) => new JobService({ database, cache, orchestration }),
      inject: [DatabaseService, CacheService, OrchestrationService],
    },
  ],
  exports: [JobService],
})
export class JobServiceModule {}
