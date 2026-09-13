import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { request } from './request.mjs';

test('hybrid verification survives idle TLS closure and retains request boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-hybrid-request-'));
  let server;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
        '-keyout',
        join(root, 'key.pem'),
        '-out',
        join(root, 'cert.pem'),
      ],
      { stdio: 'ignore', timeout: 30000 },
    );
    const cert = await readFile(join(root, 'cert.pem'));
    let mutations = 0;
    server = https.createServer(
      { cert, key: await readFile(join(root, 'key.pem')) },
      (incoming, response) => {
        if (incoming.method === 'POST') {
          mutations++;
          incoming.socket.destroy();
          return;
        }
        response.end('synthetic');
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const input = {
      port: server.address().port,
      servername: 'localhost',
      ca: cert,
      path: '/',
    };
    assert.equal((await request(input)).status, 200);
    server.closeIdleConnections();
    assert.equal((await request(input)).status, 200);
    await assert.rejects(request({ ...input, servername: 'wrong.invalid' }), {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
    await assert.rejects(
      request({ ...input, method: 'POST', body: 'synthetic' }),
      { code: 'ECONNRESET' },
    );
    assert.equal(mutations, 1);
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
