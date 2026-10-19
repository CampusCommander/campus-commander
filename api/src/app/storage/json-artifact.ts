import { createHash, randomUUID } from 'node:crypto';

export interface ArtifactWriter {
  stage(
    manifest: {
      artifactId: string;
      attemptId: string;
      schemaVersion: number;
      expectedSizeBytes: number;
      expectedSha256: string;
    },
    source: Buffer[],
  ): Promise<unknown>;
  publish(descriptor: unknown): Promise<unknown>;
}

/** Store one JSON document through the artifact store and return its artifact ID. */
export async function storeJsonDocument(
  store: ArtifactWriter,
  document: unknown,
): Promise<string> {
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  const manifest = {
    artifactId: randomUUID(),
    attemptId: randomUUID(),
    schemaVersion: 1,
    expectedSizeBytes: bytes.length,
    expectedSha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const descriptor = await store.stage(manifest, [bytes]);
  await store.publish(descriptor);
  return manifest.artifactId;
}
