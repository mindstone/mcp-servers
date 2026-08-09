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
import {
  getAccessToken,
  getApiBaseUrl,
  getServiceApiBaseUrl,
  getHost,
  isConfigured,
  clearTokenCache,
  assertHostResolvesPublic,
} from './auth.js';

/**
 * Make an authenticated JSON request to the Workday REST API.
 *
 * `serviceFamily` selects a non-default API family (e.g. 'absenceManagement/v1');
 * when omitted, requests go to the core /ccx/api/v1/{tenant} surface.
 */
export async function workdayFetch<T>(
  resourcePath: string,
  options: RequestInit = {},
  retryCount = 0,
  serviceFamily?: string,
): Promise<T> {
  if (!isConfigured()) {
    throw new WorkdayError(
      'Workday not configured. Call configure_workday_credentials first.',
      'NOT_CONFIGURED',
      'Configure Workday with your OAuth credentials first.',
    );
  }

  const accessToken = await getAccessToken();

  // The token cache short-circuits getAccessToken's own DNS re-check, so the
  // guard must run here too: the bearer token is credential-bearing, and the
  // host could have been rebound to a non-public address since the token
  // exchange. This is still best-effort (fetch re-resolves the name itself),
  // but a flipped A/AAAA record is refused before the token leaves.
  await assertHostResolvesPublic(getHost());

  const baseUrl = serviceFamily ? getServiceApiBaseUrl(serviceFamily) : getApiBaseUrl();
  const url = `${baseUrl}${resourcePath}`;
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
      // Never auto-follow redirects: a vendor/proxy-controlled Location header
      // would replay the bearer token to an arbitrary host. 3xx is rejected
      // explicitly below.
      redirect: 'manual',
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
      // Retry-After is vendor/proxy-controlled: cap the wait at the same 8s
      // ceiling as the backoff branch so a huge value cannot hold the tool
      // call for hours, and treat garbage/negative values as the ceiling
      // instead of firing immediately.
      const retryAfterSecs = retryAfter ? parseInt(retryAfter, 10) : NaN;
      const waitMs = retryAfter
        ? Math.min(Number.isFinite(retryAfterSecs) && retryAfterSecs >= 0 ? retryAfterSecs * 1000 : 8000, 8000)
        : Math.min(1000 * Math.pow(2, retryCount), 8000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return workdayFetch<T>(resourcePath, options, retryCount + 1, serviceFamily);
    }

    // Fetches run with redirect: 'manual', so a 3xx lands here instead of
    // being auto-followed (which would replay the bearer token to the
    // redirect target). Fail closed with a connector-authored message.
    if (response.status >= 300 && response.status < 400) {
      throw new WorkdayError(
        `Workday API attempted a redirect (HTTP ${response.status}), which was refused.`,
        'API_ERROR',
        'The Workday API returned an unexpected redirect. Verify the configured host is correct.',
      );
    }

    // Do NOT read the vendor error body into model-visible output or logs:
    // it is vendor/proxy-controlled text that may reflect credentials or
    // carry injected instructions. Emit bounded, connector-authored messages.
    console.error(`[Workday API] Request failed (HTTP ${response.status})`);

    if (response.status === 401) {
      clearTokenCache();
      throw new WorkdayError(
        'Authentication failed (401).',
        'AUTH_FAILED',
        'Re-configure with configure_workday_credentials. Check client ID, secret, and tenant.',
      );
    }

    if (response.status === 403) {
      throw new WorkdayError(
        'Insufficient permissions (403).',
        'FORBIDDEN',
        'Check ISU security group and domain permissions in Workday.',
      );
    }

    if (response.status === 404) {
      throw new WorkdayError(
        'Resource not found (404).',
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
        `Workday server error (${response.status}).`,
        'SERVER_ERROR',
        'Workday server error. Try again later.',
      );
    }

    throw new WorkdayError(
      `Workday API error (${response.status}).`,
      `HTTP_${response.status}`,
      'Check the request parameters and try again.',
    );
  }

  return await response.json() as T;
}
