import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBootstrapEdge } from './edge.mjs';
import { generateBootstrapCredential } from './access.mjs';

async function listen(server) {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}

test('HTTPS startup requires bootstrap access and limits edge routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc12-edge-'));
  const token = generateBootstrapCredential();
  let edge;
  let frontend;
  let api;
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
    const key = await readFile(join(directory, 'key.pem'));
    frontend = http.createServer((request, response) => {
      assert.equal(request.headers.authorization, undefined);
      response.end('Phase 1 startup');
    });
    const frontendPort = await listen(frontend);
    api = http.createServer((request, response) => {
      assert.equal(
        request.headers.authorization,
        `Basic ${Buffer.from(`operator:${token}`).toString('base64')}`,
      );
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          phase: 1,
          status: 'not-ready',
          checks: [{ name: 'artifacts', status: 'not-ready' }],
        }),
      );
    });
    const apiPort = await listen(api);
    const config = JSON.parse(
      await readFile('deployment/examples/all-docker.json', 'utf8'),
    );
    config.services.frontend.endpoint.url = `http://127.0.0.1:${frontendPort}`;
    config.services.api.endpoint.url = `http://127.0.0.1:${apiPort}`;
    let available = true;
    edge = await createBootstrapEdge({
      config,
      verify: async (value) => available && value === token,
      resolveSecret: async (ref) =>
        ref.path.endsWith('private-key') ? key : cert,
    });
    const port = await listen(edge);
    const request = (path, credential) =>
      new Promise((done, reject) => {
        const headers = credential
          ? {
              authorization: `Basic ${Buffer.from(`operator:${credential}`).toString('base64')}`,
            }
          : {};
        const req = https.get(
          { hostname: 'localhost', port, path, headers, ca: cert },
          (response) => {
            let body = '';
            response.on('data', (bytes) => {
              body += bytes;
            });
            response.on('end', () =>
              done({
                status: response.statusCode,
                body,
                headers: response.headers,
              }),
            );
          },
        );
        req.on('error', reject);
      });
    assert.equal((await request('/')).status, 401);
    assert.equal(
      (await request('/', generateBootstrapCredential())).status,
      401,
    );
    const accepted = await request('/', token);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body, 'Phase 1 startup');
    assert.equal(accepted.body.includes(token), false);
    assert.equal(accepted.headers['cache-control'], 'no-store');
    assert.equal((await request('/health/live')).status, 200);
    assert.equal((await request('/health')).status, 503);
    assert.equal((await request('/api/startup')).status, 401);
    assert.equal((await request('/api/startup', token)).status, 503);
    for (const path of ['/kestra', '/workers', '/../api', '/api/jobs']) {
      assert.equal((await request(path, token)).status, 404);
    }
    available = false;
    assert.equal((await request('/', token)).status, 401);
  } finally {
    if (edge) await close(edge);
    if (frontend) await close(frontend);
    if (api) await close(api);
    await rm(directory, { recursive: true, force: true });
  }
});
