import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256, verifyReleaseFiles } from './integrity.mjs';

/** Bind qualification to the extracted inventory after external signature verification. */
export async function loadQualificationBundle(
  root,
  { images, sourceRevision },
) {
  const directory = resolve(root);
  const bytes = await readFile(join(directory, 'release-manifest.json'));
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.phase, 2);
  assert.equal(manifest.sourceRevision, sourceRevision);
  assert.deepEqual(manifest.images, images);
  assert.deepEqual(manifest.architectures, ['linux/amd64']);
  await verifyReleaseFiles(directory, manifest);
  return { root: directory, manifest, manifestSha256: sha256(bytes) };
}
