import type { DeviceUpdateMode } from '@campus/application-contracts';

export const MAX_PREVIEW_TARGETS = 100_000;

export interface PreviewTarget {
  ordinal: number;
  deviceId: string;
  serialNumber: string;
  orgUnitPath: string;
  observedValue: string | null;
  observedAt: string | null;
  disposition: 'eligible' | 'unchanged' | 'excluded';
  exclusionReason: string | null;
}

export function previewTargets(
  _rows: readonly Record<string, unknown>[],
  _mode: DeviceUpdateMode,
  _value: string | null,
): PreviewTarget[] {
  return [];
}

export function manifestDigest(
  _mode: DeviceUpdateMode,
  _value: string | null,
  _targets: readonly PreviewTarget[],
): string {
  return '';
}

export function displayNumber(_prefix: 'PV' | 'UPD', _number: number): string {
  return '';
}

/** The preview and confirmation service. Its methods land with the implementation card. */
export class DeviceUpdates {
  readonly database: unknown;
  readonly cache: unknown;
  readonly storage: unknown;

  constructor(database: unknown, cache: unknown, storage: unknown) {
    this.database = database;
    this.cache = cache;
    this.storage = storage;
  }

  async preview(..._args: unknown[]): Promise<never> {
    throw new Error('B3 is not implemented.');
  }

  async previewById(..._args: unknown[]): Promise<never> {
    throw new Error('B3 is not implemented.');
  }

  async targets(..._args: unknown[]): Promise<never> {
    throw new Error('B3 is not implemented.');
  }

  async confirm(..._args: unknown[]): Promise<never> {
    throw new Error('B3 is not implemented.');
  }
}