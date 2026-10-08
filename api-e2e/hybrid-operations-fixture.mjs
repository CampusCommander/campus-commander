import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { postgresImage } from '../deployment/profiles/all-docker/render.mjs';

/** Run delivered backup and recovery commands against an owned hybrid controller. */
export async function createHybridOperationsCli({
  hosts,
  controller,
  project,
  googlePreload,
}) {
  assert.match(project, /^cc-phase3-hybrid-[a-f0-9]{12}$/);
  assert.equal(resolve(controller.root), controller.root);
  assert.equal(resolve(hosts.shared), hosts.shared);
  assert.ok(controller.root.startsWith(`/tmp/${project}-`));
  const ownerRoot = controller.root.split('/').slice(0, 3).join('/');
  assert.ok(hosts.shared.startsWith(`${ownerRoot}/`));
  if (googlePreload)
    assert.equal(
      googlePreload,
      join(controller.root, 'google-connection-preload.cjs'),
    );
  const directory = join(controller.root, 'operator-cli');
  await mkdir(directory, { mode: 0o700 });
  const commands = [];
  let sequence = 0;
  const json = (path, value) =>
    writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  const invoke = async (command, path) => {
    const started = Date.now();
    const output = await hosts.run(controller, [
      'docker',
      'run',
      '--rm',
      '--name',
      `${project}-operator-cli`,
      '--network',
      'host',
      '--user',
      '1000:1000',
      '--read-only',
      '--tmpfs',
      '/tmp:uid=1000,gid=1000,mode=0700',
      '--mount',
      'type=bind,source=/qualification-node,target=/fixture-node,readonly',
      '--mount',
      'type=bind,source=/release,target=/release,readonly',
      '--mount',
      `type=bind,source=${controller.root},target=${controller.root}`,
      '--mount',
      `type=bind,source=${hosts.shared},target=${hosts.shared}${['restore', 'revalidate-google'].includes(command) ? '' : ',readonly'}`,
      '--mount',
      `type=bind,source=${join(controller.root, 'private')},target=/run/secrets,readonly`,
      ...(googlePreload
        ? [
            '--mount',
            `type=bind,source=${googlePreload},target=/run/qualification/google-connection-preload.cjs,readonly`,
          ]
        : []),
      '--workdir',
      '/release',
      '--entrypoint',
      '/fixture-node',
      postgresImage,
      ...(googlePreload
        ? ['--require', '/run/qualification/google-connection-preload.cjs']
        : []),
      '/release/deployment/operations/cli.mjs',
      command,
      path,
    ]);
    const result =
      command === 'generate-key' ? { status: 'created' } : JSON.parse(output);
    commands.push({
      command,
      status: result.status,
      durationMs: Date.now() - started,
    });
    return { result };
  };
  return {
    commands,
    execution: {
      runner: 'operator-container-native',
      postgresImage,
      nodeVersion: process.version,
      source: 'extracted-published-phase3-bundle',
      injectedDatabaseTool: false,
      ...(googlePreload ? { googleTransport: 'synthetic-gaxios-preload' } : {}),
    },
    async generateKey(name) {
      assert.match(name, /^[a-z][a-z0-9-]{0,62}$/);
      return invoke('generate-key', join(controller.root, 'private', name));
    },
    async run(command, { config, targetConfig, release, ...input }) {
      assert.ok(
        ['backup', 'verify', 'restore', 'revalidate-google'].includes(command),
      );
      const id = ++sequence;
      const operator = { ...input };
      const configuration = config ?? targetConfig;
      if (configuration) {
        operator.configurationPath = join(
          directory,
          `configuration-${id}.json`,
        );
        await json(operator.configurationPath, configuration);
      }
      if (release) {
        operator.releaseInventoryPath = join(directory, `release-${id}.json`);
        await json(operator.releaseInventoryPath, release);
      }
      const path = join(directory, `request-${id}.json`);
      await json(path, operator);
      return invoke(command, path);
    },
  };
}
