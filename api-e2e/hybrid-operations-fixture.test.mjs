import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createHybridOperationsCli } from './hybrid-operations-fixture.mjs';

test('hybrid operator commands reject foreign paths before filesystem or Docker access', async () => {
  const project = 'cc-phase3-hybrid-0123456789ab';
  const root = `/tmp/${project}-test`;
  for (const fields of [
    { controller: { root: '/tmp/unrelated' } },
    { hosts: { shared: '/tmp/unrelated' } },
    { googlePreload: '/tmp/unrelated/preload.cjs' },
    { project: 'unrelated' },
    { controller: { root: `${root}/controller/../../unrelated` } },
    { hosts: { shared: `${root}/shared/../../unrelated` } },
    { hosts: { shared: `/tmp/${project}-different/shared` } },
  ])
    await assert.rejects(
      createHybridOperationsCli({
        project,
        controller: { root: join(root, 'controller') },
        hosts: {
          shared: join(root, 'shared'),
          run: () => assert.fail('Unexpected Docker access.'),
        },
        ...fields,
      }),
    );
});

test('hybrid operator requests keep configuration in private files and reject unsafe commands', async (t) => {
  const project = 'cc-phase3-hybrid-0123456789ab';
  const root = await mkdtemp(`/tmp/${project}-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = { root: join(root, 'controller') };
  await mkdir(controller.root);
  const calls = [];
  const cli = await createHybridOperationsCli({
    project,
    controller,
    hosts: {
      shared: join(root, 'shared'),
      async run(_host, args) {
        calls.push(args);
        const path = args.at(-1);
        const request = JSON.parse(await readFile(path));
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        const config = JSON.parse(await readFile(request.configurationPath));
        assert.equal(config.marker, 'private-configuration-marker');
        assert.equal(
          (await stat(request.configurationPath)).mode & 0o777,
          0o600,
        );
        assert.equal(
          JSON.parse(await readFile(request.releaseInventoryPath)).phase,
          3,
        );
        return JSON.stringify({ status: 'complete' });
      },
    },
  });
  const input = {
    config: { marker: 'private-configuration-marker' },
    release: { phase: 3 },
    backupDirectory: join(root, 'backup'),
  };
  assert.equal((await cli.run('backup', input)).result.status, 'complete');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('/release/deployment/operations/cli.mjs'));
  assert.equal(
    JSON.stringify(calls).includes('private-configuration-marker'),
    false,
  );
  assert.equal(
    JSON.stringify(cli.commands).includes('private-configuration-marker'),
    false,
  );
  const before = await readdir(join(controller.root, 'operator-cli'));
  await assert.rejects(cli.run('erase', input));
  await assert.rejects(cli.generateKey('../outside'));
  assert.equal(calls.length, 1);
  assert.deepEqual(
    await readdir(join(controller.root, 'operator-cli')),
    before,
  );
});
