import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
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
import {
  describeHybridFailure,
  assertHybridKeyMount,
} from './hybrid-evidence-fixture.mjs';
import { createHybridServices } from './hybrid-services-fixture.mjs';
import {
  readHybridReplica,
  verifyHybridRecipientAccess,
} from './hybrid-replica-fixture.mjs';
import { startProvider } from './provider-fixture.mjs';
import { applicationBrowser } from './profile-browser.mjs';
import { qualifyInstalledPhase3 } from './phase3-installed-workflows.mjs';
import { qualifyHybridWorkerCredentials } from './phase3-hybrid-worker-fixture.mjs';
import { loadPhase2UpgradeBaseline } from './phase3-upgrade-fixture.mjs';
import { qualifyHybridRestore } from './phase3-hybrid-restore-fixture.mjs';
import { qualifyHybridPhase2Upgrade } from './phase3-hybrid-upgrade-fixture.mjs';
import { upgradeDistributedHybrid } from './hybrid-cli-upgrade-fixture.mjs';
import { createHybridFaultStateProbe } from './phase3-hybrid-fault-state.mjs';
import { faultDistributedHybrid } from './hybrid-cli-faults-fixture.mjs';
import { qualifyHybridCapacity } from './hybrid-capacity-fixture.mjs';
import { qualifyHybridCertificates } from './hybrid-certificates-fixture.mjs';
import { loadQualificationBundle } from '../deployment/release/qualification.mjs';

const phase3Upgrade = process.env.CC_AUTH_PHASE3_HYBRID_UPGRADE === '1';
const phase3Restore = process.env.CC_AUTH_PHASE3_HYBRID_RESTORE === '1';
const phase3Faults = process.env.CC_AUTH_PHASE3_HYBRID_FAULTS === '1';
const phase3FaultKind =
  process.env.CC_AUTH_PHASE3_HYBRID_FAULT_KIND ?? 'services';
const phase3FaultModes = {
  services: {
    directory: 'dist/phase-3-hybrid-faults',
    target: 'phase3-hybrid-fault-integration',
    report: 'hybrid-faults.json',
  },
  certificates: {
    directory: 'dist/phase-3-hybrid-certificate-faults',
    target: 'phase3-hybrid-certificate-fault-integration',
    report: 'hybrid-certificates.json',
  },
  capacity: {
    directory: 'dist/phase-3-hybrid-capacity-faults',
    target: 'phase3-hybrid-capacity-fault-integration',
    report: 'hybrid-capacity.json',
  },
};
assert.ok(Object.hasOwn(phase3FaultModes, phase3FaultKind));
const phase3FaultMode = phase3FaultModes[phase3FaultKind];
assert.ok(
  [phase3Upgrade, phase3Restore, phase3Faults].filter(Boolean).length <= 1,
);
const phase3 =
  process.env.CC_AUTH_PHASE3_HYBRID === '1' ||
  phase3Upgrade ||
  phase3Restore ||
  phase3Faults;
const phase = phase3 ? 3 : 2;
const evidenceDirectory = phase3Restore
  ? 'dist/phase-3-hybrid-restore'
  : phase3Faults
    ? phase3FaultMode.directory
    : phase3Upgrade
      ? 'dist/phase-3-hybrid-upgrade'
      : phase3
        ? 'dist/phase-3-hybrid-installation'
        : 'dist/phase-2-evidence';
if (phase3) {
  assert.ok(
    process.env.CC_AUTH_INSTALLER_ROOT,
    'Phase 3 hybrid qualification requires an extracted bundle.',
  );
  for (const flag of [
    'CC_AUTH_HYBRID_CLI_UPGRADE',
    'CC_AUTH_HYBRID_CLI_FAULTS',
    'CC_AUTH_HYBRID_CAPACITY',
    'CC_AUTH_HYBRID_CERTIFICATES',
  ])
    assert.notEqual(
      process.env[flag],
      '1',
      'Phase 3 hybrid qualification cannot use Phase 2 modes.',
    );
}

