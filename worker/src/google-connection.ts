import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { checkServerIdentity } from 'node:tls';
import {
  parseDeploymentConfig,
  type DeploymentConfig,
  type SecretReference,
} from 'deployment';
import {
  type CredentialCipher,
  loadCredentialCipher,
  GoogleConnectionProvider,
  GoogleDeviceReader,
  type GoogleReadRequest,
} from '@campus/google-connection';
import type { EntitySyncBatchRequest } from '@campus/application-contracts';
import { DeviceSync, type DeviceSyncRequest } from './device-sync';
import { WorkerRedis, noEntityCache, type EntityCache } from './entity-cache';
import { EntitySyncBatch } from './entity-sync';

function secret(reference: SecretReference): Buffer {
  const path =
    reference.provider === 'file'
      ? reference.path
      : `/run/secrets/${reference.name}/${reference.key}`;
  const value = readFileSync(path);
  if (!value.length || value.length > 65536)
    throw new Error('connection-key-unavailable');
  return value;
}

/** Keep background Google access independent of browser and API process state. */
export class GoogleWorker {
  private pool?: Pool;
  private config?: DeploymentConfig;
  private redis?: WorkerRedis;

  /** Redis for records, in-flight IDs, and events. The worker user shares the application password. */
  private cache(): WorkerRedis {
    if (this.redis) return this.redis;
    const config = this.config;
    if (!config) throw new Error('connection-store-unavailable');
    const service = config.services.redis;
    const transport = service.endpoint.tls;
    this.redis = new WorkerRedis({
      url: service.endpoint.url,
      password: secret(service.passwordSecretRef).toString('utf8').replace(/\r?\n$/, ''),
      tls:
        transport.mode === 'disabled'
          ? null
          : {
              servername: new URL(service.endpoint.url).hostname,
              ...(transport.mode === 'private-ca' ? { ca: secret(transport.caSecretRef) } : {}),
            },
    });
    return this.redis;
  }

  /** Load the credential key and database pool once per process. */
  private resources(): { pool: Pool; cipher: CredentialCipher } {
    let cipher: CredentialCipher;
    try {
      const path = process.env['CC_CONFIG_FILE'];
      if (!path) throw new Error();
      this.config ??= parseDeploymentConfig(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      const google = this.config.googleConnection;
      if (this.config.phase !== 3 || !google) throw new Error();
      cipher = loadCredentialCipher(google, secret);
    } catch {
      throw new Error('connection-key-unavailable');
    }
    if (!this.pool) {
      try {
        const database = this.config.services.applicationDatabase;
        const url = new URL(database.endpoint.url);
        const tls = database.endpoint.tls;
        this.pool = new Pool({
          host: url.hostname,
          port: Number(url.port || 5432),
          database: database.database,
          user: database.role,
          password: secret(database.passwordSecretRef)
            .toString('utf8')
            .replace(/\r?\n$/, ''),
          ssl:
            tls.mode === 'disabled'
              ? false
              : {
                  rejectUnauthorized: true,
                  checkServerIdentity: (_host, cert) =>
                    checkServerIdentity(url.hostname, cert),
                  ...(tls.mode === 'private-ca'
                    ? { ca: secret(tls.caSecretRef) }
                    : {}),
                },
          max: 4,
          connectionTimeoutMillis: 3000,
          query_timeout: 5000,
          statement_timeout: 5000,
          idle_in_transaction_session_timeout: 5000,
          application_name: 'campus-commander-google-worker',
        });
        this.pool.on('error', () => {
          /* Requests report bounded storage errors. */
        });
      } catch {
        throw new Error('connection-store-unavailable');
      }
    }
    return { pool: this.pool, cipher };
  }

  async read(input: GoogleReadRequest, signal: AbortSignal) {
    const { pool, cipher } = this.resources();
    return new GoogleConnectionProvider(pool, cipher).read(input, signal);
  }

  /** Postgres publishes a full sync. A missing Redis configuration or secret only skips the cache fill. */
  async syncDevices(input: DeviceSyncRequest, signal: AbortSignal) {
    const { pool, cipher } = this.resources();
    let cache: EntityCache;
    try {
      cache = this.cache();
    } catch {
      cache = noEntityCache;
    }
    return new DeviceSync(pool, cipher, new GoogleDeviceReader(), cache).run(
      input,
      signal,
    );
  }

  /** An entity batch requires Redis. A missing cache answers 503 so Kestra retries the batch. */
  async syncEntityBatch(input: EntitySyncBatchRequest, signal: AbortSignal) {
    const { pool, cipher } = this.resources();
    return new EntitySyncBatch(pool, cipher, new GoogleDeviceReader(), this.cache()).run(input, signal);
  }

  async close() {
    await Promise.all([this.pool?.end(), this.redis?.close()]);
  }
}
