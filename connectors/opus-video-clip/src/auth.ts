/**
 * Opus authentication module.
 *
 * The API key is read from `OPUS_API_KEY` at import time and may be
 * overridden at runtime via the `configure_opus_api_key` tool. The
 * `opusFetch` client reads via `getApiKey()` at request-time, so a runtime
 * override takes effect on the very next API call.
 */

import { OpusError } from './types.js';

let apiKey: string = process.env.OPUS_API_KEY ?? '';

export function getApiKey(): string {
  return apiKey;
}

export function setApiKey(key: string): void {
  apiKey = key;
}

export function hasApiKey(): boolean {
  return apiKey.trim().length > 0;
}

/**
 * Throws an `AUTH_REQUIRED` error if no API key is configured. Returns the
 * key on success. Callers should invoke this at the top of every tool
 * handler that needs upstream API access.
 */
export function requireApiKey(): string {
  if (!hasApiKey()) {
    throw new OpusError(
      'Opus API key not configured',
      'AUTH_REQUIRED',
      'The user adds the OpusClip API key in Settings → Connectors in the app. Do not ask for it in chat. Get it from https://app.opus.pro/settings/integration-tokens.',
    );
  }
  return apiKey;
}
