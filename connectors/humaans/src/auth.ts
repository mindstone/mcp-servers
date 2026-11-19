/**
 * Humaans authentication module.
 *
 * The API key comes only from the HUMAANS_API_KEY environment variable, which
 * the host sets from its own connector settings. No tool accepts the key, so
 * it never passes through the conversation.
 */

const apiKey: string = process.env.HUMAANS_API_KEY || '';

/**
 * Returns the current API key.
 */
export function getApiKey(): string {
  return apiKey;
}

/**
 * Returns true if an API key is configured.
 */
export function isConfigured(): boolean {
  return apiKey.length > 0;
}

export const TOKEN_URL = 'https://app.humaans.io/settings/home?tokens=1';
export const TOKEN_SCOPES = 'public:read, private:read, private:write';

/** The one setup instruction every not-configured or bad-token message gives. */
export const ADD_TOKEN_IN_SETTINGS =
  'Ask the person to add their Humaans API token in the app\'s Settings → Connectors ' +
  '(if the MCP host has no connector settings, set the HUMAANS_API_KEY environment variable). ' +
  'Do not ask for the token in chat or accept it there.';
