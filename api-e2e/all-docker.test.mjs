import { applicationAccess } from './access-fixture.mjs';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { expect } from '@playwright/test';
import { httpsStartup } from '../deployment/qualification/faults.mjs';
import { startProvider } from './provider-fixture.mjs';
import { applicationBrowser } from './profile-browser.mjs';
import { startRegistry } from './registry-fixture.mjs';

const execute = promisify(execFile);
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();

test(
  'the all-Docker installer installs Phase 2 and restores application access through resume and restart',
  { timeout: 360000 },
  async () => {
    const startedAt = Date.now();
    const root = await mkdtemp(join(tmpdir(), 'cc-phase2-compose-'));
    const project = `cc-phase2-${randomUUID().slice(0, 12)}`;
    const composePath = join(root, 'docker-compose.json');
    const bin = join(root, 'qualification-bin');
    const runtimePath = join(root, 'qualification-runtime.json');
    const compose = (...args) =>
      execFileSync(
        join(bin, 'docker'),
        ['compose', '-f', composePath, '-p', project, ...args],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 240000,
          maxBuffer: 8 * 1024 * 1024,
        },
      ).trim();
    const operatorPath = join(root, 'operator.json');
    const installerRoot = resolve(process.env.CC_AUTH_INSTALLER_ROOT ?? '.');
    const cli = async (command) =>
      JSON.parse(
        (
          await execute(
            process.execPath,
            [
              join(installerRoot, 'deployment/installer/cli.mjs'),
              command,
              operatorPath,
              '--qualification',
            ],
            {
              env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
              timeout: 300000,
              maxBuffer: 8 * 1024 * 1024,
            },
          )
        ).stdout,
      );
    let provider;
    let registry;
    let rendered;
    let failed = false;
    try {
      const portServer = createServer().listen(0, '127.0.0.1');
      await once(portServer, 'listening');
      const port = portServer.address().port;
      await new Promise((done) => portServer.close(done));
      const publicOrigin = `https://campus.example.org:${port}`;
      const privateRoot = join(root, 'private');
      await mkdir(privateRoot, { mode: 0o700 });
      const certPath = join(privateRoot, 'edge-certificate');
      const keyPath = join(privateRoot, 'edge-private-key');
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:campus.example.org,DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
      );
      const password = randomUUID();
      await writeFile(join(privateRoot, 'oidc-client'), password, {
        mode: 0o600,
      });
      provider = await startProvider({
        certificate: await readFile(certPath),
        privateKey: await readFile(keyPath),
        publicOrigin,
        password,
      });
      const config = JSON.parse(
        await readFile('deployment/examples/all-docker.json', 'utf8'),
      );
      config.phase = 2;
      config.services.api.placement.replicas = 2;
      config.services.edge.access = 'application';
      config.services.edge.endpoint.url = publicOrigin;
      config.applicationAuth = {
        issuer: provider.issuer,
        clientId: 'qualification',
        publicOrigin,
        clientSecretRef: { provider: 'file', path: '/run/secrets/oidc-client' },
      };
      const revisions = new Set();
      const images = Object.fromEntries(
        ['frontend', 'api', 'worker'].map((service) => {
          const reference =
            process.env[`CC_AUTH_${service.toUpperCase()}_IMAGE`] ??
            `campus-commander/${service}:cc-6`;
          const image = JSON.parse(docker('image', 'inspect', reference))[0];
          assert.ok(image.RepoDigests.length >= 1);
          revisions.add(
            image.Config.Labels['org.opencontainers.image.revision'],
          );
          return [
            service === 'worker' ? 'workers' : service,
            reference.includes('@sha256:') ? reference : image.RepoDigests[0],
          ];
        }),
      );
      assert.equal(
        revisions.size,
        1,
        'All application images must identify the same source revision.',
      );
      const [imageBuildId] = revisions;
      assert.match(imageBuildId, /^[a-f0-9]{40}(?:-dirty)?$/);
      const sourceRevision = imageBuildId.slice(0, 40);
      const workingTree = imageBuildId.endsWith('-dirty')
        ? 'uncommitted-candidate'
        : 'clean';
      const published = Object.values(images).every((image) =>
        image.startsWith('ghcr.io/campuscommander/'),
      );
      if (published) assert.equal(workingTree, 'clean');
      config.images = images;
      const release = {
        schemaVersion: 1,
        sourceRevision,
        phase: 2,
        qualification: 'candidate-only',
        workingTree,
        sourceRevisionMeaning:
          workingTree === 'clean'
            ? 'image source revision'
            : 'base revision before local image changes',
        images,
        architectures: ['linux/amd64'],
      };
      if (!published)
        registry = await startRegistry({ relayImage: images.api });
      let installationRelease = registry
        ? await registry.mirror(release, 'phase2')
        : release;
      if (process.env.CC_AUTH_INSTALLER_ROOT) {
        assert.equal(
          registry,
          undefined,
          'A published installer bundle requires published image references.',
        );
        installationRelease = JSON.parse(
          await readFile(join(installerRoot, 'release-manifest.json'), 'utf8'),
        );
        assert.deepEqual(installationRelease.images, images);
        assert.equal(installationRelease.sourceRevision, sourceRevision);
        assert.equal(installationRelease.phase, 2);
      }
      config.images = installationRelease.images;
      const configPath = join(root, 'deployment.json');
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      const releasePath = join(root, 'release.json');
      await writeFile(releasePath, JSON.stringify(installationRelease), {
        mode: 0o600,
      });
      await writeFile(
        operatorPath,
        JSON.stringify({
          installationRoot: root,
          configurationPath: configPath,
          releasePath,
          releaseRoot: process.env.CC_AUTH_INSTALLER_ROOT
            ? installerRoot
            : root,
          project,
          connectAddress: '127.0.0.1',
          bindAddress: '127.0.0.1',
          localRegistryHttp: Boolean(registry),
          preflightExceptions: [
            {
              name: 'district-dns',
              reason:
                'The synthetic provider and edge use isolated loopback routing.',
            },
            {
              name: 'time-synchronization',
              reason:
                'The disposable fixture does not establish district time-service evidence.',
            },
            {
              name: 'storage-capacity',
              reason:
                'The synthetic fixture does not reserve district storage capacity.',
            },
          ],
        }),
        { mode: 0o600 },
      );
      await mkdir(bin, { mode: 0o700 });
      const realDocker = execFileSync('which', ['docker'], {
        encoding: 'utf8',
      }).trim();
      // Preserve installer output. Only the fixture runtime trusts the synthetic provider.
      await writeFile(
        join(bin, 'docker'),
        `#!${process.execPath}
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2), index=args.indexOf('-f')+1;
if(args[0]==='compose' && args[index]===${JSON.stringify(composePath)} && fs.existsSync(args[index])) {
  const doc=JSON.parse(fs.readFileSync(args[index]));
  doc.services.api.environment.NODE_EXTRA_CA_CERTS='/run/qualification/ca.pem';
  doc.services.api.extra_hosts=['host.docker.internal:host-gateway'];
  doc.services.api.volumes.push({type:'bind',source:${JSON.stringify(certPath)},target:'/run/qualification/ca.pem',read_only:true});
  fs.writeFileSync(${JSON.stringify(runtimePath)},JSON.stringify(doc),{mode:0o600});
  args[index]=${JSON.stringify(runtimePath)};
}
const result=spawnSync(${JSON.stringify(realDocker)},args,{stdio:'inherit'});
process.exit(result.status??1);
`,
        { mode: 0o700 },
      );
      process.stdout.write(
        'Installing the all-Docker application through the CLI.\n',
      );
      assert.equal((await cli('prepare')).status, 'prepared');
      rendered = JSON.parse(await readFile(composePath, 'utf8'));
      assert.equal((await cli('resume')).status, 'ready');
      assert.equal((await cli('resume')).status, 'ready');
      const originalRender = await readFile(composePath, 'utf8');
      const bootstrapFile = join(privateRoot, 'bootstrap');
      const readiness = await httpsStartup({
        url: publicOrigin,
        connectAddress: '127.0.0.1',
        caFile: certPath,
        bootstrapFile,
      });
      assert.equal(readiness.status, 'ready');
      assert.equal(readiness.checks.length, 8);
      const enrolled = applicationAccess(composePath, project, {
        action: 'initialize',
        issuer: provider.issuer,
        subject: 'administrator',
        displayName: 'Synthetic administrator',
      });
      assert.ok(enrolled.principalId);
      const replicaObservations = [];
      let sessionCookie;
      const verifyReplicas = async (context, phase, expectedStatus = 200) => {
        if (context) {
          sessionCookie = (await context.cookies())
            .filter((cookie) => cookie.name.startsWith('__Host-'))
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join('; ');
        }
        assert.ok(sessionCookie);
        const replicas = compose('ps', '--quiet', 'api')
          .split('\n')
          .filter(Boolean);
        assert.equal(replicas.length, 2);
        for (const replica of replicas) {
          const inspected = JSON.parse(docker('inspect', replica))[0];
          const endpoint = new URL(config.services.api.endpoint.url);
          endpoint.hostname =
            inspected.NetworkSettings.Networks[`${project}_internal`].IPAddress;
          endpoint.pathname = '/api/auth/session';
          let observation;
          await expect
            .poll(
              () => {
                observation = JSON.parse(
                  execFileSync(
                    'docker',
                    [
                      'exec',
                      '-i',
                      replicas[0],
                      'node',
                      '--input-type=module',
                      '-e',
                      `import fs from 'node:fs';const input=JSON.parse(fs.readFileSync(0,'utf8'));
const response=await fetch(input.url,{headers:{cookie:input.cookie,host:input.host,'x-forwarded-proto':'https'},signal:AbortSignal.timeout(10000)});
let body;try{body=await response.json()}catch{}
console.log(JSON.stringify({status:response.status,principalId:body?.identity?.id}));`,
                    ],
                    {
                      input: JSON.stringify({
                        url: endpoint.href,
                        cookie: sessionCookie,
                        host: new URL(publicOrigin).host,
                      }),
                      encoding: 'utf8',
                      stdio: ['pipe', 'pipe', 'pipe'],
                      timeout: 15000,
                    },
                  ),
                );
                return observation.status;
              },
              { timeout: 30000 },
            )
            .toBe(expectedStatus);
          if (expectedStatus === 200)
            assert.equal(observation.principalId, enrolled.principalId);
          replicaObservations.push({
            phase,
            container: replica,
            ...observation,
          });
        }
      };
      const addresses = () =>
        Object.fromEntries(
          ['api', 'frontend', 'workers'].map((service) => [
            service,
            JSON.parse(docker('inspect', `${project}-${service}-1`))[0]
              .NetworkSettings.Networks[`${project}_internal`].IPAddress,
          ]),
        );
      const initialAddresses = addresses();
      const browser = await applicationBrowser(
        publicOrigin,
        async ({ page, context, checks }) => {
          await verifyReplicas(context, 'initial-session');
          await page.getByRole('button', { name: 'Choose theme' }).click();
          await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
          await expect(page.locator('html')).toHaveAttribute(
            'data-theme',
            'dark',
          );
          compose('restart', 'api', 'frontend', 'workers');
          compose('up', '-d', '--wait', '--wait-timeout', '120');
          const restartedAddresses = addresses();
          await verifyReplicas(context, 'restart-session');
          await page.reload();
          await expect(
            page.getByRole('heading', { name: 'Diagnostics', exact: true }),
          ).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute(
            'data-theme',
            'dark',
          );
          await checks({ recoverySeconds: 60 });
          for (const command of ['stop', 'uninstall']) {
            assert.equal((await cli(command)).dataPreserved, true);
            assert.equal((await cli('resume')).status, 'ready');
            await page.reload();
            await expect(
              page.getByRole('heading', { name: 'Sign in', exact: true }),
            ).toBeVisible();
            await page
              .getByRole('link', { name: 'Sign in to Campus Commander' })
              .click();
            await expect(
              page.getByRole('heading', { name: 'Your account', exact: true }),
            ).toBeVisible({ timeout: 15000 });
            await expect(page.locator('html')).toHaveAttribute(
              'data-theme',
              'dark',
            );
            await checks({ recoverySeconds: 60 });
            await verifyReplicas(context, `${command}-resume-session`);
          }
          return {
            restartRecoveryBoundSeconds: 60,
            networkAddresses: {
              before: initialAddresses,
              after: restartedAddresses,
            },
          };
        },
      );
      await verifyReplicas(undefined, 'signed-out-session', 401);
      assert.equal(await readFile(composePath, 'utf8'), originalRender);
      assert.deepEqual(
        JSON.parse(await readFile(releasePath, 'utf8')),
        installationRelease,
      );
      await mkdir('dist/phase-2-evidence', { recursive: true });
      if (browser.screenReader) {
        await writeFile(
          'dist/phase-2-evidence/screen-reader.json',
          JSON.stringify(
            {
              ...browser.screenReader,
              images,
              application: {
                status: browser.status,
                operations: browser.operations,
                observations: browser.observations,
              },
            },
            null,
            2,
          ),
        );
      }
      await writeFile(
        'dist/phase-2-evidence/all-docker-profile.json',
        JSON.stringify(
          {
            status: 'passed',
            profile: 'all-docker',
            recordedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            images,
            sourceRevision,
            imageBuildId,
            workingTree,
            imageMirrors: registry?.copies ?? [],
            installer: {
              status: 'passed',
              commands: [
                'prepare',
                'resume',
                'resume',
                'stop',
                'resume',
                'uninstall',
                'resume',
              ],
              repeatedResume: true,
              redisSessionsDiscarded: true,
              freshSignInPreservesPreferences: true,
              originalRenderPreserved: true,
              source: process.env.CC_AUTH_INSTALLER_ROOT
                ? 'extracted-published-bundle'
                : 'workspace',
            },
            browser,
            readinessChecks: readiness.checks.map(({ name }) => name),
            sessionSurvivedRestart: true,
            apiReplicaCount: 2,
            replicaObservations,
            logoutRejectedAcrossReplicas: true,
            limits: [
              'Synthetic provider CA and loopback port replace district ingress.',
              'Upgrade and isolated restore require separate evidence.',
            ],
          },
          null,
          2,
        ),
      );
    } catch (error) {
      failed = true;
      process.stderr.write(`Qualification fixture: ${project} at ${root}\n`);
      if (rendered) {
        try {
          process.stderr.write(compose('ps', '-a'));
        } catch {
          /* Preserve the original failure. */
        }
      }
      throw error;
    } finally {
      if (
        rendered &&
        !(failed && process.env.CC_PHASE2_KEEP_FIXTURE === 'true')
      )
        compose('down', '--volumes', '--remove-orphans');
      await provider?.close();
      await registry?.close();
      if (!(failed && process.env.CC_PHASE2_KEEP_FIXTURE === 'true'))
        await rm(root, { recursive: true, force: true });
    }
  },
);
