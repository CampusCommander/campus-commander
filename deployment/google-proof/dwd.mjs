import { validateServiceAccount as validateCredential } from '../../libs/google-connection/src/lib/credential.ts';
import { JWT } from 'google-auth-library';
import { ProofError } from './store.mjs';

export const DIRECTORY_SCOPES = Object.freeze({
  customer: 'https://www.googleapis.com/auth/admin.directory.customer.readonly',
  domains: 'https://www.googleapis.com/auth/admin.directory.domain.readonly',
  orgunits: 'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
});
const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';
const errors = new Map([
  ['unauthorized_client', 'delegation-not-authorized'],
  ['invalid_client', 'invalid-service-account'],
  ['invalid_grant', 'credential-or-subject-rejected'],
  ['invalid_scope', 'scope-rejected'],
  ['access_denied', 'authorization-denied'],
  ['forbidden', 'permission-denied'],
  ['insufficientPermissions', 'permission-denied'],
  ['accessNotConfigured', 'api-not-enabled'],
  ['rateLimitExceeded', 'quota'],
  ['userRateLimitExceeded', 'quota'],
  ['quotaExceeded', 'quota'],
  ['notFound', 'not-found'],
  ['backendError', 'provider-unavailable'],
]);

export function sanitizeError(error) {
  if (error instanceof ProofError)
    return { outcome: 'failed', reason: error.code };
  const data = error.response?.data;
  const providerReason =
    typeof data?.error === 'string'
      ? data.error
      : data?.error?.errors?.[0]?.reason;
  const status = error.response?.status;
  return {
    outcome: 'failed',
    ...(Number.isInteger(status) ? { status } : {}),
    reason:
      errors.get(providerReason) ??
      (status === 429
        ? 'quota'
        : status === 403
          ? 'permission-denied'
          : status === 401
            ? 'credential-rejected'
            : status >= 500
              ? 'provider-unavailable'
              : 'request-failed'),
  };
}

export function validateServiceAccount(input, expectedClientId) {
  try {
    return validateCredential(input, expectedClientId);
  } catch {
    throw new ProofError('invalid-service-account-file');
  }
}

export function scopeList(orgunits = false) {
  return [
    DIRECTORY_SCOPES.customer,
    DIRECTORY_SCOPES.domains,
    ...(orgunits ? [DIRECTORY_SCOPES.orgunits] : []),
  ];
}

export function createDelegatedClient(credential, subject, scopes) {
  if (
    typeof subject !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject) ||
    !scopes.length ||
    scopes.some((scope) => !Object.values(DIRECTORY_SCOPES).includes(scope))
  ) {
    throw new ProofError('invalid-proof-configuration');
  }
  const client = new JWT({
    email: credential.client_email,
    key: credential.private_key,
    keyId: credential.private_key_id,
    subject,
    scopes,
    eagerRefreshThresholdMillis: 60_000,
  });
  const request = client.transporter.request.bind(client.transporter);
  const counter = { tokenRequests: 0 };
  client.transporter.request = (options) => {
    const url = new URL(options.url);
    if (
      url.origin === 'https://oauth2.googleapis.com' &&
      url.pathname === '/token'
    )
      counter.tokenRequests++;
    return request({
      ...options,
      timeout: 10_000,
      retry: false,
      maxRedirects: 0,
    });
  };
  return { client, counter };
}

export class DwdProof {
  constructor({
    credential,
    subject,
    orgunits = false,
    expectedCustomerId,
    createClient = createDelegatedClient,
  }) {
    this.scopes = scopeList(orgunits);
    const { client, counter } = createClient(credential, subject, this.scopes);
    this.client = client;
    this.counter = counter;
    this.expectedCustomerId = expectedCustomerId;
    this.events = [];
  }

