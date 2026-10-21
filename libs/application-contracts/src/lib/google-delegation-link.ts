import { GOOGLE_CAPABILITIES } from './google-capabilities';

/**
 * Google Admin console page that adds a domain-wide delegation client.
 * The page reads `clientScopeToAdd`, `clientIdToAdd`, `overwriteClientId`, and `dn`.
 */
export const GOOGLE_DELEGATION_CONSOLE_URL =
  'https://admin.google.com/ac/owl/domainwidedelegation';

const CAPABILITY_SCOPES: ReadonlySet<string> = new Set(
  GOOGLE_CAPABILITIES.map((capability) => capability.scope),
);

/**
 * The scopes a delegation link lists: the requested scopes plus every verified
 * scope, sorted, without duplicates.
 */
export function delegationLinkScopes(
  requested: readonly string[],
  verified: readonly string[],
): string[] {
  return [...new Set([...requested, ...verified])].sort();
}

/**
 * Build a pre-filled link for the Google Admin console.
 *
 * `overwriteClientId=true` makes Authorize replace the scope list of the
 * client. Callers must pass every verified scope, or the link removes one.
 */
export function delegationLink(input: {
  clientId: string;
  scopes: readonly string[];
  domain?: string;
}): string {
  if (!/^[0-9]+$/.test(input.clientId))
    throw new Error('A delegation link needs a numeric client ID.');
  const scopes = delegationLinkScopes(input.scopes, []);
  if (scopes.length === 0)
    throw new Error('A delegation link needs at least one scope.');
  for (const scope of scopes)
    if (!CAPABILITY_SCOPES.has(scope))
      throw new Error(`The capability list does not name the scope: ${scope}`);
  const parameters = [
    `clientScopeToAdd=${scopes.join(',')}`,
    `clientIdToAdd=${input.clientId}`,
    'overwriteClientId=true',
  ];
  if (input.domain) parameters.push(`dn=${input.domain}`);
  return `${GOOGLE_DELEGATION_CONSOLE_URL}?${parameters.join('&')}`;
}

/**
 * Build a pre-filled link for one client, or null when the page cannot name a
 * numeric client ID or a known scope.
 *
 * The scope list holds the requested scopes plus every verified scope, because
 * Authorize replaces the whole scope list of the client.
 */
export function buildDelegationLink(input: {
  clientId: string;
  requested: readonly string[];
  verified?: readonly string[];
  domain?: string;
}): string | null {
  if (!/^[0-9]{1,32}$/.test(input.clientId)) return null;
  try {
    return delegationLink({
      clientId: input.clientId,
      scopes: delegationLinkScopes(input.requested, input.verified ?? []),
      domain: input.domain,
    });
  } catch {
    return null;
  }
}
