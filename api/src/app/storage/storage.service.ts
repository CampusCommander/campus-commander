import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { ConfigurationService } from '../configuration/configuration.service';
import { DatabaseService } from '../database/database.service';

interface ArtifactManifest {
  artifactId: string;
  attemptId: string;
  schemaVersion: number;
  expectedSizeBytes: number;
  expectedSha256: string;
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
export class StorageService implements OnApplicationShutdown {
  private store?: Promise<ArtifactStore>;
  constructor(
    private readonly configuration: ConfigurationService,
    private readonly database: DatabaseService,
  ) {}

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
    await (await this.store?.catch(() => undefined))?.close();
  }
}
