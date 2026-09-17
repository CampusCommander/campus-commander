import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareSecrets } from '../deployment/installer/secrets.mjs';
import { parseDeploymentConfig } from '../dist/deployment/lib/deployment.js';
import { createHybridServices } from './hybrid-services-fixture.mjs';

const json = (path, value) =>
  writeFile(path, JSON.stringify(value), { mode: 0o600 });

/** Derive separate target database identities and storage paths. */
export function createHybridRestoreConfiguration(
  config,
  { databaseHostname, redisHostname, targetDirectory },
) {
  const targetConfig = structuredClone(config);
  for (const name of ['applicationDatabase', 'kestraDatabase']) {
    targetConfig.services[name].endpoint.url =
      `postgresql://${databaseHostname}:5432`;
    targetConfig.services[name].database =
      `restored-${config.services[name].database}`;
  }
  targetConfig.services.redis.endpoint.url = `rediss://${redisHostname}:6379`;
  targetConfig.artifacts.location = join(targetDirectory, 'artifacts');
  targetConfig.services.kestra.internalStorage.location = join(
    targetDirectory,
    'kestra-internal',
  );
  parseDeploymentConfig(targetConfig);
  return targetConfig;
}

/** Preserve application recovery material in the target private directory. */
export async function prepareHybridRestoreSecrets(
  config,
  sourceRoot,
  targetRoot,
) {
  for (const name of [
    'bootstrap',
    'oidc-client',
    'worker-dispatch',
    'kestra-auth',
    'google-qualification-key',
  ])
    await copyFile(join(sourceRoot, name), join(targetRoot, name));
  await prepareSecrets(config, targetRoot);
}

/** Start the recovered application through the delivered installer. */
export async function startHybridRestoreServices({
  cli,
  transfer,
  expectedBootstrapGeneration,
  setStage = () => undefined,
}) {
  setStage('target preparation');
  assert.equal((await cli('prepare')).status, 'prepared');
  setStage('controlled bootstrap replacement');
  const replacement = await cli('reset-bootstrap');
  assert.equal(replacement.status, 'replaced');
  assert.equal(
    String(replacement.generation),
    String(BigInt(expectedBootstrapGeneration) + 1n),
  );
  await transfer();
  setStage('target installation');
  assert.equal((await cli('install')).status, 'ready');
  setStage('target resume');
  assert.equal((await cli('resume')).status, 'ready');
}

