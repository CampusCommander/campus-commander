import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);

/** Exercise the real installer against the caller's isolated Kind namespace. */
export async function prepareKubernetesInstaller({
  root,
  project,
  kubeconfig,
  kube,
  release,
  application,
}) {
  assert.match(project, /^cc-capacity-kube-[a-f0-9]{12}$/);
  assert.ok(root.startsWith(`/tmp/${project}-`));
  const installationRoot = join(root, 'installer');
  const runtime = join(root, 'runtime');
  const config = JSON.parse(
    await readFile(join(runtime, 'config.json'), 'utf8'),
  );
  const kubernetes = JSON.parse(
    await readFile(join(runtime, 'operator.json'), 'utf8'),
  );
  assert.equal(config.profile, 'kubernetes');
  assert.equal(config.phase, 2);
  assert.equal(kubernetes.namespace, project);
  assert.deepEqual(config.images, release.images);
  await mkdir(installationRoot, { mode: 0o700 });
  const privateRoot = join(installationRoot, 'private');
  await mkdir(privateRoot, { mode: 0o700 });
  const secrets = JSON.parse(
    await kube(['get', 'secrets', '-o', 'json']),
  ).items;
  for (const secret of secrets) {
    const directory = join(privateRoot, secret.metadata.name);
    await mkdir(directory, { mode: 0o700 });
    for (const [key, value] of Object.entries(secret.data ?? {}))
      await writeFile(join(directory, key), Buffer.from(value, 'base64'), {
        mode: 0o600,
      });
  }
  const installerRoot = resolve(process.env.CC_AUTH_INSTALLER_ROOT ?? '.');
  const source = process.env.CC_AUTH_INSTALLER_ROOT
    ? 'verified-extracted-bundle'
    : 'workspace';
  let inventory = { ...release, phase: 2, qualification: 'candidate-only' };
  if (process.env.CC_AUTH_INSTALLER_ROOT) {
    inventory = JSON.parse(
      await readFile(join(installerRoot, 'release-manifest.json'), 'utf8'),
    );
    assert.equal(inventory.phase, 2);
    assert.equal(inventory.sourceRevision, release.sourceRevision);
    assert.deepEqual(inventory.images, release.images);
  }
  const releasePath = join(installationRoot, 'release.json');
  await writeFile(releasePath, JSON.stringify(inventory), { mode: 0o600 });
  const operatorPath = join(installationRoot, 'operator.json');
  await writeFile(
    operatorPath,
    JSON.stringify({
      installationRoot,
      configurationPath: join(runtime, 'config.json'),
      releasePath,
      releaseRoot: process.env.CC_AUTH_INSTALLER_ROOT
        ? installerRoot
        : installationRoot,
      project,
      kubernetes,
      cluster: {
        context: `kind-${project}`,
        storageClasses: [...new Set(Object.values(kubernetes.storageClasses))],
      },
      connectAddress: '127.0.0.1',
      preflightExceptions: [
        {
          name: 'district-dns',
          reason:
            'The isolated fixture maps its synthetic edge hostname through loopback.',
        },
      ],
    }),
    { mode: 0o600 },
  );
  const bin = join(installationRoot, 'qualification-bin');
  await mkdir(bin, { mode: 0o700 });
  const realKubectl = (await execute('which', ['kubectl'])).stdout.trim();
  const generatedPath = join(installationRoot, 'kubernetes.json');
  const runtimePath = join(installationRoot, 'qualification-runtime.json');
  const providerModule = pathToFileURL(
    resolve('api-e2e/kubernetes-upgrade-fixture.mjs'),
  ).href;
  await writeFile(
    join(bin, 'kubectl'),
    `#!${process.execPath}
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {configureKubernetesProvider} from ${JSON.stringify(providerModule)};
const args=process.argv.slice(2), index=args.indexOf('-f')+1;
if(args.includes('apply') && args[index]===${JSON.stringify(generatedPath)}) {
  const resources=JSON.parse(fs.readFileSync(args[index]));
  configureKubernetesProvider(resources,${JSON.stringify({ hostGateway: application.hostGateway })});
  fs.writeFileSync(${JSON.stringify(runtimePath)},JSON.stringify(resources),{mode:0o600});
  args[index]=${JSON.stringify(runtimePath)};
}
const result=spawnSync(${JSON.stringify(realKubectl)},args,{stdio:'inherit'});
process.exit(result.status??1);
`,
    { mode: 0o700 },
  );
  const commands = [];
  const cli = async (command) => {
    const result = JSON.parse(
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
            env: {
              ...process.env,
              KUBECONFIG: kubeconfig,
              PATH: `${bin}:${process.env.PATH}`,
            },
            timeout: 300000,
            maxBuffer: 8 * 1024 * 1024,
          },
        )
      ).stdout,
    );
    if (['stop', 'uninstall'].includes(command)) {
      const rendered = JSON.parse(await readFile(generatedPath, 'utf8'));
      const names = rendered.items
        .filter((item) => item.kind === 'Deployment')
        .map((item) => item.metadata.name);
      const deadline = Date.now() + 180000;
      let remaining;
      do {
        remaining = JSON.parse(
          await kube([
            'get',
            'pods',
            '-l',
            `app.kubernetes.io/name in (${names.join(',')})`,
            '-o',
            'json',
          ]),
        ).items.length;
        if (remaining === 0) break;
        await new Promise((done) => setTimeout(done, 250));
      } while (Date.now() < deadline);
      assert.equal(
        remaining,
        0,
        'The lifecycle command must stop every application pod.',
      );
    }
    commands.push({ command, status: result.status });
    return result;
  };
  assert.equal((await cli('prepare')).status, 'prepared');
  const original = await readFile(generatedPath, 'utf8');
  return {
    cli,
    resources: () => JSON.parse(original),
    async resume(startForward) {
      const pending = cli('resume');
      // Attach rejection handling while the fixture waits for the edge workload.
      let completed;
      const settled = pending.then(
        (value) => (completed = { value }),
        (error) => (completed = { error }),
      );
      let available = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        if (completed?.error) throw completed.error;
        try {
          const edge = JSON.parse(
            await kube(['get', 'deployment', 'edge', '-o', 'json']),
          );
          if (
            edge.spec.replicas > 0 &&
            edge.status.observedGeneration >= edge.metadata.generation &&
            edge.status.availableReplicas >= edge.spec.replicas
          ) {
            available = true;
            break;
          }
        } catch {
          /* The CLI has not created the edge Deployment yet. */
        }
        await new Promise((done) => setTimeout(done, 1000));
      }
      if (available) await startForward();
      const result = await settled;
      if (result.error) throw result.error;
      assert.equal(
        available,
        true,
        'The installer must start the edge Deployment.',
      );
      assert.equal(result.value.status, 'ready');
      assert.equal(await readFile(generatedPath, 'utf8'), original);
    },
    async evidence() {
      assert.equal(await readFile(generatedPath, 'utf8'), original);
      const workers = JSON.parse(
        await kube([
          'get',
          'pods',
          '-l',
          'app.kubernetes.io/name=workers',
          '-o',
          'json',
        ]),
      ).items.filter((pod) => !pod.metadata.deletionTimestamp);
      const workerHosts = [...new Set(workers.map((pod) => pod.spec.nodeName))];
      assert.equal(workerHosts.length, 2);
      return {
        status: 'passed',
        commands,
        workerHosts,
        originalRenderPreserved: true,
        source,
      };
    },
  };
}
