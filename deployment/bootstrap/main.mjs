import { readFile } from 'node:fs/promises';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import { secretPath } from '../redis/runtime.mjs';
import { createBootstrapEdge } from './edge.mjs';
import { probeHttp } from './status.mjs';

try {
  const config = parseDeploymentConfig(
    JSON.parse(await readFile(process.env.CC_CONFIG_FILE, 'utf8')),
  );
  const resolveSecret = (reference) => readFile(secretPath(reference));
  const server = await createBootstrapEdge({
    config,
    resolveSecret,
    verify: (credential) =>
      typeof credential === 'string' &&
      probeHttp(config.services.api, resolveSecret, {
        path: '/api/bootstrap/verify',
        authorization: `Basic ${Buffer.from(`operator:${credential}`).toString('base64')}`,
      }),
    getStatus: async () => ({
      status: (await probeHttp(config.services.api, resolveSecret))
        ? 'ready'
        : 'not-ready',
    }),
  });
  const port = Number(process.env.PORT || 8443);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid edge port.');
  server.on('error', () => {
    process.stderr.write(
      'HTTPS edge failed. Check listener and certificate configuration.\n',
    );
    process.exitCode = 1;
  });
  server.listen(port, '0.0.0.0');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      const timer = setTimeout(() => {
        server.closeAllConnections();
      }, 5000);
      timer.unref();
      server.close(() => clearTimeout(timer));
    });
  }
} catch {
  process.stderr.write(
    'HTTPS bootstrap startup failed. Check configuration and certificate files.\n',
  );
  process.exitCode = 1;
}
