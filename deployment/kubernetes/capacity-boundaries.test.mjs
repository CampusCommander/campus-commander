import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('capacity preparation rejects unqualified fixtures before cluster access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc18-boundary-test-'));
  try {
    for (const fixture of [
      { qualificationOnly: false },
      { qualificationOnly: true, project: 'ordinary-installation' },
      {
        qualificationOnly: true,
        project: 'cc-capacity-kube-012345abcdef',
        root: '/tmp/cc-capacity-kube-fedcba543210-ABCdef',
      },
    ]) {
      const path = join(root, 'fixture.json');
      await writeFile(path, JSON.stringify(fixture));
      const result = spawnSync(
        process.execPath,
        [new URL('./integration.mjs', import.meta.url).pathname],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: '',
            CC_KUBERNETES_CAPACITY_FIXTURE: path,
          },
          timeout: 10000,
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /AssertionError/);
      assert.doesNotMatch(result.stderr, /spawnSync kubectl/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
