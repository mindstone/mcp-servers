/**
 * Runway authentication module.
 *
 * API key management — stored via env var (RUNWAYML_API_SECRET)
 * or configured at runtime via the configure_runway_api_key tool.
 *
 * Auth: Authorization: Bearer {key} + X-Runway-Version header on all API requests.
 */

import { rememberCredential } from './key-filter.js';

/** Runtime API key — starts from env, can be updated via configure tool. */
let apiKey: string = process.env.RUNWAYML_API_SECRET ?? '';
rememberCredential(apiKey);

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
  rememberCredential(key);
}

/**
 * Check if an API key is configured.
 */
export function hasApiKey(): boolean {
  return apiKey.trim().length > 0;
}
