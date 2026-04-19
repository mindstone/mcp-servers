/**
 * Test account configurations matching the AccountInfo and AccountsConfig types.
 */

/** API token-based account for most tests */
export const API_TOKEN_ACCOUNT = {
  subdomain: 'testcorp',
  email: 'agent@testcorp.example.com',
  apiToken: 'test-api-token-12345',
} as const;

/** OAuth-based account for auth flow tests */
export const OAUTH_ACCOUNT = {
  subdomain: 'oauthcorp',
  email: 'agent@oauthcorp.example.com',
} as const;

/**
 * Creates the accounts.json structure expected by loadAccounts().
 */
export function makeAccountsJson(
  accounts: Array<{ subdomain: string; email: string; apiToken?: string }>,
  defaultSubdomain?: string,
): { accounts: typeof accounts; defaultSubdomain?: string } {
  return {
    accounts,
    ...(defaultSubdomain ? { defaultSubdomain } : {}),
  };
}
