import { DynamicModule, Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BootstrapController } from './bootstrap.controller';
import { HealthController } from './health/health.controller';
import {
  createReadinessChecks,
  READINESS_CHECKS,
  ReadinessService,
} from './health/readiness';
import { STARTUP_RUNTIME, StartupRuntimeLifecycle } from './startup-runtime';
import type { StartupRuntime } from './startup-runtime.contract';

@Module({
  imports: [],
  controllers: [AppController, BootstrapController, HealthController],
})
export class AppModule {
  static register(runtime: StartupRuntime | undefined): DynamicModule {
    return {
      module: AppModule,
      providers: [
        AppService,
        ReadinessService,
        StartupRuntimeLifecycle,
        { provide: STARTUP_RUNTIME, useValue: runtime },
        { provide: READINESS_CHECKS, useValue: createReadinessChecks(runtime) },
      ],
      exports: [READINESS_CHECKS, ReadinessService],
    };
  }
}
