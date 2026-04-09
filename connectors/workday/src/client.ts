/**
 * Workday API HTTP client.
 *
 * Centralises Bearer auth injection, error handling,
 * rate-limit retry with exponential backoff, and timeout handling.
 *
 * Auth: OAuth2 Bearer token via getAccessToken()
 * Base URL: https://{host}/ccx/api/v1/{tenant}
 */

import { WorkdayError, USER_AGENT, REQUEST_TIMEOUT_MS } from './types.js';
import { getAccessToken, getApiBaseUrl, isConfigured, clearTokenCache } from './auth.js';

/**
 * Make an authenticated JSON request to the Workday REST API.
 */
export async function workdayFetch<T>(
  resourcePath: string,
  options: RequestInit = {},
  retryCount = 0,
): Promise<T> {
  if (!isConfigured()) {
    throw new WorkdayError(
      'Workday not configured. Call configure_workday_credentials first.',
      'NOT_CONFIGURED',
      'Configure Workday with your OAuth credentials first.',
    );
  }

  const accessToken = await getAccessToken();
  const url = `${getApiBaseUrl()}${resourcePath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ...(options.headers as Record<string, string>),
  };

  console.error(`[Workday API] ${options.method || 'GET'} ${url}`);

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new WorkdayError(
        'Request to Workday API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the Workday API is available.',
      );
    }
    throw error;
  }

  if (!response.ok) {
    // Handle 429 with exponential backoff (max 3 retries)
    if (response.status === 429 && retryCount < 3) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(1000 * Math.pow(2, retryCount), 8000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return workdayFetch<T>(resourcePath, options, retryCount + 1);
    }

    let errorText: string;
    try {
      const errorBody = await response.json() as { error?: string; errors?: Array<{ error?: string; message?: string }> };
      const firstError = errorBody?.errors?.[0];
      errorText = firstError?.message || firstError?.error || errorBody?.error || JSON.stringify(errorBody);
    } catch {
      errorText = await response.text().catch(() => 'Unknown error');
    }

    if (response.status === 401) {
      clearTokenCache();
      throw new WorkdayError(
        `Authentication failed (${response.status}): ${errorText}`,
        'AUTH_FAILED',
        'Re-configure with configure_workday_credentials. Check client ID, secret, and tenant.',
      );
    }

    if (response.status === 403) {
      throw new WorkdayError(
        `Insufficient permissions (${response.status}): ${errorText}`,
        'FORBIDDEN',
        'Check ISU security group and domain permissions in Workday.',
      );
    }

    if (response.status === 404) {
      throw new WorkdayError(
        `Resource not found (${response.status}): ${errorText}`,
        'NOT_FOUND',
        'Verify the ID is correct.',
      );
    }

    if (response.status === 429) {
      throw new WorkdayError(
        'Rate limited. Maximum retries exhausted.',
        'RATE_LIMITED',
        'Please wait before retrying.',
      );
    }

    if (response.status >= 500) {
      throw new WorkdayError(
        `Workday server error (${response.status}): ${errorText}`,
        'SERVER_ERROR',
        'Workday server error. Try again later.',
      );
    }

    throw new WorkdayError(
      `Workday API error (${response.status}): ${errorText}`,
      `HTTP_${response.status}`,
      'Check the request parameters and try again.',
    );
  }

  return await response.json() as T;
}