  async read(capability, path) {
    const start = Date.now();
    try {
      const response = await this.client.request({
        url: `${DIRECTORY}${path}`,
        method: 'GET',
        timeout: 10_000,
        retry: false,
      });
      this.events.push({
        capability,
        status: response.status,
        outcome: 'passed',
        elapsedMs: Date.now() - start,
      });
      return response.data;
    } catch (error) {
      const failure = sanitizeError(error);
      this.events.push({
        capability,
        ...failure,
        elapsedMs: Date.now() - start,
      });
      throw new ProofError(failure.reason);
    }
  }

  async tokenScopes() {
    try {
      const { token } = await this.client.getAccessToken();
      const info = await this.client.getTokenInfo(token);
      if (
        !Array.isArray(info.scopes) ||
        this.scopes.some((scope) => !info.scopes.includes(scope)) ||
        info.scopes.some((scope) => !this.scopes.includes(scope))
      )
        throw new ProofError('scope-mismatch');
      return [...info.scopes].sort();
    } catch (error) {
      const failure = sanitizeError(error);
      this.events.push({ capability: 'token-scopes', ...failure });
      throw new ProofError(failure.reason);
    }
  }

  async run({ renew = true } = {}) {
    const grantedScopes = await this.tokenScopes();
    const customer = await this.read(
      'customer',
      '/customers/my_customer?fields=id,customerDomain',
    );
    if (
      typeof customer.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(customer.id) ||
      typeof customer.customerDomain !== 'string'
    )
      throw new ProofError('invalid-customer-response');
    if (this.expectedCustomerId && customer.id !== this.expectedCustomerId)
      throw new ProofError('wrong-customer');
    const customerId = encodeURIComponent(customer.id);
    const domains = await this.read(
      'domains',
      `/customer/${customerId}/domains`,
    );
    if (!Array.isArray(domains.domains))
      throw new ProofError('invalid-domain-response');
    const coverage = {
      primary: domains.domains.filter((domain) => domain.isPrimary === true)
        .length,
      secondary: domains.domains.filter((domain) => domain.isPrimary === false)
        .length,
      aliases: domains.domains.reduce(
        (count, domain) => count + (domain.domainAliases?.length ?? 0),
        0,
      ),
    };
    if (this.scopes.includes(DIRECTORY_SCOPES.orgunits)) {
      const units = await this.read(
        'orgunits',
        `/customer/${customerId}/orgunits?type=all`,
      );
      if (
        units.organizationUnits !== undefined &&
        !Array.isArray(units.organizationUnits)
      )
        throw new ProofError('invalid-orgunit-response');
      coverage.orgunits = units.organizationUnits?.length ?? 0;
    }
    const beforeReuse = this.counter.tokenRequests;
    const repeatedCustomer = await this.read(
      'token-reuse',
      `/customers/${customerId}?fields=id`,
    );
    if (
      repeatedCustomer.id !== customer.id ||
      this.counter.tokenRequests !== beforeReuse
    )
      throw new ProofError('token-reuse-failed');
    if (renew) {
      this.client.credentials.expiry_date = 1;
      await this.tokenScopes();
      const renewedCustomer = await this.read(
        'renewal',
        `/customers/${customerId}?fields=id`,
      );
      if (
        renewedCustomer.id !== customer.id ||
        this.counter.tokenRequests !== beforeReuse + 1
      )
        throw new ProofError('token-renewal-failed');
    }
    return {
      privateObservation: {
        customerId: customer.id,
        primaryDomain: customer.customerDomain,
      },
      report: {
        profile: 'service-account-dwd',
        outcome: 'passed',
        requestedScopes: this.scopes,
        grantedScopes,
        customerMatches: this.expectedCustomerId
          ? true
          : 'confirmation-pending',
        coverage,
        tokenRequests: this.counter.tokenRequests,
        tokenReuse: 'passed',
        renewal: renew ? 'passed' : 'not-run',
        expiresAt: new Date(this.client.credentials.expiry_date).toISOString(),
        events: this.events,
      },
    };
  }
}
