import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  httpsPortAvailable,
  preflight,
  verifyDockerFilesystem,
  verifyDockerResources,
} from './preflight.mjs';
import {
  evaluatePlatformVersion,
  qualifiedPlatformVersions,
} from './platforms.mjs';

const socketTableHeader =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

function socketTable(...rows) {
  return [socketTableHeader, ...rows].join('\n');
}

function socketRow(localAddress, state = '0A') {
  return `   0: ${localAddress} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 12345 1`;
}

function bindingServer(calls) {
  return {
    once() {
      return this;
    },
    listen(port, address, listener) {
      calls.push({ port, address });
      listener();
    },
    close(done) {
      done();
    },
  };
}

function failingServer(code) {
  const server = {
    once(event, handler) {
      server.onError = handler;
      return server;
    },
    listen() {
      queueMicrotask(() =>
        server.onError(Object.assign(new Error(code), { code })),
      );
    },
  };
  return server;
}

function socketTables({ tcp = [], tcp6 = [], errors = {} } = {}) {
  return async (path) => {
    if (path === '/proc/net/tcp') {
      if (errors.tcp) throw tableError(path, errors.tcp);
      return socketTable(...tcp);
    }
    if (path === '/proc/net/tcp6') {
      if (errors.tcp6) throw tableError(path, errors.tcp6);
      return socketTable(...tcp6);
    }
    throw new Error(`Unexpected socket table ${path}`);
  };
}

function tableError(path, code) {
  return Object.assign(new Error(`${path} unavailable.`), { code });
}

