import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import https from 'node:https';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import { createAllDockerDurableProbe } from './all-docker-faults-fixture.mjs';
import { reloadAfterNetworkChange } from './navigation-fixture.mjs';
import { replaceEdgeTlsSecrets } from '../deployment/qualification/edge-tls-faults.mjs';
import { faultRecoveryTimeoutSeconds } from '../deployment/qualification/faults.mjs';
const execute = promisify(execFile);

/** Verify certificate rejection after application login and preserve the installed durable state. */
export async function qualifyAllDockerCertificates({
  root,
  project,
  config,
  release,
  compose,
  id,
  page,
  checks,
  evidencePath = join(root, 'application-certificate-progress.json'),
  evidenceIdentity = {},
}) {
  const startedAt = Date.now();
  const report = {
    ...evidenceIdentity,
    schemaVersion: 1,
    phase: config.phase,
    profile: 'all-docker',
    sourceRevision: release.sourceRevision,
    images: release.images,
    recordedAt: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      browser: page.context().browser().version(),
    },
    durationScope:
      'Certificate setup, rejection checks, recovery, durable-state probes, and original secret restoration.',
    status: 'in-progress',
    recoveryBoundSeconds: faultRecoveryTimeoutSeconds,
    cases: [],
    originalSecretBytesRestored: false,
    limits: [
      'One Docker host retains host and local-volume failure points.',
      'The fixture uses synthetic certificates and an independent synthetic identity provider.',
      'TLS rejection uses a strict Node HTTPS client. Browser checks omit synthetic certificate trust prompts.',
      'Capacity and complete profile acceptance require separate evidence.',
    ],
  };
  const save = async () => {
    report.durationMs = Date.now() - startedAt;
    await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  };
  await save();
  try {
    const phase3 = config.phase === 3;
    assert.match(
      project,
      phase3 ? /^cc-phase3-[a-f0-9-]{12}$/ : /^cc-installer-[a-z0-9-]+$/,
    );
    assert.match(
      basename(root),
      phase3 ? /^cc-phase3-compose-/ : /^cc-installer-/,
    );
    assert.equal(config.profile, 'all-docker');
    assert.ok([2, 3].includes(config.phase));
    const endpoint = new URL(config.applicationAuth.publicOrigin);
    assert.match(endpoint.hostname, /^[a-z0-9.-]+$/);
    const hostname = endpoint.hostname;
    const privateRoot = join(root, 'private');
    const original = new Map();
    for (const name of await readdir(privateRoot))
      original.set(name, await readFile(join(privateRoot, name)));
    const certificateName = 'edge-certificate',
      keyName = 'edge-private-key';
    const directory = await mkdtemp(join(root, 'application-tls-fault-'));
    const openssl = (...args) =>
      execute('openssl', args, { cwd: directory, timeout: 30000 });
    const replace = (cert, key) =>
      replaceEdgeTlsSecrets({
        compose,
        certPath: join(privateRoot, certificateName),
        keyPath: join(privateRoot, keyName),
        cert,
        key,
      });
    const tlsResult = (ca) =>
      new Promise((resolve) => {
        const request = https.get(
          {
            hostname: '127.0.0.1',
            port: endpoint.port,
            servername: hostname,
            path: '/health/live',
            ca,
            agent: false,
            rejectUnauthorized: true,
            headers: { host: endpoint.host },
          },
          (response) => {
            response.resume();
            resolve(
              response.statusCode === 200
                ? 'TLS_ACCEPTED'
                : 'HTTP_' + response.statusCode,
            );
          },
        );
        request.setTimeout(5000, () => request.destroy());
        request.on('error', (error) =>
          resolve(error.code ?? 'TLS_UNAVAILABLE'),
        );
      });
    const verifyDurable = await createAllDockerDurableProbe({
      root,
      project,
      config,
      release,
      compose,
      id,
    });
    const recoverApplication = async (deadline) => {
      await reloadAfterNetworkChange(page);
      await expect(
        page.getByRole('heading', { name: 'Diagnostics', exact: true }),
      ).toBeVisible({ timeout: 15000 });
      await checks({
        recoverySeconds: faultRecoveryTimeoutSeconds,
        recoveryDeadline: deadline,
      });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      return verifyDurable();
    };
    let failure;
    try {
      await checks();
      verifyDurable();
      await mkdir(join(directory, 'certs'));
      await writeFile(join(directory, 'index'), '');
      await writeFile(join(directory, 'serial'), '1000\n');
      await openssl(
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=All-Docker authenticated fault CA',
        '-keyout',
        'ca.key',
        '-out',
        'ca.pem',
      );
      await openssl(
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
        await openssl(
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

      const ca = await readFile(join(directory, 'ca.pem'));
      const valid = await readFile(join(directory, 'valid.pem'));
      const key = await readFile(join(directory, 'server.key'));
      await replace(valid, key);
      await expect
        .poll(() => tlsResult(ca), { timeout: 30000 })
        .toBe('TLS_ACCEPTED');
      await recoverApplication(Date.now() + faultRecoveryTimeoutSeconds * 1000);
      for (const [name, expected] of [
        ['expired', 'CERT_HAS_EXPIRED'],
        ['wrong-host', 'ERR_TLS_CERT_ALTNAME_INVALID'],
        ['untrusted', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
      ]) {
        console.log('All-Docker authenticated certificate fault:', name);
        const record = {
          name,
          status: 'in-progress',
          startedAt: new Date().toISOString(),
        };
        report.cases.push(record);
        await save();
        await replace(
          name === 'untrusted'
            ? valid
            : await readFile(join(directory, `${name}.pem`)),
          key,
        );
        await expect
          .poll(
            () =>
              tlsResult(
                name === 'untrusted' ? original.get(certificateName) : ca,
              ),
            { timeout: 30000 },
          )
          .toBe(expected);
        record.tlsError = expected;
        const recoveryStarted = Date.now();
        await replace(valid, key);
        await expect
          .poll(() => tlsResult(ca), { timeout: 30000 })
          .toBe('TLS_ACCEPTED');
        record.durableState = await recoverApplication(
          recoveryStarted + faultRecoveryTimeoutSeconds * 1000,
        );
        record.recoveryMs = Date.now() - recoveryStarted;
        assert.ok(record.recoveryMs <= faultRecoveryTimeoutSeconds * 1000);
        record.status = 'passed';
        await save();
      }
    } catch (error) {
      failure = error;
    }
    try {
      await replace(original.get(certificateName), original.get(keyName));
      await expect
        .poll(() => tlsResult(original.get(certificateName)), {
          timeout: 30000,
        })
        .toBe('TLS_ACCEPTED');
      await recoverApplication(Date.now() + faultRecoveryTimeoutSeconds * 1000);
      assert.deepEqual(
        (await readdir(privateRoot)).sort(),
        [...original.keys()].sort(),
      );
      for (const [name, bytes] of original)
        assert.ok(
          (await readFile(join(privateRoot, name))).equals(bytes),
          'Original qualification secret bytes changed.',
        );
      report.originalSecretBytesRestored = true;
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            'Certificate fault and recovery failed.',
          )
        : error;
    }
    report.status = failure ? 'failed' : 'passed';
    await save();
    await rm(directory, { recursive: true, force: true });
    if (failure) throw failure;
    return report;
  } catch (error) {
    report.status = 'failed';
    if (report.cases.at(-1)?.status === 'in-progress')
      report.cases.at(-1).status = 'failed';
    await save();
    throw error;
  }
}
