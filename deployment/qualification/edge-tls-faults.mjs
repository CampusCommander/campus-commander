import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import https from 'node:https';
import { join, basename } from 'node:path';
import { httpsStartup } from './faults.mjs';

function certificateResult(url, ca, connectAddress) {
  const endpoint = new URL(url);
  return new Promise((resolve) => {
    const request = https.get(
      endpoint,
      {
        hostname: connectAddress,
        servername: endpoint.hostname,
        ca,
        rejectUnauthorized: true,
      },
      (response) => {
        response.resume();
        resolve('TLS_ACCEPTED');
      },
    );
    request.setTimeout(5000, () => request.destroy());
    request.on('error', (error) => resolve(error.code ?? 'TLS_UNAVAILABLE'));
  });
}

export async function replaceEdgeTlsSecrets({
  compose,
  certPath,
  keyPath,
  cert,
  key,
}) {
  compose('stop', '--timeout', '5', 'edge');
  await writeFile(certPath, cert);
  await writeFile(keyPath, key);
  compose('run', '--rm', '--no-deps', 'volume-permissions');
  compose('start', 'edge');
}

/** Qualify edge certificate rejection inside a disposable complete installation. */
export async function runEdgeTlsFaults(options, { compose, verifyFixtures }) {
  const { root, project, url, connectAddress } = options;
  if (
    options.qualificationOnly !== true ||
    !/^cc-installer-[a-z0-9-]+$/.test(project) ||
    !/^cc-installer-/.test(basename(root))
  )
    throw new Error(
      'TLS fault injection requires a disposable installer fixture.',
    );
  const topology = JSON.parse(compose('config', '--format', 'json'));
  assert.equal(topology.name, project);
  const certPath = join(root, 'private', 'edge-certificate');
  const keyPath = join(root, 'private', 'edge-private-key');
  for (const path of [certPath, keyPath]) {
    const stat = await lstat(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
  }
  const originalCert = await readFile(certPath);
  const originalKey = await readFile(keyPath);
  const directory = await mkdtemp(join(root, 'tls-fault-'));
  const hostname = new URL(url).hostname;
  if (!/^[a-z0-9.-]+$/.test(hostname))
    throw new Error('Invalid fixture hostname.');
  const openssl = (...args) =>
    execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  const observe = (caFile) =>
    httpsStartup({
      url,
      caFile,
      connectAddress,
      bootstrapFile: join(root, 'private', 'bootstrap'),
    });
  const ready = async (caFile) => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const result = await observe(caFile);
      if (
        result.status === 'ready' &&
        result.checks?.length === 8 &&
        result.checks.every((check) => check.status === 'ready')
      )
        return result;
      await new Promise((done) => setTimeout(done, 500));
    }
    throw new Error('TLS fixture recovery did not restore eight ready checks.');
  };
  const replace = async (cert, key) => {
    await replaceEdgeTlsSecrets({
      compose,
      certPath,
      keyPath,
      cert,
      key,
    });
  };
  const records = [];
  try {
    await ready(certPath);
    await verifyFixtures();
    await mkdir(join(directory, 'certs'));
    await writeFile(join(directory, 'index'), '');
    await writeFile(join(directory, 'serial'), '1000\n');
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '1',
      '-subj',
      '/CN=Disposable edge fault CA',
    );
    openssl(
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'server.key',
      '-out',
      'server.csr',
      '-subj',
      `/CN=${hostname}`,
    );
    await writeFile(
      join(directory, 'ca.conf'),
      `[ca]\ndefault_ca=fixture\n[fixture]\ndatabase=index\nserial=serial\nnew_certs_dir=certs\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\ndefault_days=1\npolicy=names\nunique_subject=no\n[names]\ncommonName=supplied\n[server]\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname}\n[wrong]\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:wrong.invalid\n`,
    );
    for (const [name, args] of [
      ['valid', ['-extensions', 'server']],
      [
        'expired',
        [
          '-extensions',
          'server',
          '-startdate',
          '20200101000000Z',
          '-enddate',
          '20200102000000Z',
        ],
      ],
      ['wrong-host', ['-extensions', 'wrong']],
    ])
      openssl(
        'ca',
        '-batch',
        '-notext',
        '-config',
        'ca.conf',
        '-in',
        'server.csr',
        '-out',
        `${name}.pem`,
        ...args,
      );
    const key = await readFile(join(directory, 'server.key'));
    const ca = await readFile(join(directory, 'ca.pem'));
    const valid = await readFile(join(directory, 'valid.pem'));
    for (const [name, expectedCode] of [
      ['expired', 'CERT_HAS_EXPIRED'],
      ['wrong-host', 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ]) {
      await replace(valid, key);
      await ready(join(directory, 'ca.pem'));
      await verifyFixtures();
      const started = Date.now();
      await replace(await readFile(join(directory, `${name}.pem`)), key);
      let code;
      const deadline = Date.now() + 15000;
      do {
        code = await certificateResult(url, ca, connectAddress);
        if (code === expectedCode) break;
        await new Promise((done) => setTimeout(done, 250));
      } while (Date.now() < deadline);
      assert.equal(code, expectedCode);
      assert.notEqual(
        (await observe(join(directory, 'ca.pem'))).status,
        'ready',
      );
      await replace(valid, key);
      const recovered = await ready(join(directory, 'ca.pem'));
      await verifyFixtures();
      records.push({
        fault: name,
        status: 'passed',
        tlsError: code,
        elapsedMilliseconds: Date.now() - started,
        recoveredChecks: recovered.checks.length,
        fixturesPreserved: true,
      });
    }
  } finally {
    await replace(originalCert, originalKey);
    await ready(certPath);
    await verifyFixtures();
    assert.deepEqual(await readFile(certPath), originalCert);
    assert.deepEqual(await readFile(keyPath), originalKey);
    await rm(directory, { recursive: true, force: true });
  }
  return {
    status: 'passed',
    profile: 'all-docker',
    scope: 'complete-profile-edge-certificate-faults',
    qualifiesProfile: false,
    acceptedRelease: false,
    images: options.images,
    sourceState: options.sourceState,
    records,
    originalSecretBytesRestored: true,
  };
}
