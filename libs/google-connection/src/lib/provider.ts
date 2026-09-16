import { JWT, OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import {
  googleCustomerIdSchema,
  googleDomainNameSchema,
  googleObservationSchema,
  type GoogleFailure,
  type GoogleObservation,
} from '@campus/application-contracts';
import {
  accessTokenSchema,
  type DelegatedCredential,
  type GoogleAccessToken,
} from './credential';

export const GOOGLE_CONNECTION_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/admin.directory.customer.readonly',
  'https://www.googleapis.com/auth/admin.directory.domain.readonly',
]);
const directory = 'https://admin.googleapis.com/admin/directory/v1';
const responseLimit = 262144;

export class GoogleConnectionError extends Error {
  readonly code: GoogleFailure;
  constructor(code: GoogleFailure) {
    super(code);
    this.name = 'GoogleConnectionError';
    this.code = code;
  }
}

function failure(error: unknown): GoogleConnectionError {
  if (error instanceof GoogleConnectionError) return error;
  if (error instanceof z.ZodError)
    return new GoogleConnectionError('invalid-response');
  const parsed = z
    .object({
      response: z
        .object({ status: z.number().optional(), data: z.unknown().optional() })
        .optional(),
    })
    .safeParse(error);
  const response = parsed.success ? parsed.data.response : undefined;
  const body = z
    .object({
      error: z
        .union([
          z.string(),
          z.object({
            errors: z.array(z.object({ reason: z.string() })).optional(),
          }),
        ])
        .optional(),
    })
    .safeParse(response?.data);
  const provider = body.success ? body.data.error : undefined;
  const reason =
    typeof provider === 'string' ? provider : provider?.errors?.[0]?.reason;
  const status = response?.status;
  if (
    ['invalid_grant', 'invalid_client'].includes(reason ?? '') ||
    status === 401
  )
    return new GoogleConnectionError('credential-rejected');
  if (reason === 'unauthorized_client')
    return new GoogleConnectionError('delegation-not-authorized');
  if (reason === 'accessNotConfigured')
    return new GoogleConnectionError('api-not-enabled');
  if (
    ['domainPolicy', 'access_denied', 'admin_policy_enforced'].includes(
      reason ?? '',
    )
  )
    return new GoogleConnectionError('policy-restricted');
  const network = z
    .object({
      code: z.unknown().optional(),
      name: z.string().optional(),
      cause: z
        .object({ code: z.unknown().optional() })
        .optional()
        .catch(undefined),
    })
    .safeParse(error);
  const networkCode = network.success
    ? (network.data.code ?? network.data.cause?.code)
    : undefined;
  if (
    network.success &&
    ([
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
    ].includes(typeof networkCode === 'string' ? networkCode : '') ||
      ['AbortError', 'TimeoutError'].includes(network.data.name ?? ''))
  )
    return new GoogleConnectionError('network-failure');
  if (reason === 'invalid_scope')
    return new GoogleConnectionError('scope-mismatch');
  if (
    status === 429 ||
    ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'].includes(
      reason ?? '',
    )
  )
    return new GoogleConnectionError('quota');
  if (status === 403) return new GoogleConnectionError('permission-denied');
  if (status && status >= 500)
    return new GoogleConnectionError('provider-unavailable');
  return new GoogleConnectionError('request-failed');
}

const customerResponse = z.object({
  id: googleCustomerIdSchema,
  customerDomain: googleDomainNameSchema,
});
const domainResponse = z.object({
  domains: z
    .array(
      z.object({
        domainName: googleDomainNameSchema,
        isPrimary: z.boolean(),
        verified: z.boolean(),
        domainAliases: z
          .array(
            z.object({
              domainAliasName: googleDomainNameSchema,
              parentDomainName: googleDomainNameSchema,
              verified: z.boolean(),
            }),
          )
          .max(1000)
          .optional(),
      }),
    )
    .min(1)
    .max(1000),
});

