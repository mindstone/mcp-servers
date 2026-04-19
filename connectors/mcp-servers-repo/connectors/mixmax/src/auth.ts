/**
 * Mixmax authentication module.
 *
 * Manages the API token lifecycle — env var on startup, runtime update via
 * configure tool, and bridge integration for host-app credential management.
 */

let apiToken: string = process.env.MIXMAX_API_TOKEN || '';

/**
 * Returns the current API token.
 */
export function getApiToken(): string {
  return apiToken;
}

/**
 * Returns true if an API token is configured.
 */
export function isConfigured(): boolean {
  return apiToken.length > 0;
}

/**
 * Update the API token at runtime (e.g. after configure_mixmax_api_key).
 */
export function setApiToken(token: string): void {
  apiToken = token;
}
