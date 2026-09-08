import { Inject, Injectable } from '@nestjs/common';
import type { StartupRuntime } from '../startup-runtime.contract';

export type ReadinessStatus = 'ready' | 'not-ready';

export interface ReadinessCheckResult {
  name: string;
  status: ReadinessStatus;
}

export interface ReadinessCheck {
  check():
    | Promise<ReadinessCheckResult | ReadinessCheckResult[]>
    | ReadinessCheckResult;
}

export interface ReadinessResponse {
  service: 'api';
  status: ReadinessStatus;
  checks: ReadinessCheckResult[];
}

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

export const processReadinessCheck: ReadinessCheck = {
  check: () => ({ name: 'process-started', status: 'ready' }),
};

export function createReadinessChecks(
  runtime: StartupRuntime | undefined,
): ReadinessCheck[] {
  return [
    processReadinessCheck,
    ...(runtime
      ? [
          {
            check: async () => (await runtime.getStatus()).checks,
          } satisfies ReadinessCheck,
        ]
      : []),
  ];
}

@Injectable()
export class ReadinessService {
  constructor(
    @Inject(READINESS_CHECKS)
    private readonly checks: readonly ReadinessCheck[],
  ) {}

  async check(): Promise<ReadinessResponse> {
    const results = await Promise.all(
      this.checks.map(async (check) => {
        try {
          return await check.check();
        } catch {
          return { name: 'unavailable-check', status: 'not-ready' } as const;
        }
      }),
    );

    const checks = results.flat();
    return {
      service: 'api',
      status: checks.every(({ status }) => status === 'ready')
        ? 'ready'
        : 'not-ready',
      checks,
    };
  }
}
