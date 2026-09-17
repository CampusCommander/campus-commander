const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const requireApplication = createRequire(`${process.cwd()}/package.json`);
const { JWT } = requireApplication('google-auth-library');
const prototype = Object.getPrototypeOf(new JWT().transporter);
const original = prototype.request;
prototype.request = async function (options) {
  const url = new URL(options.url);
  if (!['oauth2.googleapis.com', 'admin.googleapis.com'].includes(url.hostname))
    return original.call(this, options);
  let fault = '';
  try {
    fault = JSON.parse(
      readFileSync(join(__dirname, 'google-health-fault.json'), 'utf8'),
    ).mode;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let data;
  if (url.pathname === '/token') {
    const assertion = new URLSearchParams(options.data).get('assertion');
    const scope = JSON.parse(
      Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8'),
    ).scope;
    if (
      fault === 'domain-delegation-denied' &&
      scope.includes('domain.readonly')
    )
      throw {
        response: { status: 400, data: { error: 'unauthorized_client' } },
      };
    data = {
      access_token: scope.includes(' ')
        ? 'synthetic-connection-token'
        : scope.endsWith('customer.readonly')
          ? 'synthetic-customer-token'
          : 'synthetic-domain-token',
      expires_in: 3600,
      token_type: 'Bearer',
    };
  } else if (url.pathname === '/tokeninfo') {
    const authorization =
      options.headers?.get?.('authorization') ?? options.headers?.authorization;
    data = {
      scope:
        authorization === 'Bearer synthetic-customer-token'
          ? 'https://www.googleapis.com/auth/admin.directory.customer.readonly'
          : authorization === 'Bearer synthetic-domain-token'
            ? 'https://www.googleapis.com/auth/admin.directory.domain.readonly'
            : 'https://www.googleapis.com/auth/admin.directory.customer.readonly https://www.googleapis.com/auth/admin.directory.domain.readonly',
      expires_in: 3500,
    };
  } else if (url.pathname.endsWith('/my_customer'))
    data = {
      id: fault === 'wrong-customer' ? 'C9999999' : 'C0123456',
      customerDomain: 'fixture.invalid',
    };
  else if (url.pathname === '/admin/directory/v1/customer/C0123456/domains') {
    if (fault === 'domain-privilege-denied')
      throw {
        response: {
          config: options,
          status: 403,
          data: { error: { errors: [{ reason: 'forbidden' }] } },
        },
      };
    if (fault === 'quota')
      throw {
        response: {
          config: options,
          status: 403,
          data: { error: { errors: [{ reason: 'quotaExceeded' }] } },
        },
      };
    if (fault === 'network') throw { code: 'ECONNRESET' };
    if (fault === 'delay-domain')
      await new Promise((resolve) => setTimeout(resolve, 2000));
    data = {
      domains: [
        {
          domainName: 'fixture.invalid',
          isPrimary: true,
          verified: true,
          domainAliases: [
            {
              domainAliasName: 'alias.fixture.invalid',
              parentDomainName: 'fixture.invalid',
              verified: false,
            },
          ],
        },
        {
          domainName: 'secondary.fixture.invalid',
          isPrimary: false,
          verified: true,
        },
      ],
    };
  } else throw new Error('Unexpected synthetic Google endpoint.');
  return { data, status: 200 };
};
