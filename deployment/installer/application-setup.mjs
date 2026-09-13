import { isIP } from 'node:net';

const issuerUrl = (value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};
const cidrs = (value) =>
  typeof value === 'string' &&
  value.split(',').every((entry) => {
    const [address, prefix, extra] = entry.trim().split('/');
    const family = isIP(address);
    return (
      !extra &&
      family &&
      /^\d+$/.test(prefix ?? '') &&
      Number(prefix) >= 0 &&
      Number(prefix) <= (family === 4 ? 32 : 128)
    );
  });

export async function configureApplication(
  config,
  operator,
  q,
  { importGoogle } = {},
) {
  config.phase = Number(
    await q(
      'phase',
      'Application phase (1 or 2)',
      String(config.phase),
      (value) => ['1', '2', 1, 2].includes(value),
    ),
  );
  if (config.phase !== 2) return;
  config.services.edge.access = 'application';
  const provider = await q(
    'applicationAuth.provider',
    'Sign-in provider (google/oidc)',
    q.interactive &&
      !q.hasAnswer?.('applicationAuth.clientId') &&
      !q.hasAnswer?.('applicationAuth.issuer')
      ? 'google'
      : 'oidc',
    (value) => ['google', 'oidc'].includes(value),
  );
  const imported =
    provider === 'google'
      ? await importGoogle({
          publicOrigin: new URL(config.services.edge.endpoint.url).origin,
          q,
        })
      : undefined;
  config.applicationAuth = {
    issuer: imported
      ? 'https://accounts.google.com'
      : await q(
          'applicationAuth.issuer',
          'OIDC issuer HTTPS URL',
          undefined,
          issuerUrl,
        ),
    clientId: imported
      ? imported.clientId
      : await q(
          'applicationAuth.clientId',
          'OIDC client identifier',
          undefined,
          (value) =>
            typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 512,
        ),
    clientSecretRef:
      config.profile === 'kubernetes'
        ? { provider: 'kubernetes', name: 'campus-oidc', key: 'client-secret' }
        : { provider: 'file', path: '/run/secrets/oidc-client' },
    publicOrigin: new URL(config.services.edge.endpoint.url).origin,
    sessionLifetimeSeconds: Number(
      await q(
        'applicationAuth.sessionLifetimeSeconds',
        'Absolute session lifetime in seconds',
        28800,
        (value) =>
          Number.isInteger(Number(value)) &&
          Number(value) >= 300 &&
          Number(value) <= 86400,
      ),
    ),
    sessionIdleSeconds: Number(
      await q(
        'applicationAuth.sessionIdleSeconds',
        'Idle session lifetime in seconds',
        1800,
        (value) =>
          Number.isInteger(Number(value)) &&
          Number(value) >= 60 &&
          Number(value) <= 3600,
      ),
    ),
  };
  if (config.profile === 'kubernetes') {
    operator.kubernetes.externalEgress.identityProvider = (
      await q(
        'kubernetes.externalEgress.identityProvider',
        'OIDC discovery, token, and signing-key endpoint CIDRs, comma-separated',
        undefined,
        cidrs,
      )
    )
      .split(',')
      .map((value) => value.trim());
  }
  return imported;
}
