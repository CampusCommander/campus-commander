import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';

/**
 * The store client of the export worker (design section 4, "Worker access"). The worker imports
 * the store module as the API does (`api/src/app/storage/storage.service.ts`), because its
 * container mounts the artifacts volume (`docker-compose.yml`). The handler sees only the three
 * calls it makes, so a test supplies a fake store.
 */

/** The retention of an export file (design section 4). */
export const DEVICE_EXPORT_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

/** One streamed stage. The size and the digest are computed while the chunks arrive. */
export interface DeviceExportStreamManifest {
  /** The payload version of the file. */
  schemaVersion: number;
  /** The largest accepted file. The store stops above it and removes the partial file. */
  maxBytes: number;
}

export interface DeviceExportDescriptor {
  artifactId: string;
  attemptId: string;
  schemaVersion: number;
  sizeBytes: number;
  sha256: string;
  /** The instant the store removes the file. The export finish records it. */
  expiresAt: string;
}

export interface DeviceExportStore {
  stageStream(
    manifest: DeviceExportStreamManifest,
    source: AsyncIterable<Buffer>,
  ): Promise<DeviceExportDescriptor>;
  publish(descriptor: DeviceExportDescriptor): Promise<unknown>;
  remove(descriptor: {
    artifactId: string;
    attemptId: string;
  }): Promise<boolean>;
  close(): Promise<void>;
}

interface ArtifactStore {
  stageStream(
    manifest: DeviceExportStreamManifest & { retentionUntil: string },
    source: AsyncIterable<Buffer>,
  ): Promise<Omit<DeviceExportDescriptor, 'expiresAt'>>;
  publish(descriptor: unknown): Promise<unknown>;
  remove(descriptor: {
    artifactId: string;
    attemptId: string;
  }): Promise<boolean>;
  close(): Promise<void>;
}

interface StorageModule {
  createArtifactStore(options: {
    pool: Pool;
    root: string;
    backend: string;
  }): Promise<ArtifactStore>;
}

export interface DeviceExportStoreOptions {
  pool: Pool;
  /** The artifacts directory of the deployment configuration. */
  location: string;
  backend: string;
}

/**
 * The store of one worker process. The retention deadline is computed here, so the stage and the
 * finish record the same expiry (design section 4).
 */
export async function createDeviceExportStore(
  options: DeviceExportStoreOptions,
): Promise<DeviceExportStore> {
  const url = pathToFileURL(
    resolve(process.cwd(), 'deployment/storage/index.mjs'),
  ).href;
  const module = (await import(/* webpackIgnore: true */ url)) as StorageModule;
  const store = await module.createArtifactStore({
    pool: options.pool,
    root: options.location,
    backend: options.backend,
  });
  return {
    async stageStream(manifest, source) {
      const expiresAt = new Date(
        Date.now() + DEVICE_EXPORT_RETENTION_DAYS * DAY_MS,
      ).toISOString();
      const descriptor = await store.stageStream(
        { ...manifest, retentionUntil: expiresAt },
        source,
      );
      return { ...descriptor, expiresAt };
    },
    publish: (descriptor) => store.publish(descriptor),
    remove: (descriptor) => store.remove(descriptor),
    close: () => store.close(),
  };
}