test(
  'the hybrid installer runs authenticated lifecycle checks across three Docker hosts',
  { timeout: 1200000 },
  async () => {
    const started = Date.now();
    const project = `cc-phase${phase}-hybrid-${randomBytes(6).toString('hex')}`;
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
    let capacity;
    let certificates;
    let installedWorkflows;
    let workerCredentials;
    let restoration;
    let bundle;
    const harness = phase3
      ? {
          harnessRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim(),
          harnessWorkingTree: execFileSync(
            'git',
            ['status', '--porcelain', '--untracked-files=no'],
            {
              encoding: 'utf8',
            },
          ).trim()
            ? 'uncommitted-candidate'
            : 'clean',
          command: phase3Restore
            ? 'npm exec -- nx run api-e2e:phase3-hybrid-restore-integration'
            : phase3Faults
              ? `npm exec -- nx run api-e2e:${phase3FaultMode.target}`
              : phase3Upgrade
                ? 'npm exec -- nx run api-e2e:phase3-hybrid-upgrade-integration'
                : 'npm exec -- nx run api-e2e:phase3-hybrid-install-integration',
          environment: {
            nodeVersion: process.version,
            platform: process.platform,
            architecture: process.arch,
            uid: process.getuid?.() ?? null,
            gid: process.getgid?.() ?? null,
          },
        }
      : {};
    const credentialKeyProjection = [];
    const providerConnections = [];
    const sessionChecks = [];
    const recipientAccessChecks = [];
    const restartRecoveries = [];
    const images = {};
    let sourceRevision;
    const failures = [];
    let failure;
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
      bundle = process.env.CC_AUTH_INSTALLER_ROOT
        ? await loadQualificationBundle(process.env.CC_AUTH_INSTALLER_ROOT, {
            phase,
            images,
            sourceRevision,
          })
        : undefined;
      const phase2Baseline = phase3Upgrade
        ? await loadPhase2UpgradeBaseline(
            process.env.CC_AUTH_BASELINE_INSTALLER_ROOT,
          )
        : undefined;
      const baseline =
        phase2Baseline?.manifest ??
        (process.env.CC_AUTH_HYBRID_CLI_UPGRADE === '1'
          ? JSON.parse(
              await readFile(
                'deployment/qualification/phase-1-upgrade-baseline.json',
                'utf8',
              ),
            )
          : undefined);
      for (const reference of Object.values(baseline?.images ?? {})) {
        try {
          await outerDocker(['image', 'inspect', reference]);
        } catch {
          await outerDocker(['pull', reference]);
        }
      }
      const initialImages = baseline?.images ?? images;
      stage = 'host image and daemon preparation';
      hosts = await createHybridHosts({
        root,
        project,
        images,
        publicPort,
        baselineRoot: phase2Baseline?.root,
        nativeOperations: phase3Restore,
        boundedArtifacts:
          (phase3Faults && phase3FaultKind === 'capacity') ||
          process.env.CC_AUTH_HYBRID_CAPACITY === '1',
      });
      stage = 'image distribution';
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
      stage = 'external service fixture';
      services = await createHybridServices(hosts, project);
      const controller = hosts.hosts[0];
      const workers = hosts.hosts.slice(1);
      const privateRoot = services.privateRoot;
      stage = 'provider address resolution';
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
      stage = 'synthetic provider startup';
      provider = await startProvider({
        certificate: await readFile(join(privateRoot, 'provider-certificate')),
        privateKey: await readFile(join(privateRoot, 'provider-private-key')),
        publicOrigin,
        password: await readFile(join(privateRoot, 'oidc-client'), 'utf8'),
      });
      stage = 'installation configuration';
      const config = JSON.parse(
        await readFile(
          new URL('../deployment/examples/hybrid.json', import.meta.url),
        ),
      );
      config.phase = baseline?.phase ?? phase;
      let googleConnection;
      if (phase3) {
        googleConnection = {
          keyId: 'hybrid-google-qualification-key',
          encryptionKeySecretRef: {
            provider: 'file',
            path: '/run/secrets/google-qualification-key',
          },
        };
        if (!phase3Upgrade) config.googleConnection = googleConnection;
        await writeFile(
          join(privateRoot, 'google-qualification-key'),
          randomBytes(32),
          { mode: 0o600 },
        );
        for (const host of hosts.hosts)
          await copyFile(
            'api-e2e/google-connection-preload.cjs',
            join(host.root, 'google-connection-preload.cjs'),
          );
        for (const host of workers) {
          await mkdir(join(host.root, 'qualification-observation'), {
            mode: 0o700,
          });
          await copyFile(
            'api-e2e/phase3-hybrid-renewal-preload.cjs',
            join(host.root, 'phase3-hybrid-renewal-preload.cjs'),
          );
        }
      }
      config.images = initialImages;
      config.services.api.placement.replicas = 2;
      config.services.workers.endpoint.url =
        'https://workers.fixture.test:3001';
      config.services.edge.access =
        baseline && !phase3Upgrade ? 'bootstrap-only' : 'application';
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
        await mkdir(directory, { recursive: true, mode: 0o700 });
      const applicationAuth = {
        issuer: provider.issuer,
        clientId: 'qualification',
        publicOrigin,
        clientSecretRef: { provider: 'file', path: '/run/secrets/oidc-client' },
      };
      if (!baseline || phase3Upgrade) config.applicationAuth = applicationAuth;
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
      const targetRelease = bundle?.manifest ?? {
        schemaVersion: 1,
        phase,
        architectures: ['linux/amd64'],
        images,
        sourceRevision,
        qualification: 'candidate-only',
      };
      await json(releasePath, baseline ?? targetRelease);
      await prepareSecrets(config, privateRoot);
      let cliRoot = phase3Upgrade ? '/baseline' : '/release';
      const operator = {
        installationRoot: controller.root,
        configurationPath: configPath,
        releasePath,
        releaseRoot: cliRoot,
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
      const writeOverlays = async (active) => {
        for (const host of phase3 ? hosts.hosts : [controller]) {
          const service = host === controller ? 'api' : 'workers';
          await json(join(host.root, 'qualification-provider.json'), {
            services: {
              [service]: {
                environment: {
                  ...(host === controller
                    ? { NODE_EXTRA_CA_CERTS: '/run/secrets/district-ca' }
                    : {}),
                  ...(active
                    ? {
                        NODE_OPTIONS:
                          '--require=/run/qualification/google-connection-preload.cjs' +
                          (host === controller
                            ? ''
                            : ' --require=/run/qualification/phase3-hybrid-renewal-preload.cjs'),
                      }
                    : {}),
                },
                ...(active
                  ? {
                      volumes: [
                        {
                          type: 'bind',
                          source: join(
                            host.root,
                            'google-connection-preload.cjs',
                          ),
                          target:
                            '/run/qualification/google-connection-preload.cjs',
                          read_only: true,
                        },
                        ...(host === controller
                          ? []
                          : [
                              {
                                type: 'bind',
                                source: join(
                                  host.root,
                                  'phase3-hybrid-renewal-preload.cjs',
                                ),
                                target:
                                  '/run/qualification/phase3-hybrid-renewal-preload.cjs',
                                read_only: true,
                              },
                              {
                                type: 'bind',
                                source: join(
                                  host.root,
                                  'qualification-observation',
                                ),
                                target: '/run/qualification-observation',
                              },
                            ]),
                      ],
                    }
                  : {}),
              },
            },
          });
        }
      };
      await writeOverlays(phase3 && !phase3Upgrade);
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
        const commandStarted = Date.now();
        const result = JSON.parse(
          await hosts.run(controller, [
            'env',
            `PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
            'node',
            `${cliRoot}/deployment/installer/cli.mjs`,
            command,
            operatorPath,
            '--qualification',
          ]),
        );
        commands.push({
          command,
          ...(phase3 ? { releaseRoot: cliRoot } : {}),
          status: result.status,
          durationMs: Date.now() - commandStarted,
        });
        return result;
      };
      const compose = (host, args) =>
        hosts.run(host, [
          'docker',
          'compose',
          '-f',
          join(host.root, 'docker-compose.json'),
          ...(phase3
            ? ['-f', join(host.root, 'qualification-provider.json')]
            : []),
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
      const applicationAccess = async (input) =>
        JSON.parse(
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
              input: JSON.stringify(input),
            },
          ),
        );
      let enrollment;
      stage = 'CLI preparation';
      assert.equal((await cli('prepare')).status, 'prepared');
      let original = await readFile(controllerFile);
      await transfer();
      for (const host of workers) await compose(host, ['up', '-d']);
      stage = 'CLI installation';
      assert.equal((await cli('install')).status, 'ready');
      assert.equal((await cli('resume')).status, 'ready');
      if (phase3) assert.equal((await cli('resume')).status, 'ready');
      assert.deepEqual(await readFile(controllerFile), original);
      if (phase3Upgrade) {
        stage = 'Phase 2 administrator enrollment';
        enrollment = await applicationAccess({
          action: 'initialize',
          issuer: provider.issuer,
          subject: 'administrator',
          displayName: 'Synthetic administrator',
        });
        assert.ok(enrollment.principalId);
        stage = 'Phase 2-to-3 hybrid upgrade';
        upgrade = await qualifyHybridPhase2Upgrade({
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
          target: targetRelease,
          baseline: phase2Baseline,
          publicOrigin,
          activateTarget: async () => {
            config.phase = 3;
            config.images = images;
            config.googleConnection = googleConnection;
            cliRoot = '/release';
            await writeOverlays(true);
          },
        });
        original = await readFile(controllerFile);
      } else if (baseline) {
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
      if (phase3) {
        stage = 'credential key projection';
        const key = await readFile(
          join(privateRoot, 'google-qualification-key'),
        );
        for (const host of hosts.hosts) {
          assert.ok(
            key.equals(
              await readFile(
                join(host.root, 'private/google-qualification-key'),
              ),
            ),
            'Each authorized host must receive the same credential key.',
          );
          const containerIds = (await compose(host, ['ps', '--quiet']))
            .split('\n')
            .filter(Boolean);
          const containers = JSON.parse(
            await hosts.run(host, ['docker', 'inspect', ...containerIds]),
          );
          for (const container of containers) {
            const service =
              container.Config.Labels['com.docker.compose.service'];
            const authorized = ['api', 'workers'].includes(service);
            const hostProject =
              host === controller ? project : `${project}-${host.role}`;
            const consumer = host === controller ? 'api' : 'workers';
            const volumeName = `${hostProject}_${consumer}-secrets`;
            assertHybridKeyMount(container, { authorized, volumeName });
            if (authorized) {
              const projection = JSON.parse(
                await hosts.run(
                  host,
                  [
                    'docker',
                    'exec',
                    '-i',
                    container.Id,
                    'node',
                    '--input-type=module',
                    '-e',
                    "import fs from 'node:fs';const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const expected=Buffer.concat(chunks),path='/run/secrets/google-qualification-key',actual=fs.readFileSync(path),stat=fs.statSync(path);console.log(JSON.stringify({keyMatches:actual.equals(expected),mode:stat.mode&0o777,uid:stat.uid,gid:stat.gid}));expected.fill(0);actual.fill(0);",
                  ],
                  { input: key },
                ),
              );
              assert.deepEqual(projection, {
                keyMatches: true,
                mode: 0o600,
                uid: 1000,
                gid: 1000,
              });
              credentialKeyProjection.push({
                host: host.role,
                daemonId: host.daemonId,
                service,
                containerId: container.Id,
                readOnly: true,
                volumeName,
                keyBytesVerified: true,
                fileMode: projection.mode,
                fileUid: projection.uid,
                fileGid: projection.gid,
                keyId: config.googleConnection.keyId,
              });
            } else {
              await hosts.run(host, [
                'docker',
                'exec',
                container.Id,
                '/bin/sh',
                '-ec',
                'test ! -e /run/secrets/google-qualification-key',
              ]);
            }
          }
        }
        key.fill(0);
        assert.equal(
          credentialKeyProjection.filter((item) => item.service === 'api')
            .length,
          2,
        );
        assert.equal(
          credentialKeyProjection.filter((item) => item.service === 'workers')
            .length,
          2,
        );
        assert.equal(
          new Set(
            credentialKeyProjection
              .filter((item) => item.service === 'workers')
              .map((item) => item.daemonId),
          ).size,
          2,
        );
      }
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
      enrollment ??= await applicationAccess({
        action: 'initialize',
        issuer: provider.issuer,
        subject: 'administrator',
        displayName: 'Synthetic administrator',
      });
      assert.ok(enrollment.principalId);
      if (phase3)
        await applicationAccess({
          action: 'confirm-platform-administrator',
          principalId: enrollment.principalId,
          expectedVersion: 1,
          confirmation: 'grant-platform-administrator',
        });
      let authenticatedCookie;
      stage = 'browser and lifecycle';
      const verifyReplicas = async (
        context,
        { waitForRestart = false, expectedStatus = 200 } = {},
      ) => {
        const replicas = (await compose(controller, ['ps', '--quiet', 'api']))
          .split('\n')
          .filter(Boolean);
        assert.equal(replicas.length, 2);
        if (context)
          authenticatedCookie = (await context.cookies(publicOrigin))
            .filter(({ name }) => name.startsWith('__Host-'))
            .map(({ name, value }) => `${name}=${value}`)
            .join('; ');
        const cookie = authenticatedCookie;
        assert.ok(
          cookie,
          'Replica checks require the previous authenticated cookie.',
        );
        for (const replica of replicas) {
          const readSession = () =>
            readHybridReplica({
              hosts,
              controller,
              replica,
              path: '/api/auth/session',
              cookie,
            });
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
          assert.equal(result.status, expectedStatus);
          assert.equal(
            result.principalId,
            expectedStatus === 200 ? enrollment.principalId : undefined,
          );
          sessionChecks.push({ replica, ...result });
        }
      };
      const application = await applicationBrowser(
        publicOrigin,
        async ({ page, context, checks }) => {
          await verifyReplicas(context);
          if (phase3 && !phase3Restore) {
            installedWorkflows = await qualifyInstalledPhase3({
              page,
              publicOrigin,
              provider,
              verifyRecipientAccess: async (input) => {
                recipientAccessChecks.push(
                  ...(await verifyHybridRecipientAccess(
                    { hosts, controller, compose },
                    input,
                  )),
                );
              },
            });
            await checks({ recoverySeconds: 120 });
          }
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
          await installedWorkflows?.verifyAfterRestart();
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
            await installedWorkflows?.verifyAfterRestart();
            await checks({ recoverySeconds: 120 });
            assert.deepEqual(await readFile(controllerFile), original);
          }
          if (phase3Faults) await mkdir(evidenceDirectory, { recursive: true });
          const phase3FaultInputs = phase3Faults
            ? {
                verifyDurableState: await createHybridFaultStateProbe({
                  hosts,
                  services,
                  config,
                  project,
                  compose,
                }),
                verifyWorkflows: () => installedWorkflows.verifyAfterRestart(),
                evidencePath: join(
                  evidenceDirectory,
                  'hybrid-fault-progress.json',
                ),
                evidenceIdentity: {
                  ...harness,
                  schemaVersion: 1,
                  phase,
                  profile: 'hybrid',
                  sourceRevision,
                  images,
                  bundleManifestSha256: bundle.manifestSha256,
                },
                setStage: (fault) => {
                  stage = `distributed hybrid ${phase3FaultKind} fault: ${fault}`;
                },
              }
            : {};
          if (
            (phase3Faults && phase3FaultKind === 'services') ||
            process.env.CC_AUTH_HYBRID_CLI_FAULTS === '1'
          ) {
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
              ...phase3FaultInputs,
            });
          }
          if (
            (phase3Faults && phase3FaultKind === 'certificates') ||
            process.env.CC_AUTH_HYBRID_CERTIFICATES === '1'
          ) {
            stage = 'authenticated edge certificate faults';
            certificates = await qualifyHybridCertificates({
              ...phase3FaultInputs,
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
          if (
            (phase3Faults && phase3FaultKind === 'capacity') ||
            process.env.CC_AUTH_HYBRID_CAPACITY === '1'
          ) {
            stage = 'authenticated shared artifact capacity';
            capacity = await qualifyHybridCapacity({
              ...phase3FaultInputs,
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
          if (phase3Restore) {
            stage = 'isolated hybrid restore';
            restoration = await qualifyHybridRestore({
              hosts,
              controller,
              workers,
              config,
              operator,
              services,
              databaseOperator,
              release: targetRelease,
              page,
              context,
              provider,
              principalId: enrollment.principalId,
              setStage: (value) => {
                stage = value;
              },
              compose,
              cli,
            });
          }
          if (phase3) await verifyReplicas(context);
        },
        phase3
          ? {
              afterSignOut: () =>
                verifyReplicas(undefined, { expectedStatus: 401 }),
            }
          : {},
      );
      if (phase3 && !phase3Restore) {
        stage = 'distributed credential renewal';
        workerCredentials = await qualifyHybridWorkerCredentials({
          hosts,
          controller,
          workers,
          compose,
          controllerFile,
          project,
        });
      }
      result = {
        status: 'passed',
        profile: 'hybrid',
        ...(phase3
          ? {
              schemaVersion: 1,
              phase,
              ...harness,
              environment: {
                ...harness.environment,
                browser: application.browser,
              },
              ...(installedWorkflows
                ? { installedWorkflows: installedWorkflows.report }
                : {}),
              workerCredentials,
              recipientAccessChecks,
              credentialKeyProjection,
              durationScope: phase3Restore
                ? 'Extracted hybrid installation, lifecycle, isolated restore, and fixture cleanup.'
                : phase3Faults
                  ? 'Extracted hybrid installation, public workflows, selected fault group, recovery, and fixture cleanup.'
                  : phase3Upgrade
                    ? 'Extracted Phase 2 hybrid installation, Phase 3 upgrade, public workflows, lifecycle, and fixture cleanup.'
                    : 'Complete extracted hybrid installation, public workflows, lifecycle, and fixture cleanup.',
            }
          : {}),
        ...(upgrade ? { upgrade } : {}),
        ...(restoration ? { restoration } : {}),
        ...(faults ? { faults } : {}),
        ...(capacity ? { capacity } : {}),
        ...(certificates ? { certificates } : {}),
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
        qualificationSourceState: bundle
          ? 'Extracted published installer bundle with matching application images.'
          : 'Workspace installer and test source with explicitly pinned published application images.',
        ...(bundle ? { bundleManifestSha256: bundle.manifestSha256 } : {}),
        originalRenderPreserved: true,
        application,
        limits: [
          'Three Docker daemons share one physical Docker host and synthetic shared storage.',
          'A separate Compose overlay trusts the synthetic identity provider through the existing district CA mount.',
          'Final release qualification requires matching installer, test, and application source revisions.',
          ...(upgrade ? [] : ['Upgrade requires separate evidence.']),
          ...(restoration
            ? restoration.limits
            : ['Isolated restore requires separate evidence.']),
          'Complete fault acceptance and district infrastructure require separate evidence.',
        ],
      };
    } catch (error) {
      failure = describeHybridFailure(error);
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
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(
        join(evidenceDirectory, 'hybrid-cli-failure.json'),
        JSON.stringify({
          status: 'failed',
          profile: 'hybrid',
          phase,
          ...harness,
          ...(bundle ? { bundleManifestSha256: bundle.manifestSha256 } : {}),
          stage,
          failure,
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
      if (phase3)
        throw new Error(`Hybrid Phase 3 qualification failed during ${stage}.`);
      throw new AggregateError(
        failures,
        'Distributed qualification or fixture cleanup failed.',
      );
    }
    result.ownedResourcesRemoved = true;
    await mkdir(evidenceDirectory, { recursive: true });
    if (phase3) result.durationMs = Date.now() - started;
    if (phase3Upgrade)
      await writeFile(
        join(evidenceDirectory, 'hybrid-upgrade.json'),
        JSON.stringify(result, null, 2),
      );
    if (phase3Restore)
      await writeFile(
        join(evidenceDirectory, 'hybrid-restore.json'),
        JSON.stringify(result, null, 2),
      );
    if (phase3Faults)
      await writeFile(
        join(evidenceDirectory, phase3FaultMode.report),
        JSON.stringify(result, null, 2),
      );
    if (phase3 && !phase3Upgrade && !phase3Restore && !phase3Faults) {
      for (const [kind, commands] of [
        [
          'installation',
          result.commands.filter(({ command }) =>
            ['prepare', 'install'].includes(command),
          ),
        ],
        [
          'resume',
          result.commands.filter(({ command }) => command === 'resume'),
        ],
      ]) {
        const { commands: allCommands, ...identity } = result;
        assert.ok(allCommands.length > commands.length);
        await writeFile(
          join(evidenceDirectory, `hybrid-${kind}.json`),
          JSON.stringify(
            {
              ...identity,
              commands,
              durationMs: commands.reduce(
                (total, item) => total + item.durationMs,
                0,
              ),
              durationScope: `Delivered hybrid CLI ${kind} commands only. Public workflows and cleanup appear in hybrid-cli.json.`,
            },
            null,
            2,
          ),
        );
      }
    }
    await writeFile(
      phase3
        ? join(evidenceDirectory, 'hybrid-cli.json')
        : certificates
          ? 'dist/phase-2-evidence/hybrid-certificates.json'
          : capacity
            ? 'dist/phase-2-evidence/hybrid-capacity.json'
            : faults
              ? 'dist/phase-2-evidence/hybrid-cli-process-faults.json'
              : upgrade
                ? 'dist/phase-2-evidence/hybrid-cli-upgrade.json'
                : 'dist/phase-2-evidence/hybrid-cli.json',
      JSON.stringify(result, null, 2),
    );
  },
);
