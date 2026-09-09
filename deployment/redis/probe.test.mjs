import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import test from 'node:test';
import { probeRedis } from './probe.mjs';

const secret = Buffer.from('synthetic-credential-marker-32-bytes');
function service(port, transport = { mode: 'disabled' }) {
  return {
    placement: { kind: transport.mode === 'disabled' ? 'local' : 'external' },
    endpoint: {
      url: `${transport.mode === 'disabled' ? 'redis' : 'rediss'}://localhost:${port}`,
      tls: transport,
    },
    passwordSecretRef: {
      provider: 'file',
      path: '/run/secrets/redis-password',
    },
    health: { timeoutSeconds: 1 },
  };
}
async function listen(server) {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server.address().port;
}
async function close(server) {
  await new Promise((done) => server.close(done));
}

test('authentication failure remains redacted', async () => {
  const server = net.createServer((socket) =>
    socket.once('data', () => socket.end(`-ERR ${secret}\r\n`)),
  );
  const port = await listen(server);
  try {
    const result = await probeRedis(service(port), async () => secret);
    assert.equal(result.status, 'not-ready');
    assert.equal(JSON.stringify(result).includes(secret.toString()), false);
  } finally {
    await close(server);
  }
});

test('external TLS verifies trusted certificates and rejects unknown trust', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc8-tls-'));
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
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { stdio: 'ignore' },
    );
    const cert = await readFile(join(directory, 'cert.pem'));
    server = tls.createServer(
      { key: await readFile(join(directory, 'key.pem')), cert },
      (socket) => {
        socket.once('data', () => socket.end('+OK\r\n+PONG\r\n'));
      },
    );
    const port = await listen(server);
    const trusted = service(port, {
      mode: 'private-ca',
      caSecretRef: { provider: 'file', path: '/run/secrets/redis-ca' },
    });
    const resolver = async (ref) => (ref.path.endsWith('-ca') ? cert : secret);
    assert.equal((await probeRedis(trusted, resolver)).status, 'ready');
    assert.equal(
      (await probeRedis(service(port, { mode: 'system-ca' }), resolver)).status,
      'not-ready',
    );
  } finally {
    if (server) await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
