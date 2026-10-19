/**
 * Builds a Google Admin console link for domain-wide delegation.
 *
 * This stub stays here for the failing-first test run. The implementation
 * replaces it in the next commit.
 */
export function delegationLinkScopes(
  _requested: readonly string[],
  _verified: readonly string[],
): string[] {
  return [];
}

export function delegationLink(_input: {
  clientId: string;
  scopes: readonly string[];
  domain?: string;
}): string {
  return '';
}