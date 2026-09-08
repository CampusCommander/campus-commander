import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { StartupRuntime } from './startup-runtime.contract';

export const STARTUP_RUNTIME = Symbol('STARTUP_RUNTIME');

@Injectable()
export class StartupRuntimeLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(STARTUP_RUNTIME)
    private readonly runtime: StartupRuntime | undefined,
  ) {}

  async onApplicationShutdown() {
    await this.runtime?.close();
  }
}
