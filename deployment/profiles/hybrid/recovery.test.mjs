import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoverHybridPersistence } from './full-integration.mjs';
import { request } from './request.mjs';

test('hybrid recovery observes complete state after transient HTTPS failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-hybrid-recovery-'));
  let server;
  let mode, healthReads, executionReads;
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
    const artifact = join(root, 'artifact');
    await writeFile(artifact, 'preserved artifact');
    server = https.createServer(
      { cert, key: await readFile(join(root, 'key.pem')) },
      (incoming, response) => {
        assert.equal(incoming.method, 'GET');
        if (incoming.url === '/execution') {
          executionReads++;
          if (mode === 'reset' && executionReads === 1) {
            incoming.socket.destroy();
            return;
          }
          response.end(JSON.stringify({ state: 'SUCCESS' }));
          return;
        }
        healthReads++;
        response.statusCode =
          (mode === 'unstable' && healthReads === 2) ||
          (mode === 'persistent' && healthReads % 2 === 0)
            ? 503
            : 200;
        response.end('health');
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const input = {
      port: server.address().port,
      servername: 'localhost',
      ca: cert,
    };
    for (const scenario of [
      'unstable',
      'reset',
      'persistent',
      'lost-artifact',
      'late-success',
    ]) {
      await t.test(scenario, async () => {
        mode = scenario;
        healthReads = executionReads = 0;
        let elapsed = 0;
        await writeFile(
          artifact,
          scenario === 'lost-artifact'
            ? 'corrupted artifact'
            : 'preserved artifact',
        );
        const recovery = recoverHybridPersistence({
          ready: async () =>
            (await request({ ...input, path: '/health' })).status === 200,
          verify: async () => {
            const execution = await request({ ...input, path: '/execution' });
            assert.equal(JSON.parse(execution.body).state, 'SUCCESS');
            assert.equal(
              await readFile(artifact, 'utf8'),
              'preserved artifact',
            );
            assert.equal(
              (await request({ ...input, path: '/health' })).status,
              200,
            );
            if (scenario === 'late-success') elapsed = 90001;
            return execution;
          },
          clock: {
            now: () => elapsed,
            delay: async (ms) => {
              elapsed += ms;
            },
          },
        });
        if (scenario === 'late-success') {
          await assert.rejects(recovery, /exceeded 90 seconds/);
          assert.equal(executionReads, 1);
        } else if (scenario === 'persistent' || scenario === 'lost-artifact') {
          await assert.rejects(recovery);
          assert.equal(elapsed, 90000);
          assert.equal(executionReads, 90);
        } else {
          assert.equal((await recovery).status, 200);
          assert.equal(executionReads, 2);
          assert.equal(elapsed, 1000);
        }
      });
    }
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
