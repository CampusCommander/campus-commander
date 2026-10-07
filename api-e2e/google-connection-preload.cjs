const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const requireApplication = createRequire(`${process.cwd()}/package.json`);
const { JWT } = requireApplication('google-auth-library');
const models = [
  'Lenovo 100e Gen 4',
  'Acer Chromebook 311',
  'HP Chromebook 11 G9',
  'Lenovo 300e Gen 3',
  'Acer Chromebook Spin 511',
];
const capacities = [4600, 3900, 3600];
const healthFor = (capacity) =>
  capacity / 5000 > 0.8
    ? 'BATTERY_HEALTH_NORMAL'
    : capacity / 5000 >= 0.75
      ? 'BATTERY_REPLACE_SOON'
      : 'BATTERY_REPLACE_NOW';
let quotaCalls = 0;
const fleet = Array.from({ length: 450 }, (_, index) => ({
  deviceId: `synthetic-device-${index}`,
  serialNumber: `C0A1-${index.toString(16).toUpperCase().padStart(4, '0')}`,
  model: models[index % models.length],
  ...(index % 25 === 0
    ? {}
    : { annotatedAssetId: `HS-${String(400 + index).padStart(4, '0')}` }),
  orgUnitPath: ['/School A', '/School B', '/'][index % 3],
  lastSync: new Date(Date.UTC(2026, 9, 5, 16) - index * 60_000).toISOString(),
  ...(index % 4 === 0 ? { annotatedLocation: 'Science wing' } : {}),
  ...(index === 0 ? { notes: 'Review battery during support visit' } : {}),
  status: 'ACTIVE',
  capacity: index % 10 === 9 ? null : capacities[index % 3],
}));
const telemetry = ({ deviceId, capacity }) =>
  capacity === null
    ? { deviceId }
    : {
        deviceId,
        batteryInfo: [{ designCapacity: '5000' }],
        batteryStatusReport: [0, 1, 2].map((day) => ({
          reportTime: new Date(
            Date.UTC(2026, 9, 5 - day, 13, 50),
          ).toISOString(),
          fullChargeCapacity: String(capacity + day * 10),
          batteryHealth: healthFor(capacity + day * 10),
        })),
      };
