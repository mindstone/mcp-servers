/**
 * ElevenLabs authentication module.
 *
 * Simple API key management — stored via env var (ELEVENLABS_API_KEY)
 * or configured at runtime via the configure_elevenlabs_api_key tool.
 *
 * Auth: xi-api-key header on all API requests (NOT Bearer).
 */

/** Runtime API key — starts from env, can be updated via configure tool. */
let apiKey: string = process.env.ELEVENLABS_API_KEY ?? '';

/**
 * Get the current API key.
 */
export function getApiKey(): string {
  return apiKey;
}

/**
 * Set the API key at runtime (from configure tool).
 */
export function setApiKey(key: string): void {
  apiKey = key;
}

/**
 * Check if an API key is configured.
 */
export function hasApiKey(): boolean {
  return apiKey.trim().length > 0;
}
