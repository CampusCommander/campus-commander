import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { storeJsonDocument } from './json-artifact.ts';

test('a JSON document stages its exact size and digest', async () => {
  const staged = [];
  const store = {
    async stage(manifest, source) {
      const bytes = Buffer.concat(source);
      assert.equal(manifest.expectedSizeBytes, bytes.length);
      assert.equal(
        manifest.expectedSha256,
        createHash('sha256').update(bytes).digest('hex'),
      );
      staged.push(manifest);
      return {
        artifactId: manifest.artifactId,
        attemptId: manifest.attemptId,
        schemaVersion: manifest.schemaVersion,
        sizeBytes: bytes.length,
        sha256: manifest.expectedSha256,
      };
    },
    async publish(descriptor) {
      assert.equal(descriptor.sha256, staged[0].expectedSha256);
    },
  };
  const artifactId = await storeJsonDocument(store, { hello: 'world' });
  assert.equal(artifactId, staged[0].artifactId);
  assert.equal(staged.length, 1);
});

test('a JSON document never falls back to the streamed stage', async () => {
  const store = {
    async stageStream() {
      throw new Error('The streamed stage has no declared digest.');
    },
  };
  await assert.rejects(storeJsonDocument(store, { hello: 'world' }), TypeError);
});
