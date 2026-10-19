import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  deviceWriteAccessSchema,
  googleCustomerIdSchema,
  type DeviceWriteAccess as DeviceWriteAccessState,
  type SessionResponse,
} from '@campus/application-contracts';
import {
  CredentialError,
  loadCredentialCipher,
  type CredentialCipher,
  type DelegatedCredential,
} from '@campus/google-connection';
import type { SecretReference } from 'deployment';
import { randomUUID } from 'node:crypto';
import type { CacheService } from '../cache/cache.service';
import type { ConfigurationService } from '../configuration/configuration.service';
import type { DatabaseService } from '../database/database.service';
import {
  DEVICE_WRITE_ACCESS_INTERVAL_SECONDS,
  type DeviceWriteAccessContext,
  type DeviceWriteAccessStore,
} from './device-write-access';

/** The credential projection of one write check. The envelope stays encrypted. */
const credentialClaimSchema = z.strictObject({
  customerId: z.string(),
  generation: z.number().int().positive(),
  credentialId: z.uuid(),
  envelope: z.unknown(),
});
type CredentialClaim = z.infer<typeof credentialClaimSchema>;

/** The connection row that cc.device_writer returns. Null means no connection. */
const writeConnectionSchema = z.object({
  customer_id: z.string().nullable(),
  generation: z.number().int().nullable(),
});

/** The key set that encrypts the stored Google credential. */
export interface WriteAccessCipherConfig {
  keyId: string;
  encryptionKeySecretRef: SecretReference;
  additionalKeys?: readonly {
    keyId: string;
    encryptionKeySecretRef: SecretReference;
  }[];
}

/** Build one cipher from the deployment key set. A test replaces it. */
export type WriteAccessCipherLoader = (
  config: WriteAccessCipherConfig,
  read: (reference: SecretReference) => Buffer,
) => CredentialCipher;

function cacheKey(context: DeviceWriteAccessContext): string {
  return `cc:device-write-access:${context.customerId}:${context.generation}`;
}

function busyKey(context: DeviceWriteAccessContext): string {
  return `cc:device-write-access-busy:${context.customerId}:${context.generation}`;
}

/**
 * Resolve the connected customer through cc.device_writer. The function requires
 * devices:write and reads no credential. Null means no connection.
 */
export function createWriteAccessConnection(database: DatabaseService) {
  return async (
    session: SessionResponse,
  ): Promise<DeviceWriteAccessContext | null> => {
    let row: unknown;
    try {
      row = (
        await database.connection.query(
          'SELECT customer_id,generation FROM cc.device_writer($1,$2)',
          [session.identity.id, session.identity.permissionVersion],
        )
      ).rows[0];
    } catch (error) {
      const parsed = z.object({ code: z.string() }).safeParse(error);
      if (parsed.success && parsed.data.code === '42501')
        throw new ForbiddenException({ reason: 'forbidden' });
      throw new ServiceUnavailableException({
        reason: 'device-store-unavailable',
      });
    }
    const parsed = writeConnectionSchema.safeParse(row);
    if (!parsed.success)
      throw new ServiceUnavailableException({
        reason: 'device-store-unavailable',
      });
    if (parsed.data.customer_id === null) return null;
    if (parsed.data.generation === null)
      throw new ServiceUnavailableException({
        reason: 'device-store-unavailable',
      });
    return {
      customerId: googleCustomerIdSchema.parse(parsed.data.customer_id),
      generation: parsed.data.generation,
    };
  };
}

/**
 * Build the store adapter. It owns the store errors, the cipher, and the
 * one-check interval. Every call builds its own cipher from a fresh key read.
 */
export function createDeviceWriteAccessStore(
  database: DatabaseService,
  cache: CacheService,
  configuration: ConfigurationService,
  loadCipher: WriteAccessCipherLoader = loadCredentialCipher,
): DeviceWriteAccessStore {
  const cipher = () => {
    const google = configuration.deployment?.googleConnection;
    if (!google)
      throw new ServiceUnavailableException({
        reason: 'connection-not-configured',
      });
    try {
      return loadCipher(google, (reference) => configuration.secret(reference));
    } catch {
      throw new ServiceUnavailableException({
        reason: 'connection-key-unavailable',
      });
    }
  };
  return {
    async reserve(context: DeviceWriteAccessContext): Promise<boolean> {
      return (
        (await cache.reserve(
          busyKey(context),
          randomUUID(),
          DEVICE_WRITE_ACCESS_INTERVAL_SECONDS,
        )) !== null
      );
    },
    async credential(
      session: SessionResponse,
      context: DeviceWriteAccessContext,
    ): Promise<DelegatedCredential | null> {
      let result: unknown;
      try {
        result = (
          await database.connection.query(
            'SELECT cc.device_write_credential($1,$2,$3,$4) AS result',
            [
              session.identity.id,
              session.identity.permissionVersion,
              context.customerId,
              context.generation,
            ],
          )
        ).rows[0]?.['result'];
      } catch (error) {
        const parsed = z
          .object({ code: z.string(), detail: z.string().optional() })
          .safeParse(error);
        if (parsed.success && parsed.data.code === '42501')
          throw new ForbiddenException({ reason: 'forbidden' });
        if (
          parsed.success &&
          parsed.data.code === 'P0001' &&
          parsed.data.detail === 'credential-changed'
        )
          throw new ConflictException({ reason: 'credential-changed' });
        throw new ServiceUnavailableException({
          reason: 'device-store-unavailable',
        });
      }
      if (result === null || result === undefined) return null;
      const claim: CredentialClaim = credentialClaimSchema.parse(result);
      try {
        return cipher().open(claim.envelope, {
          recordId: claim.credentialId,
          customerId: claim.customerId,
          generation: claim.generation,
        });
      } catch (error) {
        if (error instanceof CredentialError)
          throw new ServiceUnavailableException({
            reason: 'connection-key-unavailable',
          });
        throw error;
      }
    },
    async read(
      context: DeviceWriteAccessContext,
    ): Promise<DeviceWriteAccessState | null> {
      const value = await cache.get(cacheKey(context));
      if (value === null) return null;
      try {
        return deviceWriteAccessSchema.parse(JSON.parse(value));
      } catch {
        return null;
      }
    },
    async write(
      context: DeviceWriteAccessContext,
      access: DeviceWriteAccessState,
      seconds: number,
    ): Promise<void> {
      await cache.set(cacheKey(context), JSON.stringify(access), seconds);
    },
  };
}
