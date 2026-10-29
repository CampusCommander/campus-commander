import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { ConfigurationService } from '../configuration/configuration.service';
import { DatabaseService } from '../database/database.service';
import { purgeExpiredArtifacts, startArtifactPurge } from './artifact-purge';
import { storeJsonDocument } from './json-artifact';

interface ArtifactManifest {
  artifactId: string;
  attemptId: string;
  schemaVersion: number;
  expectedSizeBytes: number;
  expectedSha256: string;
}
interface ArtifactStreamManifest {
  artifactId?: string;
  attemptId?: string;
  schemaVersion: number;
  /** The largest accepted file. The store stops above it and removes the partial file. */
  maxBytes: number;
  /** The number of days to keep the artifact. The store computes `retentionUntil`. */
  retentionDays?: number;
  retentionUntil?: string | null;
}
interface ArtifactDescriptor {
  artifactId: string;
  attemptId: string;
  schemaVersion: number;
  sizeBytes: number;
  sha256: string;
}
interface ArtifactStore {
  checkHealth(): Promise<boolean>;
  stage(
    manifest: ArtifactManifest,
    source: Buffer[],
  ): Promise<ArtifactDescriptor>;
  stageStream(
    manifest: ArtifactStreamManifest,
    source: AsyncIterable<Buffer>,
  ): Promise<ArtifactDescriptor>;
  publish(manifest: ArtifactDescriptor): Promise<unknown>;
  openRead(artifactId: string): Promise<AsyncIterable<Buffer>>;
  remove(manifest: { artifactId: string; attemptId: string }): Promise<boolean>;
  close(): Promise<void>;
}
interface StorageModule {
  createArtifactStore(options: {
    pool: Pool;
    root: string;
    backend: string;
  }): Promise<ArtifactStore>;
}

@Injectable()
export class StorageService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private store?: Promise<ArtifactStore>;
  private stopPurge?: () => void;
  private readonly configuration: ConfigurationService;
  private readonly database: DatabaseService;

  constructor(configuration: ConfigurationService, database: DatabaseService) {
    this.configuration = configuration;
    this.database = database;
  }

  private connection() {
    this.store ??= (async () => {
      const config = this.configuration.deployment;
      if (!config) throw new Error('Storage is not configured.');
      const url = pathToFileURL(
        resolve(process.cwd(), 'deployment/storage/index.mjs'),
      ).href;
      const module = (await import(
        /* webpackIgnore: true */ url
      )) as StorageModule;
      return module.createArtifactStore({
        pool: this.database.connection,
        root: config.artifacts.location,
        backend:
          config.artifacts.kind === 'shared-filesystem'
            ? 'shared-filesystem'
            : 'local',
      });
    })().catch((error: unknown) => {
      this.store = undefined;
      throw error;
    });
    return this.store;
  }

  async healthy() {
    return (await this.connection()).checkHealth();
  }

  /** Store one JSON document as an artifact and publish it. Returns the artifact ID. */
  async storeJson(document: unknown): Promise<string> {
    return storeJsonDocument(await this.connection(), document);
  }

  async check(correlationId: string) {
    const store = await this.connection();
    const bytes = Buffer.from(
      `Campus Commander synthetic artifact ${correlationId}\n`,
    );
    const manifest = {
      artifactId: randomUUID(),
      attemptId: randomUUID(),
      schemaVersion: 1,
      expectedSizeBytes: bytes.length,
      expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    };
    let staged = false;
    let failure: unknown;
    try {
      const descriptor = await store.stage(manifest, [bytes]);
      staged = true;
      await store.publish(descriptor);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of await store.openRead(manifest.artifactId)) {
        size += chunk.length;
        if (size > 1024)
          throw new Error('The artifact exceeded its size limit.');
        chunks.push(chunk);
      }
      if (!Buffer.concat(chunks).equals(bytes))
        throw new Error('Artifact verification failed.');
    } catch (error) {
      failure = error;
    }
    try {
      if (staged) {
        await this.database.connection.query(
          'UPDATE cc.artifacts SET active=false WHERE id=$1 AND attempt_id=$2 AND reference_count=0',
          [manifest.artifactId, manifest.attemptId],
        );
      }
      const removed = await store.remove(manifest);
      if (staged && !removed)
        throw new Error('Synthetic artifact cleanup failed.');
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }

  async onApplicationShutdown() {
    this.stopPurge?.();
    await (await this.store?.catch(() => undefined))?.close();
  }

  onApplicationBootstrap(): void {
    this.stopPurge = startArtifactPurge(() => this.purge());
  }

  /** Remove each artifact whose retention passed. A failed sweep waits for the next hour. */
  private async purge() {
    try {
      const store = await this.connection();
      await purgeExpiredArtifacts(this.database.connection, store);
    } catch {
      // The next hourly sweep retries an unavailable store or database.
    }
  }
}
