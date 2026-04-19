/**
 * TalentLMS API HTTP client.
 *
 * Centralises Basic auth injection (base64(apiKey:) with colon preserved, empty password),
 * error handling, rate-limit messaging, and timeout handling.
 *
 * Base URL: https://{domain}.talentlms.com/api/v1
 */

import { TalentLMSError, REQUEST_TIMEOUT_MS } from './types.js';
import { getApiKey, getDomain, isConfigured } from './auth.js';

function getBaseUrl(): string {
  return `https://${getDomain()}.talentlms.com/api/v1`;
}

/**
 * Make an authenticated request to the TalentLMS API.
 */
export async function talentlmsFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!isConfigured()) {
    throw new TalentLMSError(
      'TalentLMS not configured',
      'AUTH_REQUIRED',
      'Configure your TalentLMS API key and domain. Call configure_talentlms first.',
    );
  }

  const apiKey = getApiKey();
  const url = `${getBaseUrl()}${path}`;

  const authHeader = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: authHeader,
    ...(options.headers as Record<string, string> || {}),
  };
  if (options.body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new TalentLMSError(
        'Request to TalentLMS API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if TalentLMS is available.',
      );
    }
    throw error;
  }

  if (response.status === 429) {
    throw new TalentLMSError(
      'Rate limited by TalentLMS. Please wait before retrying.',
      'RATE_LIMITED',
      'Please wait before retrying. TalentLMS rate limits: 2,000-10,000 calls/hour depending on plan.',
    );
  }

  if (response.status === 401 || response.status === 403) {
    let errorText: string;
    try {
      const errorBody = await response.json() as { error?: { message?: string } };
      errorText = errorBody?.error?.message || 'Unauthorized';
    } catch {
      errorText = 'Unauthorized';
    }
    throw new TalentLMSError(
      `Authentication failed: ${errorText}`,
      'AUTH_FAILED',
      'Re-configure with configure_talentlms. Ensure Super Admin API access is enabled.',
    );
  }

  if (!response.ok) {
    let errorText: string;
    try {
      const errorBody = await response.json() as { error?: { message?: string; type?: string } };
      errorText = errorBody?.error?.message || JSON.stringify(errorBody);
    } catch {
      errorText = await response.text().catch(() => 'Unknown error');
    }
    throw new TalentLMSError(
      `TalentLMS API error (${response.status}): ${errorText}`,
      `HTTP_${response.status}`,
      'Check the request parameters and try again.',
    );
  }

  return response.json() as Promise<T>;
}

/**
 * URL-encode form parameters, omitting undefined values.
 */
export function formEncode(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][];
  return new URLSearchParams(entries).toString();
}
