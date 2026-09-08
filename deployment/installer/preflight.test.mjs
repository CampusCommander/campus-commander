import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyDockerFilesystem } from './preflight.mjs';

for (const visible of [true, false]) {
  test(`Docker filesystem probe ${visible ? 'accepts the same filesystem' : 'rejects a different filesystem'} and removes its marker`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-daemon-path-'));
    try {
      const run = async (file, args) => {
        assert.equal(file, 'docker');
        assert.ok(args.includes('--network=none'));
        const mount = args[args.indexOf('--mount') + 1];
        const path = /source=([^,]+)/.exec(mount)[1];
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal(await readFile(path, 'utf8'), args.at(-1));
        assert.ok(mount.endsWith(',readonly'));
        if (!visible) throw new Error('bind source path does not exist');
      };
      if (visible)
        assert.equal(await verifyDockerFilesystem(root, 'fixture', run), true);
      else
        await assert.rejects(
          verifyDockerFilesystem(root, 'fixture', run),
          /bind source/,
        );
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
