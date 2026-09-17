import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { checkServerIdentity } from 'node:tls';
import {
  parseDeploymentConfig,
  type DeploymentConfig,
  type SecretReference,
} from 'deployment';
import {
  CredentialCipher,
  GoogleConnectionProvider,
  type GoogleReadRequest,
} from '@campus/google-connection';

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

  async read(input: GoogleReadRequest, signal: AbortSignal) {
    let cipher: CredentialCipher;
    let key: Buffer | undefined;
    try {
      const path = process.env['CC_CONFIG_FILE'];
      if (!path) throw new Error();
      this.config ??= parseDeploymentConfig(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      const google = this.config.googleConnection;
      if (this.config.phase !== 3 || !google) throw new Error();
      key = secret(google.encryptionKeySecretRef);
      const additionalKeys: { keyId: string; key: Buffer }[] = [];
      try {
        for (const entry of google.additionalKeys ?? []) {
          try {
            const material = secret(entry.encryptionKeySecretRef);
            if (material.length === 32)
              additionalKeys.push({ keyId: entry.keyId, key: material });
            else material.fill(0);
          } catch {
            /* Requests for an unavailable additional key fail without fallback. */
          }
        }
        cipher = new CredentialCipher(google.keyId, key, additionalKeys);
      } finally {
        for (const entry of additionalKeys) entry.key.fill(0);
      }
    } catch {
      throw new Error('connection-key-unavailable');
    } finally {
      key?.fill(0);
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
    return new GoogleConnectionProvider(this.pool, cipher).read(input, signal);
  }

  async close() {
    await this.pool?.end();
  }
}
