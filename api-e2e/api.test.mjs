import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

test(
  'built API serves startup and rejects bootstrap access without configuration',
  { timeout: 30000 },
  async () => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const child = spawn(process.execPath, ['dist/api/main.js'], {
      env: { PATH: process.env.PATH, PORT: String(port), NODE_ENV: 'test' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    const exited = once(child, 'exit');
    try {
      let live;
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(
          child.exitCode,
          null,
          `API exited before startup: ${stderr}`,
        );
        try {
          live = await fetch(`http://127.0.0.1:${port}/health/live`, {
            signal: AbortSignal.timeout(1000),
          });
          break;
        } catch {
          await delay(100);
        }
      }
      assert.equal(live?.status, 200, 'API did not become live.');
      assert.deepEqual(await live.json(), { service: 'api', status: 'live' });
      const origin = `http://127.0.0.1:${port}`;
      const startup = await fetch(`${origin}/api`);
      assert.equal(startup.status, 200);
      assert.deepEqual(await startup.json(), {
        message: 'Campus Commander API started',
      });
      for (const path of ['/api/startup', '/api/bootstrap/verify']) {
        assert.equal((await fetch(`${origin}${path}`)).status, 401);
        assert.equal(
          (
            await fetch(`${origin}${path}`, {
              headers: {
                authorization: `Basic ${Buffer.from('operator:invalid').toString('base64')}`,
              },
            })
          ).status,
          401,
        );
      }
      child.kill('SIGTERM');
      const [code, signal] = await exited;
      assert.ok(
        code === 0 || signal === 'SIGTERM',
        `Unexpected shutdown: ${code}/${signal}`,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await exited;
    }
  },
);
