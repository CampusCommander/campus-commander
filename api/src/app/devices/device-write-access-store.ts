import type {
  DeviceWriteAccess as DeviceWriteAccessState,
  SessionResponse,
} from '@campus/application-contracts';
import type { DelegatedCredential } from '@campus/google-connection';
import type { SecretReference } from 'deployment';
import type { CacheService } from '../cache/cache.service';
import type { ConfigurationService } from '../configuration/configuration.service';
import type { DatabaseService } from '../database/database.service';
import type {
  DeviceWriteAccessContext,
  DeviceWriteAccessStore,
} from './device-write-access';

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
) => unknown;

/**
 * API-compatible stub on the parent revision. The connected customer stays
 * unresolved, the credential stays closed, and no interval is reserved, so each
 * new store test reaches its assertion and fails there.
 */
export function createWriteAccessConnection(
  _database: DatabaseService,
): (
  session: SessionResponse,
) => Promise<DeviceWriteAccessContext | null> {
  return async () => null;
}

/** The store stub of the parent revision. */
export function createDeviceWriteAccessStore(
  _database: DatabaseService,
  _cache: CacheService,
  _configuration: ConfigurationService,
  _loadCipher?: WriteAccessCipherLoader,
): DeviceWriteAccessStore & {
  reserve(context: DeviceWriteAccessContext): Promise<boolean>;
} {
  return {
    async reserve(): Promise<boolean> {
      return false;
    },
    async credential(): Promise<DelegatedCredential | null> {
      return null;
    },
    async read(): Promise<DeviceWriteAccessState | null> {
      return null;
    },
    async write(): Promise<void> {},
  };
}