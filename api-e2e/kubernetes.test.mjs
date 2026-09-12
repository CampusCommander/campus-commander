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

const execute = promisify(execFile);
const run = async (file, args, input) => {
  const operation = execute(file, args, {
    timeout: 900000,
    maxBuffer: 8 * 1024 * 1024,
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
      for (const service of ['frontend', 'api', 'worker']) {
        const ref =
          process.env[`CC_AUTH_${service.toUpperCase()}_IMAGE`] ??
          `campus-commander/${service}:cc-6`;
        const inspected = JSON.parse(await docker('image', 'inspect', ref))[0];
        images[service === 'worker' ? 'workers' : service] = ref.includes(
          '@sha256:',
        )
          ? ref
          : inspected.RepoDigests[0];
      }
      const release = {
        schemaVersion: 1,
        sourceRevision: await run('git', ['rev-parse', 'HEAD']),
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
      await run(kind, [
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
      ]);
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
          })
        : undefined;
      const resources = JSON.parse(
        await readFile(join(root, 'runtime', 'resources.json'), 'utf8'),
      );
      const template = structuredClone(
        resources.items.find((item) => item.kind === 'Job').spec.template,
      );
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
      const edgePort = resources.items.find(
        (item) => item.kind === 'Service' && item.metadata.name === 'edge',
      ).spec.ports[0].port;
      const startForward = async (namespace = project) => {
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
            'service/edge',
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
      await startForward();
      let restoration;
      const application = await applicationBrowser(
        publicOrigin,
        async ({ page, context, checks }) => {
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
      );
      await mkdir('dist/phase-2-evidence', { recursive: true });
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
            ...(upgrade ? { upgrade } : {}),
            application,
            nodes: nodes.length,
            apiReplicas: 2,
            workerRescheduled: true,
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
          await writeFile(
            join(root, 'pod-status.json'),
            await kube(['get', 'pods', '-o', 'json']),
            { mode: 0o600 },
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
    }
  },
);
