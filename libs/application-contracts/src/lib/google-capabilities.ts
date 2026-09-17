/** Phase 3 capabilities and their verified authorization boundaries. */
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
      'CC-52 production provider live read, exact OU scope, and packaged reference API qualification.',
  },
] as const);

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
