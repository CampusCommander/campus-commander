import {
  GoogleDeviceReader,
  GoogleUserReader,
} from '@campus/google-connection';
import type { EntityReader } from './entity-sync';

/**
 * The production readers of one refresh batch, dispatched by the job entity type (document A
 * section 5). The readers take an optional renewal callback per multipart round, so a quota wave
 * keeps the batch claim alive.
 */
export function createEntityReader(
  devices: Pick<
    GoogleDeviceReader,
    'deviceBatch' | 'batteryBatch'
  > = new GoogleDeviceReader(),
  users: Pick<GoogleUserReader, 'users'> = new GoogleUserReader(),
): EntityReader {
  return {
    deviceBatch: (credential, customerId, ids, signal, onRound) =>
      devices.deviceBatch(credential, customerId, ids, signal, onRound),
    batteryBatch: (credential, customerId, ids, signal) =>
      devices.batteryBatch(credential, customerId, ids, signal),
    userBatch: (credential, customerId, ids, signal, onRound) =>
      users.users(credential, customerId, ids, signal, onRound),
  };
}