/** Prepare separate target services without starting the restored application. */
export async function createHybridRestoreTarget({
  hosts,
  controller,
  workers,
  config,
  operator,
  databaseOperator,
  release,
}) {
  const project = `${operator.project}-restore`;
  const targetHosts = [controller, ...workers].map((host) => ({
    ...host,
    root: join(host.root, 'isolated-restore'),
  }));
  for (const host of targetHosts) await mkdir(host.root, { mode: 0o700 });
  const targetController = targetHosts[0];
  const targetWorkers = targetHosts.slice(1);
  const root = targetController.root;
  const targetDirectory = join(hosts.shared, 'isolated-restore');
  const databaseHostname = `${project}-postgres.fixture.test`;
  const redisHostname = `${project}-redis.fixture.test`;
  const targetConfig = createHybridRestoreConfiguration(config, {
    databaseHostname,
    redisHostname,
    targetDirectory,
  });
  const services = await createHybridServices(
    { ...hosts, hosts: targetHosts },
    project,
    { databaseHostname, redisHostname },
  );
  const configPath = join(root, 'deployment.json');
  const operatorPath = join(root, 'operator.json');
  const controllerFile = join(root, 'docker-compose.json');
  const overlay = join(root, 'qualification-provider.json');
  const bin = join(root, 'qualification-bin');
  const commands = [];
  const compose = (host, args) =>
    hosts.run(host, [
      'docker',
      'compose',
      '-f',
      join(host.root, 'docker-compose.json'),
      '-f',
      join(host.root, 'qualification-provider.json'),
      '-p',
      host === targetController ? project : `${project}-${host.role}`,
      ...args,
    ]);
  const prepared = new Set();
  const close = async () => {
    const errors = [];
    for (const host of [...prepared].reverse()) {
      try {
        await compose(host, ['down', '--volumes']);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await services.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, 'Hybrid restore target cleanup failed.');
  };
  try {
    await prepareHybridRestoreSecrets(
      targetConfig,
      join(controller.root, 'private'),
      services.privateRoot,
    );
    await mkdir(join(root, 'runtime'), { mode: 0o700 });
    await json(configPath, targetConfig);
    await json(join(root, 'release.json'), release);
    await json(join(root, 'runtime/profile.json'), targetConfig);
    await json(join(root, 'runtime/operator.json'), databaseOperator);
    const targetOperator = {
      ...operator,
      project,
      installationRoot: root,
      configurationPath: configPath,
      releasePath: join(root, 'release.json'),
      restoreDirectories: [targetDirectory],
      migrationCredentials: {
        role: databaseOperator.migrationRole,
        passwordSecretRef: databaseOperator.migrationPasswordSecretRef,
      },
    };
    await json(operatorPath, targetOperator);
    for (const host of targetHosts) {
      await copyFile(
        'api-e2e/google-connection-preload.cjs',
        join(host.root, 'google-connection-preload.cjs'),
      );
      const isController = host === targetController;
      await json(join(host.root, 'qualification-provider.json'), {
        services: {
          [isController ? 'api' : 'workers']: {
            environment: {
              NODE_OPTIONS:
                '--require=/run/qualification/google-connection-preload.cjs',
              ...(isController
                ? { NODE_EXTRA_CA_CERTS: '/run/qualification/provider-ca' }
                : {}),
            },
            volumes: [
              {
                type: 'bind',
                source: join(host.root, 'google-connection-preload.cjs'),
                target: '/run/qualification/google-connection-preload.cjs',
                read_only: true,
              },
              ...(isController
                ? [
                    {
                      type: 'bind',
                      source: join(controller.root, 'private/district-ca'),
                      target: '/run/qualification/provider-ca',
                      read_only: true,
                    },
                  ]
                : []),
            ],
          },
        },
      });
    }
    await mkdir(bin, { mode: 0o700 });
    await writeFile(
      join(bin, 'docker'),
      `#!/usr/local/bin/node
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2),index=args.indexOf('-f');
if(args[0]==='compose'&&args[index+1]===${JSON.stringify(controllerFile)})args.splice(index+2,0,'-f',${JSON.stringify(overlay)});
const result=spawnSync('/usr/local/bin/docker',args,{stdio:'inherit'});
process.exit(result.status??1);
`,
      { mode: 0o700 },
    );
    await hosts.run(targetController, [
      'docker',
      'run',
      '--rm',
      '--read-only',
      '--tmpfs',
      '/tmp:uid=1000,gid=1000,mode=0700',
      '--mount',
      `type=bind,source=${join(root, 'runtime/profile.json')},target=/run/config/profile.json,readonly`,
      '--mount',
      `type=bind,source=${join(root, 'runtime/operator.json')},target=/run/config/operator.json,readonly`,
      ...[
        'district-ca',
        'district-postgres-admin-password',
        'campus-database-password',
        'kestra-database-password',
        'postgres-migrator',
      ].flatMap((name) => [
        '--mount',
        `type=bind,source=${join(services.privateRoot, name)},target=/run/secrets/${name},readonly`,
      ]),
      config.images.api,
      'node',
      '/app/deployment/postgres/cli.mjs',
      'provision',
      '/run/config/profile.json',
      '/run/config/operator.json',
    ]);
    const cli = async (command) => {
      assert.ok(
        ['prepare', 'install', 'resume', 'reset-bootstrap'].includes(command),
      );
      const started = Date.now();
      const result = JSON.parse(
        await hosts.run(targetController, [
          'env',
          `PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
          'node',
          '/release/deployment/installer/cli.mjs',
          command,
          operatorPath,
          '--qualification',
        ]),
      );
      commands.push({
        command,
        status: result.status,
        durationMs: Date.now() - started,
      });
      if (command === 'prepare') prepared.add(targetController);
      return result;
    };
    const transfer = async () => {
      for (const [index, host] of targetWorkers.entries()) {
        const fragment = join(root, `docker-compose.worker-${index + 1}.json`);
        const document = JSON.parse(await readFile(fragment));
        const references = new Set(['runtime/profile.json']);
        for (const service of Object.values(document.services))
          for (const mount of service.volumes ?? [])
            if (
              typeof mount === 'object' &&
              mount.type === 'bind' &&
              mount.source.startsWith('./private/')
            )
              references.add(mount.source.slice(2));
        for (const directory of ['private', 'runtime'])
          await mkdir(join(host.root, directory), { mode: 0o700 });
        for (const file of references)
          await copyFile(join(root, file), join(host.root, file));
        await copyFile(fragment, join(host.root, 'docker-compose.json'));
        assert.deepEqual(
          await readFile(fragment),
          await readFile(join(host.root, 'docker-compose.json')),
        );
        prepared.add(host);
        await compose(host, ['up', '-d']);
      }
    };
    const start = async (expectedBootstrapGeneration, setStage) => {
      assert.match(String(expectedBootstrapGeneration), /^[1-9][0-9]*$/);
      targetOperator.expectedBootstrapGeneration = String(
        expectedBootstrapGeneration,
      );
      await json(operatorPath, targetOperator);
      return startHybridRestoreServices({
        cli,
        transfer,
        expectedBootstrapGeneration,
        setStage,
      });
    };
    return {
      controller: targetController,
      workers: targetWorkers,
      targetDirectory,
      config: targetConfig,
      configPath,
      project,
      services,
      compose,
      cli,
      commands,
      start,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
