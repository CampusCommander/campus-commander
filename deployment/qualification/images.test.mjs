import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { qualificationImages } from './images.mjs';

test('qualification inventories require all three immutable application images', () => {
  const fallback = Object.fromEntries(
    ['frontend', 'api', 'worker'].map((name) => [
      name,
      `localhost:15000/example/${name}@sha256:${'a'.repeat(64)}`,
    ]),
  );
  assert.deepEqual(qualificationImages(fallback, ''), fallback);
  const root = mkdtempSync(join(tmpdir(), 'cc-qualification-images-'));
  const path = join(root, 'release.json');
  try {
    const images = {
      frontend: fallback.frontend,
      api: fallback.api.replace('a'.repeat(64), 'b'.repeat(64)),
      workers: fallback.worker,
    };
    writeFileSync(path, JSON.stringify({ images }));
    assert.deepEqual(qualificationImages(fallback, path), {
      frontend: images.frontend,
      api: images.api,
      worker: images.workers,
    });
    for (const invalid of [
      null,
      {},
      { images: { ...images, workers: undefined } },
      { images: { ...images, api: 'example/api:latest' } },
      { images: { ...images, api: 'https://user:secret@example/api' } },
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      assert.throws(
        () => qualificationImages(fallback, path),
        /^Error: Qualification requires immutable frontend, API, and worker image references\.$/,
      );
    }
    writeFileSync(path, 'invalid json');
    assert.throws(
      () => qualificationImages(fallback, path),
      /^Error: Cannot read the qualification release inventory\.$/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
