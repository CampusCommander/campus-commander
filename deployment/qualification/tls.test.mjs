import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { probeHttp } from '../bootstrap/status.mjs';

test('HTTP readiness rejects expired and mismatched certificates under a trusted CA', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-fault-tls-'));
  const openssl = (...args) =>
    execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  try {
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
      '/CN=Disposable qualification CA',
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
      '/CN=localhost',
    );
    await writeFile(
      join(directory, 'ca.conf'),
      `[ca]\ndefault_ca=fixture\n[fixture]\ndatabase=index\nserial=serial\nnew_certs_dir=certs\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\ndefault_days=1\npolicy=names\nunique_subject=no\n[names]\ncommonName=supplied\n[server]\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n[wrong]\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:wrong.invalid\n`,
    );
    const ca = await readFile(join(directory, 'ca.pem'));
    const key = await readFile(join(directory, 'server.key'));
    for (const [name, expected, extra] of [
      ['valid', true, ['-extensions', 'server']],
      [
        'expired',
        false,
        [
          '-extensions',
          'server',
          '-startdate',
          '20200101000000Z',
          '-enddate',
          '20200102000000Z',
        ],
      ],
      ['wrong-host', false, ['-extensions', 'wrong']],
    ]) {
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
        ...extra,
      );
      const server = https.createServer(
        { key, cert: await readFile(join(directory, `${name}.pem`)) },
        (_request, response) => response.end('ready'),
      );
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      try {
        const result = await probeHttp(
          {
            endpoint: {
              url: `https://localhost:${server.address().port}`,
              tls: {
                mode: 'private-ca',
                caSecretRef: { provider: 'file', path: '/synthetic-ca' },
              },
            },
            health: { path: '/health', timeoutSeconds: 1 },
          },
          async () => ca,
        );
        assert.equal(result, expected, name);
      } finally {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
