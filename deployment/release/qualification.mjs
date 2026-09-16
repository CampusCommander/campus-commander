import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256, verifyReleaseFiles } from './integrity.mjs';

/** Bind qualification to the extracted inventory after external signature verification. */
export async function loadQualificationBundle(
  root,
  { images, sourceRevision, phase = 2 },
) {
  const directory = resolve(root);
  const bytes = await readFile(join(directory, 'release-manifest.json'));
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(
    [2, 3].includes(phase),
    'Select an application qualification phase.',
  );
  assert.equal(manifest.phase, phase);
  assert.equal(manifest.sourceRevision, sourceRevision);
  assert.deepEqual(manifest.images, images);
  assert.deepEqual(manifest.architectures, ['linux/amd64']);
  await verifyReleaseFiles(directory, manifest);
  return { root: directory, manifest, manifestSha256: sha256(bytes) };
}
