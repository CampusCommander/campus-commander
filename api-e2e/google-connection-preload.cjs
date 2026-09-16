const { createRequire } = require('node:module');
const requireApplication = createRequire(`${process.cwd()}/package.json`);
const { JWT } = requireApplication('google-auth-library');
const prototype = Object.getPrototypeOf(new JWT().transporter);
const original = prototype.request;
prototype.request = async function (options) {
  const url = new URL(options.url);
  if (!['oauth2.googleapis.com', 'admin.googleapis.com'].includes(url.hostname))
    return original.call(this, options);
  let data;
  if (url.pathname === '/token')
    data = {
      access_token: 'synthetic-connection-token',
      expires_in: 3600,
      token_type: 'Bearer',
    };
  else if (url.pathname === '/tokeninfo')
    data = {
      scope:
        'https://www.googleapis.com/auth/admin.directory.customer.readonly https://www.googleapis.com/auth/admin.directory.domain.readonly',
      expires_in: 3500,
    };
  else if (url.pathname.endsWith('/my_customer'))
    data = { id: 'C0123456', customerDomain: 'fixture.invalid' };
  else if (url.pathname === '/admin/directory/v1/customer/C0123456/domains')
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
  else throw new Error('Unexpected synthetic Google endpoint.');
  return { data, status: 200 };
};
