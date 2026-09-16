import {
  Injectable,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { ConfigurationService } from '../configuration/configuration.service';

export type SecurityEvent =
  | 'login-started'
  | 'login-succeeded'
  | 'login-denied'
  | 'logout'
  | 'access-denied'
  | 'session-expired'
  | 'diagnostic-started'
  | 'diagnostic-passed'
  | 'diagnostic-failed'
  | 'preferences-changed';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool?: Pool;

  constructor(configuration: ConfigurationService) {
    const service = configuration.deployment?.services.applicationDatabase;
    if (!service || !configuration.deployment?.applicationAuth) return;
    const url = new URL(service.endpoint.url);
    const tls = service.endpoint.tls;
    this.pool = new Pool({
      host: url.hostname,
      port: Number(url.port || 5432),
      database: service.database,
      user: service.role,
      password: configuration
        .secret(service.passwordSecretRef)
        .toString('utf8')
        .replace(/\r?\n$/, ''),
      ssl:
        tls.mode === 'disabled'
          ? false
          : {
              rejectUnauthorized: true,
              checkServerIdentity: (_hostname, certificate) =>
                checkServerIdentity(url.hostname, certificate),
              ...(tls.mode === 'private-ca'
                ? { ca: configuration.secret(tls.caSecretRef) }
                : {}),
            },
      max: 4,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
      query_timeout: 5000,
      idle_in_transaction_session_timeout: 5000,
      application_name: 'campus-commander-api',
    });
    this.pool.on('error', () => {
      /* Requests report dependency failure without exposing credentials. */
    });
  }

  get connection(): Pool {
    if (!this.pool)
      throw new ServiceUnavailableException(
        'The application database is unavailable.',
      );
    return this.pool;
  }

  async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connection.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async audit(
    event: SecurityEvent,
    correlationId: string,
    actorId?: string,
    detail?: string,
    client: Pool | PoolClient = this.connection,
  ) {
    await client.query(
      'INSERT INTO cc.security_events (id,actor_id,event,correlation_id,detail) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), actorId ?? null, event, correlationId, detail ?? null],
    );
  }

  async onApplicationShutdown() {
    await this.pool?.end();
  }
}
