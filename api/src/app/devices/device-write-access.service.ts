import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  deviceWriteAccessSchema,
  type DeviceWriteAccess as DeviceWriteAccessState,
  type SessionResponse,
} from '@campus/application-contracts';
import {
  CredentialError,
  loadCredentialCipher,
  type DelegatedCredential,
} from '@campus/google-connection';
import { CacheService } from '../cache/cache.service';
import { ConfigurationService } from '../configuration/configuration.service';
import { DatabaseService } from '../database/database.service';
import {
  DeviceWriteAccess,
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

function cacheKey(context: DeviceWriteAccessContext): string {
  return `cc:device-write-access:${context.customerId}:${context.generation}`;
}

@Injectable()
export class DeviceWriteAccessService extends DeviceWriteAccess {
  constructor(
    database: DatabaseService,
    cache: CacheService,
    configuration: ConfigurationService,
  ) {
    super(store(database, cache, configuration));
  }
}

/** Build the store adapter. It owns the store errors and the cipher. */
function store(
  database: DatabaseService,
  cache: CacheService,
  configuration: ConfigurationService,
): DeviceWriteAccessStore {
  const cipher = () => {
    const google = configuration.deployment?.googleConnection;
    if (!google)
      throw new ServiceUnavailableException({
        reason: 'connection-not-configured',
      });
    try {
      return loadCredentialCipher(google, (reference) =>
        configuration.secret(reference),
      );
    } catch {
      throw new ServiceUnavailableException({
        reason: 'connection-key-unavailable',
      });
    }
  };
  return {
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
