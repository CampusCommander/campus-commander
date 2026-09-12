import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { expect } from '@playwright/test';
import { renderKubernetes } from '../deployment/kubernetes/render.mjs';
import { startProvider } from './provider-fixture.mjs';
import { applicationBrowser } from './profile-browser.mjs';
import { qualifyKubernetesUpgrade } from './kubernetes-upgrade-fixture.mjs';
import { faultKubernetesCertificates } from './kubernetes-certificates-fixture.mjs';
import { faultKubernetes } from './kubernetes-faults-fixture.mjs';
import { prepareKubernetesInstaller } from './kubernetes-installer-fixture.mjs';
import { kubernetesReplicaProbe } from './kubernetes-replicas-fixture.mjs';
import { createKubernetesCapacityVolume } from './kubernetes-capacity-volume.mjs';
import { qualifyKubernetesCapacity } from './kubernetes-capacity-fixture.mjs';

const execute = promisify(execFile);
const run = async (file, args, input, options = {}) => {
  const operation = execute(file, args, {
    timeout: 900000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (input !== undefined) operation.child.stdin.end(input);
  return (await operation).stdout.trim();
};
const docker = (...args) => run('docker', args);

test(
  'Kubernetes Phase 2 shares sessions across two API replicas and survives worker rescheduling',
  { timeout: 1200000 },
  async () => {
    const kind = process.env.CC_KIND_BINARY ?? 'kind';
    const project = `cc-capacity-kube-${randomBytes(6).toString('hex')}`;
    const root = await mkdtemp(`/tmp/${project}-`);
    const kubeconfig = join(root, 'kubeconfig');
    const kube = (args, input) =>
      run(
        'kubectl',
        [
          '--kubeconfig',
          kubeconfig,
          '--context',
          `kind-${project}`,
          '-n',
          project,
          ...args,
        ],
        input,
      );
    let provider,
      forward,
      created = false;
    const started = Date.now();
    let faultEvidence;
    let certificateEvidence;
    let replicaEvidence;
    let capacityVolume, capacityEvidence;
    try {
      const listener = createServer().listen(0, '127.0.0.1');
      await once(listener, 'listening');
      const publicPort = listener.address().port;
      await new Promise((done) => listener.close(done));
      const publicOrigin = `https://campus.example.org:${publicPort}`;
      const caFile = join(root, 'provider.crt'),
        keyFile = join(root, 'provider.key');
      await run('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyFile,
        '-out',
        caFile,
        '-days',
        '1',
        '-subj',
        '/CN=host.docker.internal',
        '-addext',
        'subjectAltName=DNS:host.docker.internal',
      ]);
      const password = randomUUID(),
        clientSecretFile = join(root, 'oidc-client');
      await writeFile(clientSecretFile, password, { mode: 0o600 });
      provider = await startProvider({
        certificate: await readFile(caFile),
        privateKey: await readFile(keyFile),
        publicOrigin,
        password,
      });
      const images = {};
      const revisions = new Set();
      for (const service of ['frontend', 'api', 'worker']) {
        const ref =
          process.env[`CC_AUTH_${service.toUpperCase()}_IMAGE`] ??
          `campus-commander/${service}:cc-6`;
        const inspected = JSON.parse(await docker('image', 'inspect', ref))[0];
        revisions.add(
          inspected.Config.Labels['org.opencontainers.image.revision'],
        );
        images[service === 'worker' ? 'workers' : service] = ref.includes(
          '@sha256:',
        )
          ? ref
          : inspected.RepoDigests[0];
      }
      assert.equal(
        revisions.size,
        1,
        'Application images must share one source revision.',
      );
      const [imageBuildId] = revisions;
      assert.match(imageBuildId, /^[a-f0-9]{40}(?:-dirty)?$/);
      const sourceRevision = imageBuildId.slice(0, 40);
      const workingTree = imageBuildId.endsWith('-dirty')
        ? 'uncommitted-candidate'
        : 'clean';
      if (
        Object.values(images).every((image) =>
          image.startsWith('ghcr.io/campuscommander/'),
        )
      )
        assert.equal(workingTree, 'clean');
      const release = {
        schemaVersion: 1,
        sourceRevision,
        architectures: ['linux/amd64'],
        images,
      };
      const releaseFile = join(root, 'release.json');
      await writeFile(releaseFile, JSON.stringify(release), { mode: 0o600 });
      const baseline =
        process.env.CC_AUTH_KUBERNETES_UPGRADE === '1'
          ? JSON.parse(
              await readFile(
                'deployment/qualification/phase-1-upgrade-baseline.json',
                'utf8',
              ),
            )
          : undefined;
      const initialReleaseFile = join(root, 'initial-release.json');
      await writeFile(initialReleaseFile, JSON.stringify(baseline ?? release), {
        mode: 0o600,
      });
      for (const claim of ['campus-artifacts', 'kestra-internal']) {
        const path = join(
          root,
          'shared',
          claim,
          claim === 'campus-artifacts' ? 'artifacts' : 'kestra',
        );
        await mkdir(path, { recursive: true, mode: 0o700 });
      }
      await chmod(root, 0o755);
      if (process.env.CC_AUTH_KUBERNETES_CAPACITY === '1') {
        assert.equal(
          baseline,
          undefined,
          'Capacity uses a fresh Phase 2 installation.',
        );
        capacityVolume = await createKubernetesCapacityVolume({
          root,
          project,
          docker,
          image: images.api,
        });
      }
      const kindFile = join(root, 'kind.json');
      await writeFile(
        kindFile,
        JSON.stringify({
          kind: 'Cluster',
          apiVersion: 'kind.x-k8s.io/v1alpha4',
          nodes: ['control-plane', 'worker', 'worker'].map((role) => ({
            role,
            extraMounts: [
              {
                hostPath: join(root, 'shared'),
                containerPath: '/var/local/cc-synthetic-shared',
              },
            ],
          })),
        }),
      );
      process.stdout.write(
        'Create the dedicated three-node Kubernetes fixture.\n',
      );
      created = true;
      await run(
        kind,
        [
          'create',
          'cluster',
          '--name',
          project,
          '--image',
          'kindest/node:v1.35.8',
          '--config',
          kindFile,
          '--kubeconfig',
          kubeconfig,
          '--wait',
          '180s',
        ],
        undefined,
        capacityVolume ? { env: capacityVolume.environment } : {},
      );
      const hostGateway = await docker(
        'run',
        '--rm',
        '--network',
        'none',
        '--add-host',
        'host.docker.internal:host-gateway',
        '--entrypoint',
        'node',
        images.api,
        '-e',
        "const fs=require('node:fs'),net=require('node:net');const row=fs.readFileSync('/etc/hosts','utf8').split('\\n').map(x=>x.trim().split(/\\s+/)).find(x=>x.includes('host.docker.internal')&&net.isIP(x[0])===4);if(!row)process.exit(1);console.log(row[0]);",
      );
      const config = JSON.parse(
        await readFile('deployment/examples/kubernetes.json', 'utf8'),
      );
      config.images = images;
      config.services.api.placement.replicas = 2;
      const operator = JSON.parse(
        await readFile('deployment/kubernetes/operator.example.json', 'utf8'),
      );
      operator.release = release;
      const imageSet = new Set();
      for (const image of Object.values(baseline?.images ?? {}))
        imageSet.add(image);
      for (const item of renderKubernetes(config, operator).items) {
        const pod = item.spec?.template?.spec;
        for (const container of [
          ...(pod?.containers ?? []),
          ...(pod?.initContainers ?? []),
        ])
          imageSet.add(container.image);
      }
      process.stdout.write(
        'Load the exact runtime image digests into all nodes.\n',
      );
      const archive = join(root, 'images.tar');
      for (const image of imageSet) {
        try {
          await docker('image', 'inspect', image);
        } catch {
          await docker('pull', image);
        }
      }
      await docker('save', '--output', archive, ...imageSet);
      const nodes = (
        await run(kind, ['get', 'nodes', '--name', project])
      ).split('\n');
      for (const node of nodes) {
        const child = spawn(
          'docker',
          [
            'exec',
            '-i',
            node,
            'ctr',
            '--namespace=k8s.io',
            'images',
            'import',
            '--platform',
            'linux/amd64',
            '--digests',
            '-',
          ],
          { stdio: ['pipe', 'ignore', 'pipe'] },
        );
        let error = '';
        child.stderr.on('data', (bytes) => {
          error += bytes;
        });
        const completion = new Promise((done, reject) => {
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0
              ? done()
              : reject(new Error(`Image import failed: ${error.slice(-1000)}`)),
          );
        });
        await Promise.all([
          pipeline(createReadStream(archive), child.stdin),
          completion,
        ]);
        const imported = (
          await docker(
            'exec',
            node,
            'ctr',
            '--namespace=k8s.io',
            'images',
            'list',
            '-q',
          )
        ).split('\n');
        for (const ref of imageSet) {
          const repository = ref.split('@')[0];
          const registry = repository.split('/')[0];
          const canonical = !repository.includes('/')
            ? `docker.io/library/${ref}`
            : registry.includes('.') ||
                registry.includes(':') ||
                registry === 'localhost'
              ? ref
              : `docker.io/${ref}`;
          if (imported.includes(canonical)) continue;
          const source = imported.find(
            (name) =>
              name.startsWith('import-') &&
              name.endsWith(`@${ref.split('@')[1]}`),
          );
          assert.ok(source, 'The archive must contain every requested digest.');
          await docker(
            'exec',
            node,
            'ctr',
            '--namespace=k8s.io',
            'images',
            'tag',
            source,
            canonical,
          );
        }
        for (const name of imported) {
          if (name.startsWith('import-'))
            await docker(
              'exec',
              node,
              'ctr',
              '--namespace=k8s.io',
              'images',
              'rm',
              name,
            );
        }
        await docker('exec', node, 'systemctl', 'restart', 'containerd');
      }
      await rm(archive);
      const descriptor = join(root, 'fixture.json');
      const fixture = {
        qualificationOnly: true,
        root,
        project,
        application: {
          upgradeFromPhase1: Boolean(baseline),
          installerOwnsWorkloads: true,
          auth: {
            issuer: provider.issuer,
            clientId: 'qualification',
            publicOrigin,
            clientSecretRef: {
              provider: 'kubernetes',
              name: 'campus-oidc',
              key: 'client-secret',
            },
          },
          hostGateway,
          caFile,
          clientSecretFile,
        },
      };
      await writeFile(descriptor, JSON.stringify(fixture), { mode: 0o600 });
      await execute(
        process.execPath,
        ['deployment/kubernetes/integration.mjs'],
        {
          env: {
            ...process.env,
            CC_KUBERNETES_CAPACITY_FIXTURE: descriptor,
            CC_QUALIFICATION_RELEASE: initialReleaseFile,
          },
          timeout: 180000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      const startForward = async (namespace = project, edgePod) => {
        const currentResources = JSON.parse(
          await readFile(join(root, 'runtime', 'resources.json'), 'utf8'),
        );
        const edgeService = currentResources.items.find(
          (item) => item.kind === 'Service' && item.metadata.name === 'edge',
        );
        const servicePort = edgeService.spec.ports[0];
        const edgePort = !edgePod
          ? servicePort.port
          : typeof servicePort.targetPort === 'number'
            ? servicePort.targetPort
            : currentResources.items
                .find(
                  (item) =>
                    item.kind === 'Deployment' && item.metadata.name === 'edge',
                )
                .spec.template.spec.containers.flatMap(
                  (container) => container.ports ?? [],
                )
                .find((port) => port.name === servicePort.targetPort)
                .containerPort;

        if (
          forward &&
          forward.exitCode === null &&
          forward.signalCode === null
        ) {
          const ended = once(forward, 'exit');
          forward.kill('SIGTERM');
          await ended;
        }
        forward = spawn(
          'kubectl',
          [
            '--kubeconfig',
            kubeconfig,
            '--context',
            `kind-${project}`,
            '-n',
            namespace,
            'port-forward',
            edgePod ? `pod/${edgePod}` : 'service/edge',
            `${publicPort}:${edgePort}`,
            '--address=127.0.0.1',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let forwardError = '';
        forward.stderr.on('data', (bytes) => {
          forwardError += bytes;
        });
        await new Promise((done, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Edge port forwarding timed out.')),
            15000,
          );
          forward.stdout.on('data', (bytes) => {
            if (String(bytes).includes('Forwarding from')) {
              clearTimeout(timer);
              done();
            }
          });
          forward.once('exit', () => {
            clearTimeout(timer);
            reject(
              new Error(
                `Edge port forwarding stopped: ${forwardError.slice(-1000)}`,
              ),
            );
          });
        });
      };
      const installer = await prepareKubernetesInstaller({
        root,
        project,
        kubeconfig,
        kube,
        release: baseline ?? release,
        application: fixture.application,
      });
      await installer.resume(startForward);
      await installer.resume(startForward);
      for (const name of [
        'application-postgres',
        'kestra-postgres',
        'redis',
        'kestra',
        'workers',
        'api',
        'frontend',
        'edge',
      ]) {
        process.stdout.write(`Wait for ${name}.\n`);
        await kube([
          'rollout',
          'status',
          `deployment/${name}`,
          '--timeout=300s',
        ]);
      }
      const upgrade = baseline
        ? await qualifyKubernetesUpgrade({
            root,
            kube,
            baseline,
            release,
            application: fixture.application,
            installer,
            startForward,
          })
        : undefined;
      const resources = installer.resources();
      const template = structuredClone(
        resources.items.find((item) => item.kind === 'Job').spec.template,
      );
      for (const volume of template.spec.volumes)
        if (volume.configMap)
          await kube(['get', 'configmap', volume.configMap.name]);
      const request = {
        action: 'initialize',
        issuer: provider.issuer,
        subject: 'administrator',
        displayName: 'Synthetic administrator',
      };
      template.spec.containers[0].command = [
        'node',
        '/app/deployment/bootstrap/application-access-cli.mjs',
        '/config/deployment.json',
        '/config/operator.json',
        '/run/enrollment/request',
      ];
      template.spec.containers[0].volumeMounts.push({
        name: 'enrollment',
        mountPath: '/run/enrollment',
        readOnly: true,
      });
      template.spec.volumes.push({
        name: 'enrollment',
        secret: { secretName: 'qualification-enrollment' },
      });
      await kube(
        ['apply', '-f', '-'],
        JSON.stringify({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: 'qualification-enrollment', namespace: project },
          stringData: { request: JSON.stringify(request) },
        }),
      );
      await kube(
        ['apply', '-f', '-'],
        JSON.stringify({
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: { name: 'qualification-enrollment', namespace: project },
          spec: { backoffLimit: 0, activeDeadlineSeconds: 60, template },
        }),
      );
      await kube([
        'wait',
        '--for=condition=complete',
        'job/qualification-enrollment',
        '--timeout=90s',
      ]);
      let restoration;
      let applicationFaults;
      let certificateFaults;
      let capacityFaults;
      let installerEvidence;
      const replicas =
        process.env.CC_AUTH_KUBERNETES_REPLICAS === '1'
          ? kubernetesReplicaProbe(kube)
          : undefined;
      const application = await applicationBrowser(
        publicOrigin,
        async ({ page, context, checks }) => {
          const originalPods = await replicas?.verify(
            context,
            'initial-session',
          );
          const pods = JSON.parse(
            await kube([
              'get',
              'pods',
              '-l',
              'app.kubernetes.io/name=api',
              '-o',
              'json',
            ]),
          ).items;
          assert.equal(pods.length, 2);
          await kube(['delete', 'pod', pods[0].metadata.name, '--wait=true']);
          await kube(['rollout', 'status', 'deployment/api', '--timeout=180s']);
          await page.reload();
          await expect(
            page.getByRole('heading', { name: 'Diagnostics', exact: true }),
          ).toBeVisible({ timeout: 15000 });
          await checks();
          if (replicas) {
            const replacements = await replicas.verify(
              context,
              'replacement-session',
            );
            assert.equal(
              replacements.filter((uid) => originalPods.includes(uid)).length,
              1,
            );
          }
          await kube(['scale', 'deployment/workers', '--replicas=1']);
          await kube([
            'rollout',
            'status',
            'deployment/workers',
            '--timeout=180s',
          ]);
          const worker = JSON.parse(
            await kube([
              'get',
              'pods',
              '-l',
              'app.kubernetes.io/name=workers',
              '-o',
              'json',
            ]),
          ).items.find((pod) => !pod.metadata.deletionTimestamp);
          await kube(['cordon', worker.spec.nodeName]);
          try {
            await kube(['delete', 'pod', worker.metadata.name, '--wait=true']);
            await kube([
              'rollout',
              'status',
              'deployment/workers',
              '--timeout=180s',
            ]);
            const replacements = JSON.parse(
              await kube([
                'get',
                'pods',
                '-l',
                'app.kubernetes.io/name=workers',
                '-o',
                'json',
              ]),
            ).items;
            assert.ok(
              replacements.every(
                (pod) => pod.spec.nodeName !== worker.spec.nodeName,
              ),
            );
            await checks();
          } finally {
            await kube(['uncordon', worker.spec.nodeName]);
            await kube(['scale', 'deployment/workers', '--replicas=2']);
            await kube([
              'rollout',
              'status',
              'deployment/workers',
              '--timeout=180s',
            ]);
          }
          await checks();
          await replicas?.verify(context, 'worker-reschedule-session');
          if (installer) {
            const preference = page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === '/api/auth/preferences' &&
                response.request().method() === 'POST',
            );
            await page.getByRole('button', { name: 'Choose theme' }).click();
            await page
              .getByRole('menuitem', { name: 'Use dark theme' })
              .click();
            assert.equal((await preference).status(), 201);
            for (const command of ['stop', 'uninstall']) {
              assert.equal((await installer.cli(command)).dataPreserved, true);
              await installer.resume(startForward);
              await replicas?.verify(
                undefined,
                `${command}-revoked-session`,
                401,
              );
              await page.reload();
              await expect(
                page.getByRole('heading', { name: 'Sign in', exact: true }),
              ).toBeVisible();
              await page
                .getByRole('link', { name: 'Sign in to Campus Commander' })
                .click();
              await expect(
                page.getByRole('heading', {
                  name: 'Your account',
                  exact: true,
                }),
              ).toBeVisible({ timeout: 15000 });
              await expect(page.locator('html')).toHaveAttribute(
                'data-theme',
                'dark',
              );
              await checks({ recoverySeconds: 120 });
              await replicas?.verify(context, `${command}-resume-session`);
            }
          }
          if (process.env.CC_AUTH_KUBERNETES_FAULTS === '1') {
            applicationFaults = await faultKubernetes({
              root,
              project,
              kube,
              release,
              upgrade,
              page,
              checks,
            });
          }
          if (process.env.CC_AUTH_KUBERNETES_CERTIFICATES === '1') {
            certificateFaults = await faultKubernetesCertificates({
              root,
              project,
              kube,
              release,
              upgrade,
              page,
              checks,
              startForward,
            });
          }
          if (capacityVolume)
            capacityFaults = await qualifyKubernetesCapacity({
              root,
              project,
              kube,
              volume: capacityVolume,
              page,
              checks,
            });
          // Capture source placement before isolated restore stops its writers.
          installerEvidence = await installer.evidence();
          if (process.env.CC_AUTH_KUBERNETES_RESTORE === '1') {
            const preference = page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === '/api/auth/preferences' &&
                response.request().method() === 'POST',
            );
            await page.getByRole('button', { name: 'Choose theme' }).click();
            await page
              .getByRole('menuitem', { name: 'Use dark theme' })
              .click();
            assert.equal((await preference).status(), 201);
            assert.ok(
              (await context.cookies()).some((cookie) =>
                cookie.name.startsWith('__Host-'),
              ),
            );
            process.stdout.write(
              'Restore application state into the isolated Kubernetes namespace.\n',
            );
            await execute(
              process.execPath,
              ['deployment/kubernetes/restore-integration.mjs'],
              {
                env: {
                  ...process.env,
                  CC_KUBERNETES_CAPACITY_FIXTURE: descriptor,
                },
                timeout: 900000,
                maxBuffer: 8 * 1024 * 1024,
              },
            );
            const restored = JSON.parse(
              await readFile(
                join(root, 'kubernetes-restore-foundation.json'),
                'utf8',
              ),
            );
            assert.equal(restored.status, 'pass');
            assert.equal(
              restored.applicationState.exactIdentityAndPreferences,
              true,
            );
            assert.equal(restored.applicationState.exactSecurityEvents, true);
            await startForward(restored.targetNamespace);
            await page.goto(publicOrigin);
            assert.equal(
              await page.evaluate(
                async () => (await fetch('/api/auth/session')).status,
              ),
              401,
            );
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
            await checks();
            restoration = {
              ...restored,
              status: 'passed',
              oldSessionRejected: true,
              preservedTheme: 'dark',
              restoredOperations: [
                'postgresql',
                'redis',
                'kestra',
                'artifacts',
              ],
            };
          }
        },
        {
          afterSignOut: replicas
            ? () => replicas.verify(undefined, 'signed-out-session', 401)
            : undefined,
        },
      );
      assert.ok(installerEvidence);
      if (capacityFaults)
        capacityEvidence = {
          status: 'passed',
          profile: 'kubernetes',
          sourceRevision,
          images,
          application,
          capacity: capacityFaults,
          installer: installerEvidence,
          recordedAt: new Date().toISOString(),
          limits: capacityFaults.limits,
        };
      if (replicas)
        replicaEvidence = {
          status: 'passed',
          profile: 'kubernetes',
          sourceRevision,
          images,
          application,
          upgrade,
          installer: installerEvidence,
          replicaObservations: replicas.observations,
          apiReplicaCount: 2,
          logoutRejectedAcrossReplicas: true,
          replacementPreservedOneReplica: true,
          recordedAt: new Date().toISOString(),
          limits: [
            'Two API replicas run in a dedicated Kind cluster on one physical Docker host.',
          ],
        };
      await mkdir('dist/phase-2-evidence', { recursive: true });
      if (applicationFaults) {
        assert.equal(applicationFaults.status, 'passed');
        faultEvidence = {
          status: 'passed',
          profile: 'kubernetes',
          sourceRevision,
          images,
          recordedAt: new Date().toISOString(),
          application,
          faults: applicationFaults,
          upgrade,
          installer: installerEvidence,
          limits: applicationFaults.limits,
        };
      }
      if (certificateFaults) {
        certificateEvidence = {
          status: 'passed',
          profile: 'kubernetes',
          sourceRevision,
          images,
          recordedAt: new Date().toISOString(),
          application,
          certificates: certificateFaults,
          upgrade,
          installer: installerEvidence,
          limits: certificateFaults.limits,
        };
      }
      if (restoration)
        await writeFile(
          'dist/phase-2-evidence/kubernetes-restore.json',
          JSON.stringify({ ...restoration, application }, null, 2),
        );
      await writeFile(
        `dist/phase-2-evidence/${baseline ? 'kubernetes-upgrade' : 'kubernetes-profile'}.json`,
        JSON.stringify(
          {
            status: 'PASS',
            checkedAt: new Date().toISOString(),
            elapsedMilliseconds: Date.now() - started,
            images,
            sourceRevision,
            imageBuildId,
            workingTree,
            qualificationSourceRevision: await run('git', [
              'rev-parse',
              'HEAD',
            ]),
            qualificationWorkingTree: (await run('git', [
              'status',
              '--porcelain',
            ]))
              ? 'uncommitted-candidate'
              : 'clean',
            ...(upgrade ? { upgrade } : {}),
            application,
            nodes: nodes.length,
            apiReplicas: 2,
            workerRescheduled: true,
            installer: installerEvidence,
            limits: [
              'Three Kind nodes share one Docker host and synthetic storage.',
              'Kind default networking does not enforce NetworkPolicy.',
              'District DNS, identity provider, CNI enforcement, and storage remain separate qualification requirements.',
              ...(upgrade
                ? ['Isolated restore requires separate evidence.']
                : ['Upgrade and isolated restore require separate evidence.']),
            ],
          },
          null,
          2,
        ),
      );
    } catch (error) {
      if (created) {
        try {
          const pods = JSON.parse(await kube(['get', 'pods', '-o', 'json']));
          await writeFile(join(root, 'pod-status.json'), JSON.stringify(pods), {
            mode: 0o600,
          });
          const events = JSON.parse(
            await kube(['get', 'events', '-o', 'json']),
          );
          const failure = {
            status: 'FAIL',
            checkedAt: new Date().toISOString(),
            pods: pods.items.map(({ metadata, status }) => ({
              name: metadata.name,
              phase: status.phase,
              conditions: status.conditions,
              containers: status.containerStatuses?.map(
                ({ name, state, restartCount }) => ({
                  name,
                  state,
                  restartCount,
                }),
              ),
              initialization: status.initContainerStatuses?.map(
                ({ name, state, restartCount }) => ({
                  name,
                  state,
                  restartCount,
                }),
              ),
            })),
            events: events.items.map(({ reason, message, involvedObject }) => ({
              reason,
              message,
              object: involvedObject.name,
            })),
          };
          await mkdir('dist/phase-2-evidence', { recursive: true });
          await writeFile(
            'dist/phase-2-evidence/kubernetes-failure.json',
            JSON.stringify(failure, null, 2),
          );
        } catch {
          /* Preserve the original failure. */
        }
      }
      process.stderr.write(
        `Kubernetes qualification failed. Private fixture: ${root}\n`,
      );
      throw error;
    } finally {
      forward?.kill('SIGTERM');
      await provider?.close();
      if (created && process.env.CC_PHASE2_KEEP_FIXTURE !== 'true')
        await run(kind, [
          'delete',
          'cluster',
          '--name',
          project,
          '--kubeconfig',
          kubeconfig,
        ]);
      if (capacityVolume) {
        assert.notEqual(process.env.CC_PHASE2_KEEP_FIXTURE, 'true');
        await capacityVolume.close();
      }
    }
    if (capacityEvidence) {
      assert.ok(
        !(await run(kind, ['get', 'clusters'])).split('\n').includes(project),
      );
      await writeFile(
        'dist/phase-2-evidence/kubernetes-capacity.json',
        JSON.stringify(
          {
            ...capacityEvidence,
            ownedClusterRemoved: true,
            ownedCapacityVolumeRemoved: true,
          },
          null,
          2,
        ),
      );
    }
    if (replicaEvidence) {
      assert.notEqual(process.env.CC_PHASE2_KEEP_FIXTURE, 'true');
      assert.ok(
        !(await run(kind, ['get', 'clusters'])).split('\n').includes(project),
      );
      await writeFile(
        'dist/phase-2-evidence/kubernetes-replicas.json',
        JSON.stringify(
          { ...replicaEvidence, ownedClusterRemoved: true },
          null,
          2,
        ),
      );
    }
    if (certificateEvidence) {
      assert.notEqual(process.env.CC_PHASE2_KEEP_FIXTURE, 'true');
      assert.ok(
        !(await run(kind, ['get', 'clusters'])).split('\n').includes(project),
      );
      await writeFile(
        'dist/phase-2-evidence/kubernetes-certificates.json',
        JSON.stringify(
          { ...certificateEvidence, ownedClusterRemoved: true },
          null,
          2,
        ),
      );
    }
    if (faultEvidence) {
      assert.notEqual(process.env.CC_PHASE2_KEEP_FIXTURE, 'true');
      const clusters = (await run(kind, ['get', 'clusters'])).split('\n');
      assert.ok(!clusters.includes(project));
      await writeFile(
        'dist/phase-2-evidence/kubernetes-process-faults.json',
        JSON.stringify(
          { ...faultEvidence, ownedClusterRemoved: true },
          null,
          2,
        ),
      );
    }
  },
);
