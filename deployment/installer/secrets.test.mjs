import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareSecrets } from './secrets.mjs';

test('interrupted setup resumes without changing active service credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc16-secrets-'));
  const config = JSON.parse(
    await readFile('deployment/examples/all-docker.json', 'utf8'),
  );
  try {
    const created = await prepareSecrets(config, root);
    assert.ok(created.every((item) => item.status === 'created'));
    const initial = await Promise.all(
      (await readdir(root)).map(async (name) => [
        name,
        await readFile(join(root, name), 'utf8'),
      ]),
    );
    const resumed = await prepareSecrets(config, root);
    assert.ok(resumed.every((item) => item.status === 'preserved'));
    for (const [name, value] of initial)
      assert.equal(await readFile(join(root, name), 'utf8'), value);
    assert.equal(
      new Set(initial.map(([, value]) => value)).size,
      initial.length,
    );
    config.services.redis.passwordSecretRef =
      config.services.workers.dispatchSecretRef;
    await assert.rejects(
      prepareSecrets(config, root),
      /distinct credential references/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
