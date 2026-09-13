import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OnboardingError, parseGoogleClient } from './google-client.mjs';

const equal = (a, b) =>
  typeof a === 'string' &&
  /^[a-f0-9]+$/.test(a) &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Bind credential upload to one operator and one browser on loopback. */
export async function startSetupUpload({
  publicOrigin,
  port = 8765,
  lifetime = 900000,
}) {
  const pairingCode = randomBytes(24).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  const cookie = randomBytes(32).toString('hex');
  const html = await readFile(new URL('./setup-upload.html', import.meta.url));
  const script = await readFile(new URL('./setup-upload.js', import.meta.url));
  const css = await readFile(new URL('./setup-upload.css', import.meta.url));
  const fonts = new Map(
    await Promise.all(
      [400, 500, 700].map(async (weight) => {
        const path = `/fonts/roboto-latin-${weight}-normal.woff2`;
        return [path, await readFile(new URL(`.${path}`, import.meta.url))];
      }),
    ),
  );
  let paired = false,
    failures = 0,
    completed = false;
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // The caller can attach its waiter after displaying connection instructions.
  result.catch(() => undefined);
  const server = http.createServer(async (request, response) => {
    const send = (status, body, type = 'application/json') => {
      response.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (
        request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin)
      )
        return send(403, {
          error: 'Use the exact setup address printed in the terminal.',
        });
      if (request.method === 'GET') {
        if (fonts.has(request.url))
          return send(200, fonts.get(request.url), 'font/woff2');
        if (request.url === '/')
          return send(200, html, 'text/html; charset=utf-8');
        if (request.url === '/setup.js')
          return send(200, script, 'text/javascript; charset=utf-8');
        if (request.url === '/setup.css')
          return send(200, css, 'text/css; charset=utf-8');
        return send(404, {});
      }
      if (
        request.method !== 'POST' ||
        request.headers.origin !== origin ||
        request.headers['content-type'] !== 'application/json'
      )
        return send(403, {
          error: 'The setup request failed browser security checks.',
        });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 70000)
          return send(413, {
            error: 'Select a Google client JSON file smaller than 64 KiB.',
          });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === '/pair') {
        if (paired || failures >= 10 || !equal(body.code, pairingCode)) {
          failures++;
          return send(403, {
            error:
              'Pairing failed. Check the code or restart the installer for a new code.',
          });
        }
        paired = true;
        response.setHeader(
          'set-cookie',
          `cc-setup=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`,
        );
        return send(200, {
          csrf,
          callback: `${new URL(publicOrigin).origin}/api/auth/callback`,
        });
      }
      const cookies = (request.headers.cookie ?? '')
        .split(';')
        .map((v) => v.trim())
        .filter((v) => v.startsWith('cc-setup='));
      if (
        !paired ||
        cookies.length !== 1 ||
        !equal(cookies[0].slice(9), cookie) ||
        !equal(request.headers['x-setup-csrf'], csrf)
      )
        return send(403, {
          error:
            'Pair this browser with the installer before uploading credentials.',
        });
      if (request.url !== '/import' || completed)
        return send(409, {
          error: 'This upload is closed. Continue in the installer terminal.',
        });
      if (typeof body.content !== 'string')
        return send(400, {
          error: 'Select the downloaded Google client JSON file.',
        });
      parseGoogleClient(body.content, publicOrigin);
      completed = true;
      response.once('finish', () => resolveResult(body.content));
      send(200, { status: 'received' });
    } catch (error) {
      send(400, {
        error:
          error instanceof OnboardingError
            ? error.message
            : 'The setup request is invalid. Select the downloaded client JSON and retry.',
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', () =>
      reject(
        new OnboardingError(
          'The local setup listener failed to start. Release port 8765 on this server and resume the installer.',
        ),
      ),
    );
    server.listen(port, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  const timer = setTimeout(() => {
    rejectResult(
      new OnboardingError(
        'Setup pairing expired. Resume the installer to obtain a new code.',
      ),
    );
    void close();
  }, lifetime);
  return { origin, pairingCode, result, close };
}
