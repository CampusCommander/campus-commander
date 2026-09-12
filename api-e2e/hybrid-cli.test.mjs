import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { expect } from '@playwright/test';
import { prepareSecrets } from '../deployment/installer/secrets.mjs';
import {
  kestraImage,
  postgresImage,
} from '../deployment/profiles/all-docker/render.mjs';
import { redisImage } from '../deployment/redis/runtime.mjs';
import { createHybridHosts, outerDocker } from './hybrid-hosts-fixture.mjs';
import { createHybridServices } from './hybrid-services-fixture.mjs';
import { startProvider } from './provider-fixture.mjs';
import { applicationBrowser } from './profile-browser.mjs';
import { upgradeDistributedHybrid } from './hybrid-cli-upgrade-fixture.mjs';
import { faultDistributedHybrid } from './hybrid-cli-faults-fixture.mjs';

test(
  'the hybrid installer runs authenticated lifecycle checks across three Docker hosts',
  { timeout: 1200000 },
  async () => {
    const started = Date.now();
    const project = `cc-phase2-hybrid-${randomBytes(6).toString('hex')}`;
    const root = await mkdtemp(`/tmp/${project}-`);
    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const publicPort = listener.address().port;
    await new Promise((done) => listener.close(done));
    const publicOrigin = `https://campus.example.org:${publicPort}`;
    let hosts;
    let services;
    let provider;
    let stage = 'host preparation';
    let result;
    let upgrade;
    let faults;
    const providerConnections = [];
    const sessionChecks = [];
    const restartRecoveries = [];
    const images = {};
    let sourceRevision;
    const failures = [];
    try {
      const labels = [];
      for (const [name, variable] of [
        ['frontend', 'FRONTEND'],
        ['api', 'API'],
        ['workers', 'WORKER'],
      ]) {
        const reference = process.env[`CC_AUTH_${variable}_IMAGE`];
        assert.match(reference ?? '', /@sha256:[a-f0-9]{64}$/);
        images[name] = reference;
        labels.push(
          JSON.parse(await outerDocker(['image', 'inspect', reference]))[0]
            .Config.Labels['org.opencontainers.image.revision'],
        );
      }
      assert.equal(new Set(labels).size, 1);
      sourceRevision = labels[0];
      assert.match(sourceRevision, /^[a-f0-9]{40}$/);
      const baseline =
        process.env.CC_AUTH_HYBRID_CLI_UPGRADE === '1'
          ? JSON.parse(
              await readFile(
                'deployment/qualification/phase-1-upgrade-baseline.json',
                'utf8',
              ),
            )
          : undefined;
      for (const reference of Object.values(baseline?.images ?? {})) {
        try {
          await outerDocker(['image', 'inspect', reference]);
        } catch {
          await outerDocker(['pull', reference]);
        }
      }
      const initialImages = baseline?.images ?? images;
      hosts = await createHybridHosts({ root, project, images, publicPort });
      await hosts.loadImages(
        [
          ...Object.values(images),
          ...Object.values(baseline?.images ?? {}),
          kestraImage,
          postgresImage,
          redisImage,
        ],
        {
          workerReferences: [
            images.api,
            images.workers,
            initialImages.api,
            initialImages.workers,
          ],
        },
      );
      services = await createHybridServices(hosts, project);
      const controller = hosts.hosts[0];
      const workers = hosts.hosts.slice(1);
      const privateRoot = services.privateRoot;
      const hostGateway = JSON.parse(
        await outerDocker([
          'run',
          '--rm',
          '--network',
          hosts.network,
          '--add-host',
          'host.docker.internal:host-gateway',
          '--entrypoint',
          'node',
          images.api,
          '-e',
          "require('node:dns').lookup('host.docker.internal',(error,value)=>{if(error)throw error;console.log(JSON.stringify(value))})",
        ]),
      );
      await hosts.mapHosts({ 'host.docker.internal': [hostGateway] });
      provider = await startProvider({
        certificate: await readFile(join(privateRoot, 'provider-certificate')),
        privateKey: await readFile(join(privateRoot, 'provider-private-key')),
        publicOrigin,
        password: await readFile(join(privateRoot, 'oidc-client'), 'utf8'),
      });
      const config = JSON.parse(
        await readFile(
          new URL('../deployment/examples/hybrid.json', import.meta.url),
        ),
      );
      config.phase = baseline ? 1 : 2;
      config.images = initialImages;
      config.services.api.placement.replicas = 2;
      config.services.workers.endpoint.url =
        'https://workers.fixture.test:3001';
      config.services.edge.access = baseline ? 'bootstrap-only' : 'application';
      config.services.edge.endpoint = {
        url: publicOrigin,
        tls: {
          mode: 'private-ca',
          caSecretRef: { provider: 'file', path: '/run/secrets/district-ca' },
        },
      };
      for (const name of ['applicationDatabase', 'kestraDatabase'])
        config.services[name].endpoint.url =
          'postgresql://district-postgres.fixture.test:5432';
      config.services.redis.endpoint.url =
        'rediss://district-redis.fixture.test:6379';
      config.artifacts.location = join(hosts.shared, 'artifacts');
      config.services.kestra.internalStorage.location = join(
        hosts.shared,
        'kestra',
      );
      for (const directory of [
        config.artifacts.location,
        config.services.kestra.internalStorage.location,
      ])
        await mkdir(directory, { mode: 0o700 });
      const applicationAuth = {
        issuer: provider.issuer,
        clientId: 'qualification',
        publicOrigin,
        clientSecretRef: { provider: 'file', path: '/run/secrets/oidc-client' },
      };
      if (!baseline) config.applicationAuth = applicationAuth;
      const configPath = join(controller.root, 'deployment.json');
      const releasePath = join(controller.root, 'release.json');
      const operatorPath = join(controller.root, 'operator.json');
      const runtime = join(controller.root, 'runtime');
      await mkdir(runtime, { mode: 0o700 });
      const databaseOperator = {
        adminDatabase: 'postgres',
        adminRole: 'postgres',
        adminPasswordSecretRef: {
          provider: 'file',
          path: '/run/secrets/district-postgres-admin-password',
        },
        migrationRole: 'application-installer',
        migrationPasswordSecretRef: {
          provider: 'file',
          path: '/run/secrets/postgres-migrator',
        },
      };
      const json = (file, value) =>
        writeFile(file, JSON.stringify(value), { mode: 0o600 });
      await json(configPath, config);
      await json(join(runtime, 'profile.json'), config);
      await json(join(runtime, 'operator.json'), databaseOperator);
      const targetRelease = {
        schemaVersion: 1,
        phase: 2,
        architectures: ['linux/amd64'],
        images,
        sourceRevision,
        qualification: 'candidate-only',
      };
      await json(releasePath, baseline ?? targetRelease);
      await prepareSecrets(config, privateRoot);
      const operator = {
        installationRoot: controller.root,
        configurationPath: configPath,
        releasePath,
        releaseRoot: '/release',
        project,
        bindAddress: controller.address,
        workerBindAddresses: workers.map(({ address }) => address),
        preflightExceptions: [
          {
            name: 'time-synchronization',
            reason:
              'The disposable hosts use the physical host clock. They do not run district time services.',
          },
        ],
      };
      await json(operatorPath, operator);
      stage = 'external database provisioning';
      await hosts.run(controller, [
        'docker',
        'run',
        '--rm',
        '--read-only',
        '--tmpfs',
        '/tmp:uid=1000,gid=1000,mode=0700',
        '--mount',
        `type=bind,source=${join(runtime, 'profile.json')},target=/run/config/profile.json,readonly`,
        '--mount',
        `type=bind,source=${join(runtime, 'operator.json')},target=/run/config/operator.json,readonly`,
        ...[
          'district-ca',
          'district-postgres-admin-password',
          'campus-database-password',
          'kestra-database-password',
          'postgres-migrator',
        ].flatMap((name) => [
          '--mount',
          `type=bind,source=${join(privateRoot, name)},target=/run/secrets/${name},readonly`,
        ]),
        images.api,
        'node',
        '/app/deployment/postgres/cli.mjs',
        'provision',
        '/run/config/profile.json',
        '/run/config/operator.json',
      ]);
      const controllerFile = join(controller.root, 'docker-compose.json');
      const overlay = join(controller.root, 'qualification-provider.json');
      await json(overlay, {
        services: {
          api: {
            environment: { NODE_EXTRA_CA_CERTS: '/run/secrets/district-ca' },
          },
        },
      });
      const bin = join(controller.root, 'qualification-bin');
      await mkdir(bin, { mode: 0o700 });
      await writeFile(
        join(bin, 'docker'),
        `#!/usr/local/bin/node
import {spawnSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2),index=args.indexOf('-f');
if(args[0]==='compose'&&args[index+1]===${JSON.stringify(controllerFile)})args.splice(index+2,0,'-f',${JSON.stringify(overlay)});
const result=spawnSync('/usr/local/bin/docker',args,{stdio:['inherit','inherit','pipe']});
if(result.stderr){process.stderr.write(result.stderr);if(result.status!==0)appendFileSync(${JSON.stringify(join(controller.root, 'qualification-docker-error.log'))},result.stderr,{mode:0o600});}
process.exit(result.status??1);
`,
        { mode: 0o700 },
      );
      const commands = [];
      const cli = async (command) => {
        const result = JSON.parse(
          await hosts.run(controller, [
            'env',
            `PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
            'node',
            '/release/deployment/installer/cli.mjs',
            command,
            operatorPath,
            '--qualification',
          ]),
        );
        commands.push({ command, status: result.status });
        return result;
      };
      const compose = (host, args) =>
        hosts.run(host, [
          'docker',
          'compose',
          '-f',
          join(host.root, 'docker-compose.json'),
          '-p',
          host === controller ? project : `${project}-${host.role}`,
          ...args,
        ]);
      const transfer = async () => {
        for (const [index, host] of workers.entries()) {
          const fragment = join(
            controller.root,
            `docker-compose.worker-${index + 1}.json`,
          );
          const document = JSON.parse(await readFile(fragment, 'utf8'));
          const references = new Set(['runtime/profile.json']);
          for (const service of Object.values(document.services))
            for (const mount of service.volumes ?? [])
              if (
                typeof mount === 'object' &&
                mount.type === 'bind' &&
                mount.source.startsWith('./private/')
              )
                references.add(mount.source.slice(2));
          await mkdir(join(host.root, 'private'), {
            recursive: true,
            mode: 0o700,
          });
          await mkdir(join(host.root, 'runtime'), {
            recursive: true,
            mode: 0o700,
          });
          for (const file of references)
            await copyFile(join(controller.root, file), join(host.root, file));
          await copyFile(fragment, join(host.root, 'docker-compose.json'));
          assert.deepEqual(
            await readFile(fragment),
            await readFile(join(host.root, 'docker-compose.json')),
          );
        }
      };
      stage = 'CLI preparation';
      assert.equal((await cli('prepare')).status, 'prepared');
      let original = await readFile(controllerFile);
      await transfer();
      for (const host of workers) await compose(host, ['up', '-d']);
      stage = 'CLI installation';
      assert.equal((await cli('install')).status, 'ready');
      assert.equal((await cli('resume')).status, 'ready');
      assert.deepEqual(await readFile(controllerFile), original);
      if (baseline) {
        stage = 'CLI upgrade and encrypted backup';
        upgrade = await upgradeDistributedHybrid({
          hosts,
          controller,
          workers,
          compose,
          cli,
          transfer,
          config,
          configPath,
          releasePath,
          operator,
          operatorPath,
          databaseOperator,
          target: targetRelease,
          baseline,
          auth: applicationAuth,
          json,
        });
        original = await readFile(controllerFile);
      }
      const apiReplicas = (await compose(controller, ['ps', '--quiet', 'api']))
        .split('\n')
        .filter(Boolean);
      assert.equal(apiReplicas.length, 2);
      assert.equal(new Set(apiReplicas).size, 2);
      stage = 'provider connectivity';
      for (const replica of apiReplicas) {
        const probe = JSON.parse(
          await hosts.run(controller, [
            'docker',
            'exec',
            replica,
            'node',
            '--input-type=module',
            '-e',
            `import fs from 'node:fs';import https from 'node:https';const c=JSON.parse(fs.readFileSync(process.env.CC_CONFIG_FILE));const timeout=setTimeout(()=>process.exit(2),10000);https.get(new URL('/.well-known/openid-configuration',c.applicationAuth.issuer),{ca:fs.readFileSync('/run/secrets/district-ca')},response=>{response.resume();response.on('end',()=>{clearTimeout(timeout);console.log(JSON.stringify({status:response.statusCode}));})}).on('error',error=>{clearTimeout(timeout);console.log(JSON.stringify({status:'failed',code:error.code}));});`,
          ]),
        );
        providerConnections.push({ replica, ...probe });
        assert.equal(
          probe.status,
          200,
          'Each API replica must reach the verified synthetic provider.',
        );
      }
      const enrollment = JSON.parse(
        await hosts.run(
          controller,
          [
            'docker',
            'compose',
            '-f',
            controllerFile,
            '-p',
            project,
            'run',
            '--rm',
            '--no-deps',
            '--interactive',
            '--no-tty',
            'database-migrate',
            'node',
            '/app/deployment/bootstrap/application-access-cli.mjs',
            '/run/config/profile.json',
            '/run/config/operator.json',
            '/dev/stdin',
          ],
          {
            input: JSON.stringify({
              action: 'initialize',
              issuer: provider.issuer,
              subject: 'administrator',
              displayName: 'Synthetic administrator',
            }),
          },
        ),
      );
      assert.ok(enrollment.principalId);
      stage = 'browser and lifecycle';
      const verifyReplicas = async (
        context,
        { waitForRestart = false } = {},
      ) => {
        const replicas = (await compose(controller, ['ps', '--quiet', 'api']))
          .split('\n')
          .filter(Boolean);
        assert.equal(replicas.length, 2);
        const cookie = (await context.cookies(publicOrigin))
          .map(({ name, value }) => `${name}=${value}`)
          .join('; ');
        for (const replica of replicas) {
          const readSession = async () =>
            JSON.parse(
              await hosts.run(
                controller,
                [
                  'docker',
                  'exec',
                  '-i',
                  replica,
                  'node',
                  '--input-type=module',
                  '-e',
                  `import fs from 'node:fs';import https from 'node:https';let input='';for await(const chunk of process.stdin)input+=chunk;const {cookie}=JSON.parse(input);const request=https.get({hostname:'127.0.0.1',port:3000,servername:'api',ca:fs.readFileSync('/run/secrets/district-ca'),path:'/api/auth/session',headers:{cookie},timeout:10000},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>{const value=JSON.parse(body);console.log(JSON.stringify({status:response.statusCode,principalId:value.identity?.id}))})});request.on('timeout',()=>request.destroy(new Error('Session verification timed out.')));request.on('error',()=>process.exit(1));`,
                ],
                { input: JSON.stringify({ cookie }) },
              ),
            );
          let result;
          if (waitForRestart) {
            const started = Date.now();
            const observations = [];
            await expect
              .poll(
                async () => {
                  try {
                    result = await readSession();
                    observations.push({
                      status: result.status,
                      elapsedMs: Date.now() - started,
                    });
                    return (
                      result.status === 200 &&
                      result.principalId === enrollment.principalId
                    );
                  } catch {
                    observations.push({
                      status: 'unavailable',
                      elapsedMs: Date.now() - started,
                    });
                    return false;
                  }
                },
                {
                  timeout: 30000,
                  message:
                    'The API replica must restore the existing session after restart.',
                },
              )
              .toBe(true);
            restartRecoveries.push({
              replica,
              recoveryMs: Date.now() - started,
              observations,
            });
          } else result = await readSession();
          assert.equal(result.status, 200);
          assert.equal(result.principalId, enrollment.principalId);
          sessionChecks.push({ replica, ...result });
        }
      };
      const application = await applicationBrowser(
        publicOrigin,
        async ({ page, context, checks }) => {
          await verifyReplicas(context);
          const preference = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === '/api/auth/preferences' &&
              response.request().method() === 'POST',
          );
          await page.getByRole('button', { name: 'Choose theme' }).click();
          await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
          assert.equal((await preference).status(), 201);
          stage = 'API restart and session restoration';
          await compose(controller, ['restart', 'api']);
          for (const host of workers)
            await compose(host, ['restart', 'workers']);
          await verifyReplicas(context, { waitForRestart: true });
          await page.reload();
          await expect(
            page.getByRole('heading', { name: 'Diagnostics', exact: true }),
          ).toBeVisible({ timeout: 15000 });
          await verifyReplicas(context);
          await checks({ recoverySeconds: 120 });
          for (const command of ['stop', 'uninstall']) {
            stage = `${command} and resume`;
            for (const host of workers)
              await compose(host, command === 'stop' ? ['stop'] : ['down']);
            const result = await cli(command);
            assert.equal(result.dataPreserved, true);
            assert.equal(result.remoteWorkerActionRequired, true);
            await transfer();
            for (const host of workers) await compose(host, ['up', '-d']);
            assert.equal((await cli('resume')).status, 'ready');
            await page.reload();
            await expect(
              page.getByRole('heading', { name: 'Diagnostics', exact: true }),
            ).toBeVisible({ timeout: 15000 });
            await expect(page.locator('html')).toHaveAttribute(
              'data-theme',
              'dark',
            );
            await verifyReplicas(context);
            await checks({ recoverySeconds: 120 });
            assert.deepEqual(await readFile(controllerFile), original);
          }
          if (process.env.CC_AUTH_HYBRID_CLI_FAULTS === '1') {
            stage = 'distributed process and shared-storage faults';
            faults = await faultDistributedHybrid({
              hosts,
              services,
              compose,
              config,
              upgrade,
              page,
              checks,
              verifyReplicas,
              context,
            });
          }
        },
      );
      result = {
        status: 'passed',
        profile: 'hybrid',
        ...(upgrade ? { upgrade } : {}),
        ...(faults ? { faults } : {}),
        sourceRevision,
        images,
        recordedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        hosts: hosts.hosts.map(
          ({
            role,
            name,
            address,
            daemonId,
            serverVersion,
            daemonNetwork,
          }) => ({
            role,
            name,
            address,
            daemonId,
            serverVersion,
            daemonNetwork,
          }),
        ),
        commands,
        apiReplicaCount: apiReplicas.length,
        sessionChecks,
        restartRecoveries,
        providerConnections,
        qualificationSourceState:
          'Workspace installer and test source with explicitly pinned published application images.',
        originalRenderPreserved: true,
        application,
        limits: [
          'Three Docker daemons share one physical Docker host and synthetic shared storage.',
          'A separate Compose overlay trusts the synthetic identity provider through the existing district CA mount.',
          'Final release qualification requires matching installer, test, and application source revisions.',
          ...(upgrade ? [] : ['Upgrade requires separate evidence.']),
          'Isolated restore, complete fault acceptance, and district infrastructure require separate evidence.',
        ],
      };
    } catch (error) {
      failures.push(error);
      for (const host of hosts?.hosts ?? []) {
        const snapshot = await hosts
          .run(host, ['docker', 'ps', '-a', '--format', '{{json .}}'])
          .catch(() => '');
        await writeFile(join(host.root, 'container-status.jsonl'), snapshot, {
          mode: 0o600,
        });
        const logs = await hosts
          .run(host, [
            'docker',
            'compose',
            '-f',
            join(host.root, 'docker-compose.json'),
            '-p',
            host.role === 'controller' ? project : `${project}-${host.role}`,
            'logs',
            '--no-color',
            '--tail',
            '80',
          ])
          .catch(() => '');
        await writeFile(join(host.root, 'container-errors.log'), logs, {
          mode: 0o600,
        });
      }
      process.stderr.write(
        `Distributed hybrid qualification failed during ${stage}. Private fixture: ${root}\n`,
      );
      await writeFile(
        join(root, 'failure.json'),
        JSON.stringify({ stage, message: error.message, stderr: error.stderr }),
        { mode: 0o600 },
      );
    } finally {
      for (const resource of [provider, services, hosts]) {
        try {
          await resource?.close();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length) {
      await mkdir('dist/phase-2-evidence', { recursive: true });
      await writeFile(
        'dist/phase-2-evidence/hybrid-cli-failure.json',
        JSON.stringify({
          status: 'failed',
          profile: 'hybrid',
          stage,
          sourceRevision,
          images,
          durationMs: Date.now() - started,
          providerConnections,
          sessionChecks,
          restartRecoveries,
          ...(upgrade ? { upgrade } : {}),
          recordedAt: new Date().toISOString(),
        }),
      );
      throw new AggregateError(
        failures,
        'Distributed qualification or fixture cleanup failed.',
      );
    }
    result.ownedResourcesRemoved = true;
    await mkdir('dist/phase-2-evidence', { recursive: true });
    await writeFile(
      faults
        ? 'dist/phase-2-evidence/hybrid-cli-process-faults.json'
        : upgrade
          ? 'dist/phase-2-evidence/hybrid-cli-upgrade.json'
          : 'dist/phase-2-evidence/hybrid-cli.json',
      JSON.stringify(result, null, 2),
    );
  },
);
