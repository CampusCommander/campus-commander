/** Phase 3 capabilities and their verified authorization boundaries. */

/** The read-only scope of the custom schema resource (B section 3). */
export const GOOGLE_SCHEMA_READ_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.userschema.readonly';
/** The write scope of the custom schema resource (B section 6.1). A writer card uses it. */
export const GOOGLE_SCHEMA_WRITE_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.userschema';
/** The write scope of the user resource (B section 7.2). The value writer uses it. */
export const GOOGLE_USER_WRITE_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.user';

export const GOOGLE_CAPABILITIES = Object.freeze([
  {
    id: 'customer-identity',
    requiredForConnection: true,
    label: 'Customer identity',
    enabled: true,
    qualified: true,
    scope: 'https://www.googleapis.com/auth/admin.directory.customer.readonly',
    method: 'customers.get',
    source:
      'https://developers.google.com/workspace/admin/directory/reference/rest/v1/customers/get',
    evidence: 'CC-44 customer identity proof and CC-46 provider qualification',
  },
  {
    id: 'domain-observations',
    requiredForConnection: true,
    label: 'Customer domains',
    enabled: true,
    qualified: true,
    scope: 'https://www.googleapis.com/auth/admin.directory.domain.readonly',
    method: 'domains.list',
    source:
      'https://developers.google.com/workspace/admin/directory/reference/rest/v1/domains/list',
    evidence:
      'CC-44 primary-domain proof and CC-46 domain and alias simulator qualification',
  },
  {
    id: 'school-ou-references',
    requiredForConnection: false,
    label: 'School OU references',
    enabled: true,
    qualified: true,
    scope: 'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
    method: 'orgunits.list',
    source:
      'https://developers.google.com/workspace/admin/directory/reference/rest/v1/orgunits/list',
    evidence:
      'CC-52 production provider live read, exact OU scope, and packaged reference API qualification',
  },
  {
    id: 'device-inventory',
    requiredForConnection: false,
    label: 'ChromeOS device inventory',
    enabled: true,
    qualified: true,
    scope:
      'https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly',
    method: 'chromeosdevices.list',
    source:
      'https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices/list',
    evidence:
      'Live read-only check 2026-10-16 (deployment/evidence/device-browsing-live-2026-10-16.json): HTTP 200, empty collection',
  },
  {
    id: 'device-telemetry',
    requiredForConnection: false,
    label: 'ChromeOS battery telemetry',
    enabled: true,
    qualified: true,
    scope:
      'https://www.googleapis.com/auth/chrome.management.telemetry.readonly',
    method: 'customers.telemetry.devices.list',
    source:
      'https://developers.google.com/chrome/management/reference/rest/v1/customers.telemetry.devices/list',
    evidence:
      'Live read-only check 2026-10-16 (deployment/evidence/device-browsing-live-2026-10-16.json): HTTP 200, empty collection',
  },
  {
    id: 'device-changes',
    requiredForConnection: false,
    label: 'ChromeOS device changes',
    enabled: true,
    qualified: false,
    scope: 'https://www.googleapis.com/auth/admin.directory.device.chromeos',
    method: 'chromeosdevices.patch',
    source:
      'https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices/patch',
    evidence:
      'admin-sdk-mock v0.2.0 only. Methods: chromeosdevices.patch, customer.devices.chromeos.issueCommand, customer.devices.chromeos.commands.get, customer.devices.chromeos.batchChangeStatus',
  },
  {
    id: 'drive-files',
    requiredForConnection: false,
    label: 'Google Drive files',
    enabled: true,
    qualified: false,
    scope: 'https://www.googleapis.com/auth/drive.file',
    method: 'files.list',
    source:
      'https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list',
    evidence:
      'Not verified on a live domain. The Drive slice demonstration verifies it',
  },
  {
    id: 'user-inventory',
    requiredForConnection: false,
    label: 'User inventory',
    enabled: true,
    qualified: false,
    scope: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
    method: 'users.list',
    source:
      'https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/list',
    evidence: 'admin-sdk-mock 0.4.0 only. No live read-only check yet',
  },
  {
    id: 'user-schemas',
    requiredForConnection: false,
    label: 'User attributes',
    enabled: true,
    qualified: false,
    scope: GOOGLE_SCHEMA_READ_SCOPE,
    method: 'schemas.list',
    source:
      'https://developers.google.com/workspace/admin/directory/reference/rest/v1/schemas/list',
    evidence: 'admin-sdk-mock 0.4.0 only. No live read-only check yet',
  },
  {
    id: 'user-schema-changes',
    requiredForConnection: false,
    label: 'User attribute changes',
    enabled: true,
    qualified: false,
    scope: GOOGLE_SCHEMA_WRITE_SCOPE,
    method: 'schemas.update',
    source:
      'https://developers.google.com/workspace/admin/directory/reference/rest/v1/schemas/update',
    evidence:
      'admin-sdk-mock 0.4.0 and live check L2, which called the schema writes directly. No live category job',
  },
  {
    id: 'user-changes',
    requiredForConnection: false,
    label: 'User changes',
    enabled: true,
    qualified: false,
    scope: GOOGLE_USER_WRITE_SCOPE,
    method: 'users.patch',
    source:
      'https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/patch',
    evidence:
      'admin-sdk-mock 0.4.0 and live checks L3 and L4, which sent the value writes directly. No live value job',
  },
] as const);

/** Capability ids that the Google connection page lists during setup, in page order. */
const GOOGLE_SETUP_CAPABILITY_IDS = [
  'customer-identity',
  'domain-observations',
  'device-inventory',
  'device-telemetry',
  'device-changes',
  'school-ou-references',
  'drive-files',
  'user-inventory',
  'user-schemas',
  'user-schema-changes',
  'user-changes',
] as const;

/**
 * The scopes a fresh installation grants, in the order the connection page lists them.
 * The School OU scope is listed last, because the device OU picker reads that tree (design section 6).
 */
export const GOOGLE_SETUP_SCOPES = Object.freeze([
  ...new Set(
    GOOGLE_SETUP_CAPABILITY_IDS.flatMap((id) =>
      GOOGLE_CAPABILITIES.filter((capability) => capability.id === id).map(
        (capability) => capability.scope,
      ),
    ),
  ),
]);

export const GOOGLE_CUSTOMER_SCOPES = Object.freeze([
  ...new Set(
    GOOGLE_CAPABILITIES.filter(
      (capability) =>
        capability.requiredForConnection &&
        capability.enabled &&
        capability.qualified,
    ).map((capability) => capability.scope),
  ),
]);

/**
 * The scopes the Admin SDK mock harness grants to its service account: every
 * capability scope and both schema scopes.
 * `api-e2e/admin-sdk-mock-fixture.mjs` writes this exact list into the harness
 * key, and the capability health test mints its tokens from it.
 */
export const GOOGLE_HARNESS_SCOPES = Object.freeze([
  ...new Set([
    ...GOOGLE_CAPABILITIES.map((capability) => capability.scope),
    GOOGLE_SCHEMA_READ_SCOPE,
    GOOGLE_SCHEMA_WRITE_SCOPE,
  ]),
]);
