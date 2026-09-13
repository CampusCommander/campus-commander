import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const image =
  'registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33';
const docker = async (...args) =>
  (
    await execute('docker', args, {
      timeout: 300000,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout.trim();

/** Mirror immutable fixture images without changing their runtime content. */
export async function startRegistry({ relayImage } = {}) {
  const name = `cc-phase2-registry-${randomUUID().slice(0, 12)}`;
  const desktop = /docker desktop/i.test(
    await docker('info', '--format', '{{.OperatingSystem}}'),
  );
  const connections = new Set();
  let listener;
  let port;
  let relay;
  const close = async () => {
    for (const socket of connections) socket.destroy();
    if (listener) await new Promise((done) => listener.close(done));
    await docker('rm', '-f', ...[relay, name].filter(Boolean));
  };
  try {
    if (desktop) {
      assert.ok(relayImage, 'Docker Desktop requires a Node relay image.');
      relay = `${name}-relay`;
      listener = net.createServer((socket) => {
        connections.add(socket);
        const child = spawn(
          'docker',
          [
            'exec',
            '-i',
            relay,
            'node',
            '-e',
            `const net=require('node:net');const s=net.connect(${port},'127.0.0.1');s.on('error',()=>process.exit(1));process.stdin.pipe(s).pipe(process.stdout);`,
          ],
          { stdio: ['pipe', 'pipe', 'ignore'] },
        );
        child.on('error', () => socket.destroy());
        child.on('close', () => socket.destroy());
        child.stdin.on('error', () => socket.destroy());
        socket.on('error', () => child.kill());
        socket.on('close', () => {
          connections.delete(socket);
          child.kill();
        });
        socket.setTimeout(30000, () => socket.destroy());
        socket.pipe(child.stdin);
        child.stdout.pipe(socket);
      });
      await new Promise((done, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', done);
      });
      port = listener.address().port;
      await docker(
        'run',
        '-d',
        '--name',
        relay,
        '--network',
        'host',
        '--no-healthcheck',
        '--entrypoint',
        'node',
        relayImage,
        '-e',
        'setInterval(()=>{},1000)',
      );
    }
    await docker(
      'run',
      '-d',
      '--name',
      name,
      ...(desktop
        ? ['--network', 'host', '-e', `REGISTRY_HTTP_ADDR=127.0.0.1:${port}`]
        : ['-p', '127.0.0.1::5000']),
      '-e',
      'OTEL_TRACES_EXPORTER=none',
      '--tmpfs',
      '/var/lib/registry:size=1073741824',
      image,
    );
    if (!desktop) {
      const published = (await docker('port', name, '5000/tcp'))
        .split('\n')
        .find((value) => !value.startsWith('['));
      assert.ok(published, 'The fixture registry requires an IPv4 listener.');
      port = published.split(':').at(-1);
    }
    const origin = `127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        if (
          (
            await fetch(`http://${origin}/v2/`, {
              signal: AbortSignal.timeout(2000),
            })
          ).ok
        )
          break;
      } catch {
        /* Wait for the owned registry listener. */
      }
      if (attempt === 29)
        throw new Error('The fixture registry did not start.');
      await new Promise((done) => setTimeout(done, 100));
    }
    const copies = [];
    return {
      copies,
      transport: desktop ? 'desktop-loopback-relay' : 'published-loopback',
      async mirror(release, prefix) {
        const images = {};
        for (const [service, reference] of Object.entries(release.images)) {
          const tag = `${origin}/${prefix}/${service}:qualification`;
          const before = JSON.parse(
            await docker('image', 'inspect', reference),
          )[0];
          await docker('tag', reference, tag);
          await docker('push', tag);
          const after = JSON.parse(await docker('image', 'inspect', tag))[0];
          assert.equal(after.Id, before.Id);
          const digest = after.RepoDigests.find((value) =>
            value.startsWith(`${origin}/${prefix}/${service}@sha256:`),
          );
          assert.ok(digest, 'The registry must return an immutable digest.');
          await docker('manifest', 'inspect', '--insecure', digest);
          images[service] = digest;
          copies.push({
            source: reference,
            mirror: digest,
            imageId: before.Id,
          });
        }
        return { ...release, images, sourceImages: release.images };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
