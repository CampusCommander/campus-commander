import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';

/** Keep a database tool connection from terminating another connection's tunnel. */
export function isolatedPortForward({
  arguments: args,
  localPort,
  remotePort,
  start = () => spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] }),
  maxConnections = 16,
}) {
  const connections = new Set();
  const processes = new Set();
  const observation = { connections: 0, peakConnections: 0, failedTunnels: 0 };
  let closed = false;
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    if (closed || connections.size >= maxConnections) {
      socket.destroy();
      return;
    }
    const child = start();
    const record = { socket, child, upstream: undefined, closed: false };
    connections.add(record);
    observation.connections += 1;
    observation.peakConnections = Math.max(
      observation.peakConnections,
      connections.size,
    );
    let output = '';
    let failed = false;
    let killTimer;
    const failure = () => {
      if (!failed) observation.failedTunnels += 1;
      failed = true;
    };
    const cleanup = () => {
      if (record.closed) return;
      record.closed = true;
      clearTimeout(timer);
      socket.destroy();
      record.upstream?.destroy();
      connections.delete(record);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        killTimer.unref();
      }
    };
    const timer = setTimeout(() => {
      failure();
      cleanup();
    }, 5000);
    const completed = new Promise((done) => {
      child.once('error', () => {
        failure();
        cleanup();
      });
      child.once('close', (code) => {
        if (code !== null && code !== 0) failure();
        cleanup();
        clearTimeout(killTimer);
        processes.delete(completed);
        done();
      });
    });
    processes.add(completed);
    child.stderr.resume();
    child.stdout.on('data', (bytes) => {
      if (record.closed || record.upstream) return;
      output += bytes.toString();
      if (output.length > 8192) {
        cleanup();
        return;
      }
      const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+) -> (\d+)/);
      if (!match || Number(match[2]) !== remotePort) return;
      const upstream = createConnection({
        host: '127.0.0.1',
        port: Number(match[1]),
      });
      record.upstream = upstream;
      upstream.once('connect', () => {
        clearTimeout(timer);
        socket.pipe(upstream).pipe(socket);
        socket.resume();
      });
      upstream.once('error', cleanup);
      upstream.once('close', cleanup);
    });
    socket.once('error', cleanup);
    socket.once('close', cleanup);
    record.close = cleanup;
  });
  const ready = new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(localPort, '127.0.0.1', () => done(server.address().port));
  });
  return {
    ready,
    isAlive: () => server.listening && !closed,
    observation,
    async close() {
      if (closed) return;
      closed = true;
      const stopped = new Promise((done) => server.close(done));
      for (const connection of connections) connection.close();
      await Promise.all([...processes, stopped]);
    },
  };
}
