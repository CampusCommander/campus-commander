import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAllDocker } from './prepare.mjs';

test('local PostgreSQL admin files reject line endings without changing stored credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-prepare-admin-'));
  const config = new URL('../../examples/all-docker.json', import.meta.url);
  try {
    await prepareAllDocker(config, root);
    for (const name of [
      'application-postgres-admin-password',
      'kestra-postgres-admin-password',
    ]) {
      const path = join(root, 'private', name);
      const original = await readFile(path);
      assert.ok(!original.includes(10) && !original.includes(13));
      for (const delimiter of ['\n', '\r\n']) {
        const invalid = Buffer.concat([original, Buffer.from(delimiter)]);
        await writeFile(path, invalid);
        await assert.rejects(
          prepareAllDocker(config, root),
          /without CR or LF/,
        );
        assert.deepEqual(await readFile(path), invalid);
      }
      await writeFile(path, original);
    }
    await prepareAllDocker(config, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