async function localPreflight(options) {
  const root = await mkdtemp(join(tmpdir(), 'cc-https-port-'));
  try {
    const config = JSON.parse(
      await readFile('deployment/examples/all-docker.json', 'utf8'),
    );
    config.services.edge.endpoint.url = 'https://localhost';
    return await preflight(config, {
      installationRoot: root,
      run: async () => '',
      resolveSecret: async () => {
        throw new Error('Secret unavailable.');
      },
      ...options,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('platform versions accept qualified minimums and recorded versions', () => {
  assert.equal(evaluatePlatformVersion('dockerEngine', '29.7.2').passed, true);
  assert.equal(evaluatePlatformVersion('dockerCompose', '5.5.1').passed, true);
  assert.equal(evaluatePlatformVersion('kubernetes', 'v1.37.0').passed, true);
  const vendorBuild = evaluatePlatformVersion('kubernetes', 'v1.35.8+vendor.1');
  assert.equal(vendorBuild.passed, true);
  assert.equal(vendorBuild.observedVersion, 'v1.35.8+vendor.1');
});

test('platform versions reject older and malformed versions', () => {
  assert.equal(
    evaluatePlatformVersion('dockerEngine', '28.99.99').passed,
    false,
  );
  assert.equal(
    evaluatePlatformVersion('dockerCompose', 'version five').passed,
    false,
  );
  assert.equal(evaluatePlatformVersion('kubernetes', 'v1.35').passed, false);
  assert.equal(
    evaluatePlatformVersion('kubernetes', 'v1.35.8-rc.1').passed,
    false,
  );
  assert.equal(
    evaluatePlatformVersion('kubernetes', `v1.${Number.MAX_SAFE_INTEGER + 1}.8`)
      .passed,
    false,
  );
});

test('platform versions reject untested future major versions', () => {
  assert.equal(evaluatePlatformVersion('dockerEngine', '30.0.0').passed, false);
  assert.equal(evaluatePlatformVersion('dockerCompose', '6.0.0').passed, false);
  assert.equal(evaluatePlatformVersion('kubernetes', 'v2.0.0').passed, false);
});

test('Kubernetes preflight records the server version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-kubernetes-preflight-'));
  try {
    const config = JSON.parse(
      await readFile('deployment/examples/kubernetes.json', 'utf8'),
    );
    for (const name of Object.keys(config.images))
      config.images[name] =
        `registry.example/${name}@sha256:${'0123456789abcdef'.repeat(4)}`;
    config.services.edge.endpoint.url = 'https://localhost';
    const result = await preflight(config, {
      installationRoot: root,
      cluster: { context: 'qualified', storageClasses: ['shared'] },
      run: async (file, args) => {
        assert.equal(file, 'kubectl');
        if (args[0] === 'config') return 'qualified';
        if (args[0] === 'version')
          return JSON.stringify({ serverVersion: { gitVersion: 'v1.35.8' } });
        if (args[1] === 'nodes')
          return JSON.stringify({
            items: Array.from({ length: config.host.workerHosts }, () => ({
              status: {
                nodeInfo: { architecture: 'amd64', operatingSystem: 'linux' },
                conditions: [{ type: 'Ready', status: 'True' }],
              },
            })),
          });
        if (args[1] === 'storageclass')
          return JSON.stringify({ items: [{ metadata: { name: 'shared' } }] });
        throw new Error('Unexpected kubectl command.');
      },
    });
    const version = result.checks.find(
      (item) => item.name === 'cluster-version',
    );
    assert.deepEqual(version, {
      name: 'cluster-version',
      status: 'passed',
      observedVersion: 'v1.35.8',
      minimumVersion: '1.35.8',
      supportedMajor: 1,
      evidenceVersions: qualifiedPlatformVersions.kubernetes.evidenceVersions,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Kubernetes preflight rejects an unsupported server version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-kubernetes-version-'));
  try {
    const config = JSON.parse(
      await readFile('deployment/examples/kubernetes.json', 'utf8'),
    );
    const result = await preflight(config, {
      installationRoot: root,
      cluster: { context: 'qualified', storageClasses: ['shared'] },
      run: async (_file, args) => {
        if (args[0] === 'config') return 'qualified';
        if (args[0] === 'version')
          return JSON.stringify({
            serverVersion: { gitVersion: 'v1.34.99' },
          });
        if (args[1] === 'nodes') return JSON.stringify({ items: [] });
        if (args[1] === 'storageclass')
          return JSON.stringify({ items: [{ metadata: { name: 'shared' } }] });
        throw new Error('Unexpected kubectl command.');
      },
    });
    const version = result.checks.find(
      (item) => item.name === 'cluster-version',
    );
    assert.equal(result.status, 'failed');
    assert.deepEqual(version, {
      name: 'cluster-version',
      status: 'failed',
      observedVersion: 'v1.34.99',
      minimumVersion: '1.35.8',
      supportedMajor: 1,
      evidenceVersions: qualifiedPlatformVersions.kubernetes.evidenceVersions,
      instruction:
        'Install Kubernetes 1.35.8 or newer within major version 1 on the selected cluster.',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const visible of [true, false]) {
  test(`Docker filesystem probe ${visible ? 'accepts the same filesystem' : 'rejects a different filesystem'} and removes its marker`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-daemon-path-'));
    try {
      const run = async (file, args) => {
        assert.equal(file, 'docker');
        assert.ok(args.includes('--network=none'));
        const mount = args[args.indexOf('--mount') + 1];
        const path = /source=([^,]+)/.exec(mount)[1];
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal(await readFile(path, 'utf8'), args.at(-1));
        assert.ok(mount.endsWith(',readonly'));
        if (!visible) throw new Error('bind source path does not exist');
      };
      if (visible)
        assert.equal(await verifyDockerFilesystem(root, 'fixture', run), true);
      else
        await assert.rejects(
          verifyDockerFilesystem(root, 'fixture', run),
          /bind source/,
        );
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const memory of ['134217728', 'max']) {
  test(`resource probe ${memory === 'max' ? 'rejects ignored' : 'accepts enforced'} nested Docker limits`, async () => {
    const run = async (file, args) => {
      assert.equal(file, 'docker');
      for (const flag of [
        '--memory=128m',
        '--cpus=0.25',
        '--pids-limit=32',
        '--network=none',
        '--rm',
      ])
        assert.ok(args.includes(flag));
      const values = {
        'memory.max': memory,
        'cpu.max': '25000 100000',
        'pids.max': '32',
      };
      runInNewContext(args.at(-1), {
        require: () => ({
          existsSync: (path) => Object.hasOwn(values, path.split('/').at(-1)),
          readFileSync: (path) => values[path.split('/').at(-1)],
        }),
        process: {
          exit: () => {
            throw new Error('Resource limits are not enforced.');
          },
        },
      });
    };
    if (memory === 'max')
      await assert.rejects(
        verifyDockerResources('fixture', run),
        /not enforced/,
      );
    else assert.equal(await verifyDockerResources('fixture', run), true);
  });
}

test('resource probe propagates a nested cgroup startup failure', async () => {
  await assert.rejects(
    verifyDockerResources('fixture', async () => {
      throw new Error('cannot enter cgroupv2: threaded mode');
    }),
    /threaded mode/,
  );
});

test('HTTPS port check passes when the bind probe succeeds', async () => {
  const calls = [];
  assert.equal(
    await httpsPortAvailable(443, {
      createServer: () => bindingServer(calls),
    }),
    true,
  );
  assert.deepEqual(calls, [{ port: 443, address: '0.0.0.0' }]);
});

test('HTTPS port check fails when the bind probe reports EADDRINUSE', async () => {
  assert.equal(
    await httpsPortAvailable(443, {
      createServer: () => failingServer('EADDRINUSE'),
    }),
    false,
  );
});

test('HTTPS port check fails on another bind error', async () => {
  assert.equal(
    await httpsPortAvailable(443, {
      createServer: () => failingServer('EINVAL'),
    }),
    false,
  );
});

test('HTTPS port check passes when EACCES leaves the port without a listener', async () => {
  assert.equal(
    await httpsPortAvailable(443, {
      createServer: () => failingServer('EACCES'),
      readTable: socketTables(),
    }),
    true,
  );
});

for (const [label, tables] of [
  ['IPv4 wildcard address', { tcp: [socketRow('00000000:01BB')] }],
  ['specific IPv4 address', { tcp: [socketRow('0100007F:01BB')] }],
  [
    'IPv6 wildcard address',
    { tcp6: [socketRow('00000000000000000000000000000000:01BB')] },
  ],
]) {
  test(`HTTPS port check fails when EACCES and a listener uses the ${label}`, async () => {
    assert.equal(
      await httpsPortAvailable(443, {
        createServer: () => failingServer('EACCES'),
        readTable: socketTables(tables),
      }),
      false,
    );
  });
}

test('HTTPS port check passes when EACCES leaves only non-listening sockets', async () => {
  assert.equal(
    await httpsPortAvailable(443, {
      createServer: () => failingServer('EACCES'),
      readTable: socketTables({
        tcp: [
          socketRow('00000000:01BB', '06'),
          socketRow('0100007F:01BB', '01'),
        ],
      }),
    }),
    true,
  );
});

test('HTTPS port check ignores a listener on another port', async () => {
  assert.equal(
    await httpsPortAvailable(443, {
      createServer: () => failingServer('EACCES'),
      readTable: socketTables({
        tcp: [socketRow('00000000:20FB')],
        tcp6: [socketRow('00000000000000000000000000000000:20FB')],
      }),
    }),
    true,
  );
});

test('HTTPS port check fails when EACCES leaves a socket table unreadable', async () => {
  await assert.rejects(
    httpsPortAvailable(443, {
      createServer: () => failingServer('EACCES'),
      readTable: async (path) => {
        if (path === '/proc/net/tcp') return socketTable();
        throw new Error('Socket table unavailable.');
      },
    }),
    /Socket table unavailable/,
  );
});

test('HTTPS port check passes when EACCES and the host has no IPv6 socket table', async () => {
  assert.equal(
    await httpsPortAvailable(443, {
      createServer: () => failingServer('EACCES'),
      readTable: socketTables({ errors: { tcp6: 'ENOENT' } }),
    }),
    true,
  );
});

test('HTTPS port check fails when EACCES, no IPv6 socket table, and IPv4 holds the port', async () => {
  assert.equal(
    await httpsPortAvailable(443, {
      createServer: () => failingServer('EACCES'),
      readTable: socketTables({
        tcp: [socketRow('00000000:01BB')],
        errors: { tcp6: 'ENOENT' },
      }),
    }),
    false,
  );
});

test('HTTPS port check fails when EACCES and the IPv4 socket table is missing', async () => {
  await assert.rejects(
    httpsPortAvailable(443, {
      createServer: () => failingServer('EACCES'),
      readTable: socketTables({ errors: { tcp: 'ENOENT' } }),
    }),
    (error) => error.code === 'ENOENT',
  );
});

for (const code of ['EACCES', 'EIO']) {
  test(`HTTPS port check fails when EACCES and the IPv6 socket table fails with ${code}`, async () => {
    await assert.rejects(
      httpsPortAvailable(443, {
        createServer: () => failingServer('EACCES'),
        readTable: socketTables({ errors: { tcp6: code } }),
      }),
      (error) => error.code === code,
    );
  });
}

test('HTTPS port check skips the bind probe when the installation owns the port', async () => {
  let probed = false;
  assert.equal(
    await httpsPortAvailable(443, {
      ownedHttpsPort: true,
      createServer: () => {
        probed = true;
        throw new Error('The owned port must not be probed.');
      },
    }),
    true,
  );
  assert.equal(probed, false);
});

test('local preflight keeps the owned HTTPS port path', async () => {
  let probed = false;
  const result = await localPreflight({
    ownedHttpsPort: true,
    createServer: () => {
      probed = true;
      throw new Error('The owned port must not be probed.');
    },
  });
  assert.equal(probed, false);
  assert.deepEqual(
    result.checks.find((item) => item.name === 'https-port'),
    {
      name: 'https-port',
      status: 'passed',
    },
  );
});

test('local preflight reports the existing message when EACCES hides a listener', async () => {
  const result = await localPreflight({
    createServer: () => failingServer('EACCES'),
    readTable: socketTables({ tcp: [socketRow('00000000:01BB')] }),
  });
  assert.deepEqual(
    result.checks.find((item) => item.name === 'https-port'),
    {
      name: 'https-port',
      status: 'failed',
      instruction:
        'Release the configured public HTTPS port before installation.',
    },
  );
});

test('local preflight fails the check when EACCES leaves a socket table unreadable', async () => {
  const result = await localPreflight({
    createServer: () => failingServer('EACCES'),
    readTable: async (path) => {
      if (path === '/proc/net/tcp') return socketTable();
      throw new Error('Socket table unavailable.');
    },
  });
  assert.deepEqual(
    result.checks.find((item) => item.name === 'https-port'),
    {
      name: 'https-port',
      status: 'failed',
      instruction:
        'Release the configured public HTTPS port before installation.',
    },
  );
});

test('local preflight passes the check when the host has no IPv6 socket table', async () => {
  const result = await localPreflight({
    createServer: () => failingServer('EACCES'),
    readTable: socketTables({ errors: { tcp6: 'ENOENT' } }),
  });
  assert.deepEqual(
    result.checks.find((item) => item.name === 'https-port'),
    {
      name: 'https-port',
      status: 'passed',
    },
  );
});

test('local preflight reports the existing message when no IPv6 socket table and EACCES hides a listener', async () => {
  const result = await localPreflight({
    createServer: () => failingServer('EACCES'),
    readTable: socketTables({
      tcp: [socketRow('00000000:01BB')],
      errors: { tcp6: 'ENOENT' },
    }),
  });
  assert.deepEqual(
    result.checks.find((item) => item.name === 'https-port'),
    {
      name: 'https-port',
      status: 'failed',
      instruction:
        'Release the configured public HTTPS port before installation.',
    },
  );
});

test('local preflight fails the check when the IPv4 socket table is missing', async () => {
  const result = await localPreflight({
    createServer: () => failingServer('EACCES'),
    readTable: socketTables({ errors: { tcp: 'ENOENT' } }),
  });
  assert.deepEqual(
    result.checks.find((item) => item.name === 'https-port'),
    {
      name: 'https-port',
      status: 'failed',
      instruction:
        'Release the configured public HTTPS port before installation.',
    },
  );
});
