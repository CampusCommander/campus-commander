import { HttpException, Injectable } from '@nestjs/common';
import type {
  DependencyHealth,
  DiagnosticOperation,
  DiagnosticResult,
} from '@campus/application-contracts';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { CacheService } from '../cache/cache.service';
import { StorageService } from '../storage/storage.service';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { ServiceTimeoutError } from '../configuration/service-http';

@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly cache: CacheService,
    private readonly storage: StorageService,
    private readonly orchestration: OrchestrationService,
  ) {}

  async health(): Promise<DependencyHealth> {
    const probes = [
      [
        'PostgreSQL',
        () => this.database.connection.query('SELECT 1').then(() => true),
      ],
      ['Redis', () => this.cache.get('cc:diagnostics:health').then(() => true)],
      ['Kestra', () => this.orchestration.healthy()],
      ['Artifact storage', () => this.storage.healthy()],
    ] as const;
    const checks = await Promise.all(
      probes.map(async ([name, probe]) => {
        try {
          return {
            name,
            status: (await probe())
              ? ('ready' as const)
              : ('not-ready' as const),
          };
        } catch {
          return { name, status: 'not-ready' as const };
        }
      }),
    );
    return {
      status: checks.every((check) => check.status === 'ready')
        ? 'ready'
        : 'not-ready',
      observedAt: new Date().toISOString(),
      checks,
    };
  }

  async run(
    operation: DiagnosticOperation,
    actorId: string,
    correlationId: string,
  ): Promise<DiagnosticResult> {
    const reservation = 'cc:diagnostics:reservation';
    if (!(await this.cache.reserve(reservation, correlationId, 60)))
      throw new HttpException('A diagnostic check is already running.', 429);
    try {
      return await this.execute(operation, actorId, correlationId);
    } finally {
      await this.cache.release(reservation, correlationId);
    }
  }

  private async execute(
    operation: DiagnosticOperation,
    actorId: string,
    correlationId: string,
  ): Promise<DiagnosticResult> {
    await this.database.audit(
      'diagnostic-started',
      correlationId,
      actorId,
      operation,
    );
    let status: DiagnosticResult['status'] = 'passed';
    let message = 'The check passed. The service returned the expected result.';
    try {
      if (operation === 'postgresql')
        await this.postgresql(actorId, correlationId);
      else if (operation === 'redis') await this.redis(correlationId);
      else if (operation === 'kestra')
        await this.orchestration.check(correlationId);
      else await this.storage.check(correlationId);
    } catch (error) {
      status = error instanceof ServiceTimeoutError ? 'timed-out' : 'failed';
      message =
        error instanceof ServiceTimeoutError
          ? 'The service did not respond before the time limit. Check its connection and retry.'
          : 'The check failed. Inspect the service configuration and retry.';
    }
    await this.database.audit(
      status === 'passed' ? 'diagnostic-passed' : 'diagnostic-failed',
      correlationId,
      actorId,
      operation,
    );
    return {
      operation,
      status,
      message,
      correlationId,
      observedAt: new Date().toISOString(),
    };
  }

  private async postgresql(actorId: string, correlationId: string) {
    const client = await this.database.connection.connect();
    const marker = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO cc.security_events(id,actor_id,event,correlation_id,detail) VALUES($1,$2,'diagnostic-started',$3,'transaction-fixture')",
        [marker, actorId, correlationId],
      );
      const result = await client.query(
        'SELECT id FROM cc.security_events WHERE id=$1',
        [marker],
      );
      if (result.rows[0]?.id !== marker)
        throw new Error('Transaction verification failed.');
      await client.query('ROLLBACK');
      if (
        (
          await client.query('SELECT id FROM cc.security_events WHERE id=$1', [
            marker,
          ])
        ).rowCount
      )
        throw new Error('Transaction rollback failed.');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  private async redis(correlationId: string) {
    const key = `cc:diagnostics:fixture:${correlationId}`;
    try {
      await this.cache.set(key, correlationId, 60);
      if ((await this.cache.get(key)) !== correlationId)
        throw new Error('Redis verification failed.');
    } finally {
      await this.cache.remove(key);
    }
  }
}
