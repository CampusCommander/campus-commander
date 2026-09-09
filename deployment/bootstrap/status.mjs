import http from 'node:http';
import https from 'node:https';
import { checkReadiness, verifyConnection } from '../postgres/index.mjs';
import { probeRedis } from '../redis/probe.mjs';

export async function probeHttp(
  service,
  resolveSecret,
  { path = service.health.path, authorization } = {},
) {
  try {
    const url = new URL(service.endpoint.url);
    const ca =
      service.endpoint.tls.mode === 'private-ca'
        ? await resolveSecret(service.endpoint.tls.caSecretRef)
        : undefined;
    return await new Promise((done) => {
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(
        url,
        {
          path,
          method: 'GET',
          ca,
          rejectUnauthorized: true,
          headers: authorization ? { authorization } : {},
        },
        (response) => {
          done(response.statusCode === 200);
          response.destroy();
        },
      );
      const timer = setTimeout(
        () => request.destroy(new Error('Probe timed out.')),
        service.health.timeoutSeconds * 1000,
      );
      request.once('close', () => clearTimeout(timer));
      request.on('error', () => done(false));
      request.end();
    });
  } catch {
    return false;
  }
}

/** Return only fixed component names and readiness states. */
export async function installationStatus({
  config,
  applicationPool,
  kestraPool,
  resolveSecret,
  storageHealth,
  kestraHealth,
  apiHealth = () => probeHttp(config.services.api, resolveSecret),
}) {
  const checks = [
    ['application-database', () => checkReadiness(applicationPool)],
    [
      'kestra-database',
      async () => {
        await verifyConnection(kestraPool);
        return true;
      },
    ],
    [
      'redis',
      async () =>
        (await probeRedis(config.services.redis, resolveSecret)).status ===
        'ready',
    ],
    ['frontend', () => probeHttp(config.services.frontend, resolveSecret)],
    ['api', apiHealth],
    ['workers', () => probeHttp(config.services.workers, resolveSecret)],
    ['artifacts', storageHealth],
    ['kestra', kestraHealth],
  ];
  const results = await Promise.all(
    checks.map(async ([name, check]) => {
      let ready = false;
      try {
        ready = typeof check === 'function' && (await check());
      } catch {
        /* Report fixed component state. */
      }
      return { name, status: ready === true ? 'ready' : 'not-ready' };
    }),
  );
  return {
    phase: 1,
    status: results.every((check) => check.status === 'ready')
      ? 'ready'
      : 'not-ready',
    checks: results,
  };
}
