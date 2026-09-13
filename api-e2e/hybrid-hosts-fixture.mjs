import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { reserveHybridNetworks } from './hybrid-network-fixture.mjs';

const execute = promisify(execFile);
export const dockerHostImage =
  'docker@sha256:5efed980cba3fc126cf54e21a5a6ff8849d05b6e0623d6e7612f48e9cd6cd17e';

export async function outerDocker(args, options = {}) {
  return (
    await execute('docker', args, {
      timeout: 300000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    })
  ).stdout.trim();
}

/** Create independent Docker hosts with isolated daemons and shared fixture storage. */
export async function createHybridHosts({
  root,
  project,
  images,
  publicPort,
  boundedArtifacts = false,
}) {
  assert.match(project, /^cc-phase2-hybrid-[a-f0-9]{12}$/);
  assert.ok(root.startsWith(`/tmp/${project}-`));
  const network = `${project}-district`;
  const owned = [];
  let networkCreated = false;
  let artifactVolume;
  const hosts = [];
  const dnsRoot = join(root, 'dns');
  const imageCache = join(root, 'image-cache');
  const shared = join(root, 'shared');
  for (const directory of [dnsRoot, imageCache, shared])
    await mkdir(directory, { mode: 0o700 });
  const mappings = {};
  const writeDns = () =>
    writeFile(join(dnsRoot, 'hosts.json'), JSON.stringify(mappings), {
      mode: 0o600,
    });
  await writeDns();
  await copyFile(
    new URL('./hybrid-dns-fixture.mjs', import.meta.url),
    join(dnsRoot, 'server.mjs'),
  );
  const dockerfile = await readFile(
    new URL('./hybrid-host.Dockerfile', import.meta.url),
  );
  const hostImage = `cc-phase2-hybrid-host:${createHash('sha256')
    .update(dockerfile)
    .update(images.api)
    .digest('hex')
    .slice(0, 16)}`;
  const close = async () => {
    const failures = [];
    for (const name of [...owned].reverse()) {
      try {
        await outerDocker(['rm', '-f', '-v', name]);
      } catch (error) {
        failures.push(error);
      }
    }
    if (artifactVolume) {
      try {
        const volume = JSON.parse(
          await outerDocker(['volume', 'inspect', artifactVolume]),
        )[0];
        assert.equal(volume.Name, `${project}-bounded-artifacts`);
        assert.equal(
          volume.Labels['com.campus-commander.qualification'],
          project,
        );
        assert.equal(volume.Options.type, 'tmpfs');
        assert.equal(volume.Options.o, 'size=16m,uid=1000,gid=1000,mode=0700');
        await outerDocker(['volume', 'rm', artifactVolume]);
        const remaining = await outerDocker([
          'volume',
          'ls',
          '--quiet',
          '--filter',
          `label=com.campus-commander.qualification=${project}`,
        ]);
        assert.equal(remaining, '');
      } catch (error) {
        failures.push(error);
      }
    }
    if (networkCreated) {
      try {
        await outerDocker(['network', 'rm', network]);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Docker host fixture cleanup failed.');
  };
  try {
    if (boundedArtifacts) {
      const volumeName = `${project}-bounded-artifacts`;
      await outerDocker([
        'volume',
        'create',
        '--driver',
        'local',
        '--label',
        `com.campus-commander.qualification=${project}`,
        '--opt',
        'type=tmpfs',
        '--opt',
        'device=tmpfs',
        '--opt',
        'o=size=16m,uid=1000,gid=1000,mode=0700',
        volumeName,
      ]);
      artifactVolume = volumeName;
      await mkdir(join(shared, 'artifacts'), { mode: 0o700 });
    }
    try {
      await outerDocker(['image', 'inspect', hostImage]);
    } catch {
      const buildRoot = join(root, 'host-image');
      await mkdir(buildRoot, { mode: 0o700 });
      await writeFile(join(buildRoot, 'Dockerfile'), dockerfile);
      await outerDocker([
        'build',
        '--build-arg',
        `APPLICATION_IMAGE=${images.api}`,
        '--tag',
        hostImage,
        buildRoot,
      ]);
    }
    await outerDocker([
      'network',
      'create',
      '--label',
      `com.campus-commander.qualification=${project}`,
      network,
    ]);
    networkCreated = true;
    const dns = `${project}-dns`;
    await outerDocker([
      'run',
      '-d',
      '--name',
      dns,
      '--network',
      network,
      '--user',
      '1000:1000',
      '--read-only',
      '--cap-drop=ALL',
      '--sysctl',
      'net.ipv4.ip_unprivileged_port_start=0',
      '--mount',
      `type=bind,source=${dnsRoot},target=/fixture,readonly`,
      '--entrypoint',
      'node',
      images.api,
      '/fixture/server.mjs',
    ]);
    owned.push(dns);
    const address = async (name) =>
      JSON.parse(await outerDocker(['inspect', name]))[0].NetworkSettings
        .Networks[network].IPAddress;
    const dnsAddress = await address(dns);
    const networkIds = (await outerDocker(['network', 'ls', '--quiet']))
      .split('\n')
      .filter(Boolean);
    const outerNetworks = JSON.parse(
      await outerDocker(['network', 'inspect', ...networkIds]),
    );
    const daemonNetworks = reserveHybridNetworks(
      outerNetworks.flatMap((network) =>
        (network.IPAM.Config ?? []).map((item) => item.Subnet).filter(Boolean),
      ),
    );
    for (const [index, role] of [
      'controller',
      'worker-1',
      'worker-2',
    ].entries()) {
      const name = `${project}-${role}`;
      const hostRoot = join(root, role);
      await mkdir(hostRoot, { mode: 0o700 });
      await outerDocker([
        'run',
        '-d',
        '--privileged',
        '--cgroupns=private',
        '--tmpfs',
        '/tmp:mode=1777',
        '--name',
        name,
        '--network',
        network,
        '--dns',
        dnsAddress,
        '--label',
        `com.campus-commander.qualification=${project}`,
        '--mount',
        `type=bind,source=${hostRoot},target=${hostRoot}`,
        '--mount',
        `type=bind,source=${shared},target=${shared}`,
        ...(artifactVolume
          ? [
              '--mount',
              `type=volume,source=${artifactVolume},target=${join(shared, 'artifacts')},volume-nocopy`,
            ]
          : []),
        '--mount',
        `type=bind,source=${imageCache},target=/image-cache,readonly`,
        ...(index === 0
          ? [
              '--mount',
              `type=bind,source=${resolve(process.env.CC_AUTH_INSTALLER_ROOT ?? '.')},target=/release,readonly`,
              '-p',
              `127.0.0.1:${publicPort}:${publicPort}`,
            ]
          : []),
        hostImage,
        '--host=unix:///var/run/docker.sock',
        `--dns=${dnsAddress}`,
        `--bip=${daemonNetworks[index].bridge}`,
        `--default-address-pool=base=${daemonNetworks[index].pool},size=24`,
      ]);
      owned.push(name);
      const host = { role, name, root: hostRoot, address: await address(name) };
      hosts.push(host);
      let info;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          info = JSON.parse(
            await outerDocker([
              'exec',
              name,
              'docker',
              'info',
              '--format',
              '{{json .}}',
            ]),
          );
          break;
        } catch {
          await new Promise((done) => setTimeout(done, 1000));
        }
      }
      assert.ok(info, 'The independent Docker daemon must start.');
      Object.assign(host, {
        daemonId: info.ID,
        serverVersion: info.ServerVersion,
        daemonNetwork: daemonNetworks[index],
      });
      await outerDocker([
        'exec',
        name,
        'chown',
        '1000:1000',
        '/var/run/docker.sock',
      ]);
    }
    assert.equal(new Set(hosts.map(({ daemonId }) => daemonId)).size, 3);
    Object.assign(mappings, {
      'campus.example.org': [hosts[0].address],
      'workers.fixture.test': hosts.slice(1).map(({ address }) => address),
    });
    await writeDns();
    const hostRun = async (host, args, { input, ...options } = {}) => {
      if (input === undefined)
        return outerDocker(
          [
            'exec',
            '--user',
            '1000:1000',
            '--workdir',
            host.root,
            host.name,
            ...args,
          ],
          options,
        );
      return new Promise((done, reject) => {
        const child = spawn(
          'docker',
          [
            'exec',
            '-i',
            '--user',
            '1000:1000',
            '--workdir',
            host.root,
            host.name,
            ...args,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        let stdout = '';
        const timeout = setTimeout(() => child.kill('SIGTERM'), 300000);
        child.once('close', () => clearTimeout(timeout));
        child.stdout.on('data', (bytes) => (stdout += bytes));
        child.stderr.resume();
        child.once('error', reject);
        child.once('close', (code) =>
          code === 0
            ? done(stdout.trim())
            : reject(new Error('The hybrid host command failed.')),
        );
        child.stdin.end(input);
      });
    };
    return {
      hosts,
      network,
      shared,
      artifactVolume,
      hostImage,
      run: hostRun,
      close,
      async mapHosts(values) {
        Object.assign(mappings, values);
        await writeDns();
      },
      async loadImages(
        references,
        { workerReferences = [images.api, images.workers] } = {},
      ) {
        for (const reference of new Set(references)) {
          try {
            await outerDocker(['image', 'inspect', reference]);
          } catch {
            await outerDocker(['pull', reference]);
          }
        }
        const subsets = {
          controller: [...new Set(references)],
          workers: [...new Set(references)].filter((reference) =>
            workerReferences.includes(reference),
          ),
        };
        for (const [name, subset] of Object.entries(subsets))
          await outerDocker([
            'image',
            'save',
            '--output',
            join(imageCache, `${name}.tar`),
            ...subset,
          ]);
        for (const host of hosts) {
          const subset = host.role === 'controller' ? 'controller' : 'workers';
          await outerDocker([
            'exec',
            host.name,
            'docker',
            'load',
            '--input',
            `/image-cache/${subset}.tar`,
          ]);
          for (const reference of subsets[subset]) {
            try {
              await hostRun(host, ['docker', 'image', 'inspect', reference]);
            } catch {
              // Loading layers does not retain every registry digest reference.
              await hostRun(host, ['docker', 'pull', reference]);
            }
            await hostRun(host, ['docker', 'image', 'inspect', reference]);
          }
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