const pageOf = (options, url, size) => {
  const start = Number(
    options.params?.pageToken ?? url.searchParams.get('pageToken') ?? 0,
  );
  const items = fleet.slice(start, start + size);
  return {
    items,
    next: start + size < fleet.length ? String(start + size) : undefined,
  };
};
const forbidden = (options) => ({
  response: {
    config: options,
    status: 403,
    data: {
      error: {
        errors: [{ reason: 'forbidden' }],
        privateDiagnostic: 'synthetic-private-provider-diagnostic',
      },
    },
  },
});
const prototype = Object.getPrototypeOf(new JWT().transporter);
const original = prototype.request;
prototype.request = async function (options) {
  const url = new URL(options.url);
  if (
    ![
      'oauth2.googleapis.com',
      'admin.googleapis.com',
      'www.googleapis.com',
      'chromemanagement.googleapis.com',
    ].includes(url.hostname)
  )
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
      (fault === 'domain-delegation-denied' &&
        scope.includes('domain.readonly')) ||
      (fault === 'ou-delegation-denied' && scope.includes('orgunit.readonly'))
    )
      throw {
        response: {
          status: 400,
          data: {
            error: 'unauthorized_client',
            privateDiagnostic: 'synthetic-private-provider-diagnostic',
          },
        },
      };
    data = {
      access_token: scope.includes(' ')
        ? 'synthetic-connection-token'
        : scope.endsWith('customer.readonly')
          ? 'synthetic-customer-token'
          : scope.endsWith('orgunit.readonly')
            ? 'synthetic-ou-token'
            : scope.endsWith('device.chromeos.readonly')
              ? 'synthetic-device-token'
              : scope.endsWith('telemetry.readonly')
                ? 'synthetic-telemetry-token'
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
            : authorization === 'Bearer synthetic-ou-token'
              ? 'https://www.googleapis.com/auth/admin.directory.orgunit.readonly'
              : authorization === 'Bearer synthetic-device-token'
                ? 'https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly'
                : authorization === 'Bearer synthetic-telemetry-token'
                  ? 'https://www.googleapis.com/auth/chrome.management.telemetry.readonly'
                  : 'https://www.googleapis.com/auth/admin.directory.customer.readonly https://www.googleapis.com/auth/admin.directory.domain.readonly',
      expires_in: 3500,
    };
  } else if (url.pathname.endsWith('/my_customer'))
    data = {
      id: fault === 'wrong-customer' ? 'C9999999' : 'C0123456',
      customerDomain: 'fixture.invalid',
    };
  else if (
    [
      '/admin/directory/v1/customer/C0123456/domains',
      '/admin/directory/v1/customer/C9999999/domains',
    ].includes(url.pathname)
  ) {
    if (fault === 'domain-privilege-denied')
      throw {
        response: {
          config: options,
          status: 403,
          data: {
            error: {
              errors: [{ reason: 'forbidden' }],
              privateDiagnostic: 'synthetic-private-provider-diagnostic',
            },
          },
        },
      };
    if (fault === 'quota')
      throw {
        response: {
          config: options,
          status: 403,
          data: {
            error: {
              errors: [{ reason: 'quotaExceeded' }],
              privateDiagnostic: 'synthetic-private-provider-diagnostic',
            },
          },
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
  } else if (
    url.pathname === '/admin/directory/v1/customer/C0123456/orgunits'
  ) {
    if (fault === 'ou-privilege-denied')
      throw {
        response: {
          config: options,
          status: 403,
          data: {
            error: {
              errors: [{ reason: 'forbidden' }],
              privateDiagnostic: 'synthetic-private-provider-diagnostic',
            },
          },
        },
      };
    if (fault === 'ou-delay')
      await new Promise((resolve) => setTimeout(resolve, 2000));
    data = {
      organizationUnits: [
        { orgUnitId: 'root', name: 'Root', orgUnitPath: '/' },
        {
          orgUnitId: 'school-a',
          name: 'School A',
          orgUnitPath: '/School A',
          parentOrgUnitId: 'root',
        },
        {
          orgUnitId: 'school-b',
          name: 'School B',
          orgUnitPath: '/School B',
          parentOrgUnitId: fault === 'ou-invalid' ? 'missing' : 'root',
        },
      ],
    };
  } else if (
    url.pathname === '/admin/directory/v1/customer/C0123456/devices/chromeos'
  ) {
    if (fault === 'device-privilege-denied') throw forbidden(options);
    const { items, next } = pageOf(options, url, 300);
    data = {
      chromeosdevices: items.map(
        ({ capacity: _capacity, ...device }) => device,
      ),
      ...(next ? { nextPageToken: next } : {}),
    };
  } else if (
    url.hostname === 'chromemanagement.googleapis.com' &&
    url.pathname === '/v1/customers/C0123456/telemetry/devices'
  ) {
    if (fault === 'telemetry-privilege-denied') throw forbidden(options);
    const { items, next } = pageOf(
      options,
      url,
      Number(options.params?.pageSize ?? 100),
    );
    data = {
      devices: items.map(telemetry),
      ...(next ? { nextPageToken: next } : {}),
    };
  } else if (
    url.hostname === 'www.googleapis.com' &&
    url.pathname === '/batch/admin/directory_v1'
  ) {
    if (fault === 'device-privilege-denied') throw forbidden(options);
    // Holds a refresh batch so the browser check can see the refresh state.
    if (fault === 'device-delay')
      await new Promise((resolve) => setTimeout(resolve, 4000));
    quotaCalls += 1;
    const ids = [
      ...String(options.body ?? options.data).matchAll(
        /GET \/admin\/directory\/v1\/customer\/C0123456\/devices\/chromeos\/([A-Za-z0-9_-]+)/g,
      ),
    ].map((match) => decodeURIComponent(match[1]));
    const parts = ids.map((id) => {
      const found = fleet.find((device) => device.deviceId === id);
      const removed = fault === 'device-removed' && id === 'synthetic-device-3';
      const quota = fault === 'device-quota' && quotaCalls === 1;
      const status = quota ? 429 : found && !removed ? 200 : 404;
      const body =
        status === 200
          ? (({ capacity: _capacity, ...device }) => device)(found)
          : {
              error: {
                code: status,
                message:
                  status === 429
                    ? 'Rate Limit Exceeded'
                    : 'Resource Not Found: deviceId',
              },
            };
      return [
        '--batch_synthetic',
        'Content-Type: application/http',
        `Content-ID: <response-item-${id}>`,
        '',
        `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify(body),
        '',
      ].join('\r\n');
    });
    return {
      data: `${parts.join('\r\n')}\r\n--batch_synthetic--\r\n`,
      status: 200,
      headers: { 'content-type': 'multipart/mixed; boundary=batch_synthetic' },
    };
  } else if (
    url.hostname === 'chromemanagement.googleapis.com' &&
    url.pathname.startsWith('/v1/customers/C0123456/telemetry/devices/')
  ) {
    if (fault === 'telemetry-privilege-denied') throw forbidden(options);
    const id = decodeURIComponent(url.pathname.split('/').at(-1));
    const found = fleet.find((device) => device.deviceId === id);
    if (!found) {
      const missing = new Error('not found');
      missing.response = {
        config: options,
        status: 404,
        data: { error: { code: 404 } },
      };
      throw missing;
    }
    data = telemetry(found);
  } else throw new Error('Unexpected synthetic Google endpoint.');
  return { data, status: 200 };
};