/** Bound every SDK request, including signed token exchange and introspection. */
function boundClient(client: OAuth2Client, signal: AbortSignal) {
  const request = client.transporter.request.bind(client.transporter);
  client.transporter.request = (options) => {
    const url = new URL(options?.url ?? '');
    const allowed =
      (url.origin === 'https://oauth2.googleapis.com' &&
        ['/token', '/tokeninfo'].includes(url.pathname)) ||
      (url.origin === 'https://admin.googleapis.com' &&
        (url.pathname === '/admin/directory/v1/customers/my_customer' ||
          /^\/admin\/directory\/v1\/customer\/C[A-Za-z0-9]{4,31}\/domains$/.test(
            url.pathname,
          )));
    if (!allowed) throw new GoogleConnectionError('request-failed');
    return request({
      ...options,
      signal,
      timeout: 10_000,
      retry: false,
      retryConfig: { retry: 0 },
      maxRedirects: 0,
      maxContentLength: responseLimit,
      size: responseLimit,
    });
  };
}

/** Share fixed customer reads between staging, API checks, and workers. */
export class GoogleCustomerVerifier {
  async verify(credential: DelegatedCredential): Promise<GoogleObservation> {
    const signal = AbortSignal.timeout(40_000);
    return this.observe(await this.renew(credential, signal), signal);
  }

  async renew(
    credential: DelegatedCredential,
    signal: AbortSignal,
  ): Promise<GoogleAccessToken> {
    const client = new JWT({
      email: credential.serviceAccount.client_email,
      key: credential.serviceAccount.private_key,
      keyId: credential.serviceAccount.private_key_id,
      subject: credential.subject,
      scopes: [...GOOGLE_CONNECTION_SCOPES],
      eagerRefreshThresholdMillis: 60_000,
    });
    boundClient(client, signal);
    try {
      const { token } = await client.getAccessToken();
      if (!token) throw new GoogleConnectionError('credential-rejected');
      const info = await client.getTokenInfo(token);
      if (
        info.scopes.length !== GOOGLE_CONNECTION_SCOPES.length ||
        GOOGLE_CONNECTION_SCOPES.some((scope) => !info.scopes.includes(scope))
      )
        throw new GoogleConnectionError('scope-mismatch');
      const result = accessTokenSchema.parse({
        accessToken: token,
        expiresAt: info.expiry_date,
        scopeProfile: 'customer-domain-v1',
      });
      if (
        result.expiresAt <= Date.now() + 60_000 ||
        result.expiresAt > Date.now() + 3_605_000
      )
        throw new GoogleConnectionError('invalid-response');
      return result;
    } catch (error) {
      throw failure(error);
    }
  }

  async observe(
    token: GoogleAccessToken,
    signal: AbortSignal,
  ): Promise<GoogleObservation> {
    const client = new OAuth2Client({ eagerRefreshThresholdMillis: 0 });
    const parsed = accessTokenSchema.parse(token);
    client.setCredentials({
      access_token: parsed.accessToken,
      expiry_date: parsed.expiresAt,
    });
    boundClient(client, signal);
    try {
      const customer = customerResponse.parse(
        (
          await client.request({
            url: `${directory}/customers/my_customer`,
            method: 'GET',
            params: { fields: 'id,customerDomain' },
          })
        ).data,
      );
      const domains = domainResponse.parse(
        (
          await client.request({
            url: `${directory}/customer/${customer.id}/domains`,
            method: 'GET',
            params: {
              fields:
                'domains(domainName,isPrimary,verified,domainAliases(domainAliasName,parentDomainName,verified))',
            },
          })
        ).data,
      );
      for (const domain of domains.domains) {
        if (
          domain.domainAliases?.some(
            (alias) => alias.parentDomainName !== domain.domainName,
          )
        )
          throw new GoogleConnectionError('invalid-response');
      }
      return googleObservationSchema.parse({
        customerId: customer.id,
        primaryDomain: customer.customerDomain,
        domains: domains.domains.map((domain) => ({
          name: domain.domainName,
          primary: domain.isPrimary,
          verified: domain.verified,
          aliases: (domain.domainAliases ?? []).map((alias) => ({
            name: alias.domainAliasName,
            verified: alias.verified,
          })),
        })),
      });
    } catch (error) {
      throw failure(error);
    }
  }
}
