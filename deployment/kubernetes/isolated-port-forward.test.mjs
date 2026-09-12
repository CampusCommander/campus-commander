import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import test from 'node:test';
import { isolatedPortForward } from './isolated-port-forward.mjs';

test(
  'a terminated tool tunnel preserves a concurrent database session',
  { timeout: 10000 },
  async () => {
    const children = [];
    const forward = isolatedPortForward({
      localPort: 0,
      remotePort: 5432,
      start: () => {
        const child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
        import { createServer } from 'node:net';
        const server = createServer(socket => socket.on('data', bytes => {
          if (bytes.toString() === 'reset') process.exit(2);
          else socket.write(bytes);
        }));
        server.listen(0, '127.0.0.1', () => console.log('Forwarding from 127.0.0.1:' + server.address().port + ' -> 5432'));
      `,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        children.push(child);
        return child;
      },
    });
    const sockets = [];
    try {
      const port = await forward.ready;
      for (const value of ['lock-session', 'dump-session']) {
        const socket = createConnection({ host: '127.0.0.1', port });
        sockets.push(socket);
        await once(socket, 'connect');
        const echoed = once(socket, 'data');
        socket.write(value);
        assert.equal((await echoed)[0].toString(), value);
      }
      assert.equal(children.length, 2);
      assert.notEqual(children[0].pid, children[1].pid);
      const closed = once(sockets[1], 'close');
      sockets[1].write('reset');
      await closed;
      const echoed = once(sockets[0], 'data');
      sockets[0].write('lock-remains-held');
      assert.equal((await echoed)[0].toString(), 'lock-remains-held');
      assert.equal(forward.observation.peakConnections, 2);
      assert.equal(forward.observation.failedTunnels, 1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await forward.close();
    }
    assert.ok(
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    );
  },
);
