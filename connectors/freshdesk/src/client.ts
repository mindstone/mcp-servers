/**
 * Freshdesk API HTTP client.
 *
 * Centralises Basic auth header injection, error handling, rate-limit
 * messaging, and domain URL construction for all Freshdesk API calls.
 *
 * Auth: Authorization: Basic base64(apiKey:X)
 * Base URL: https://{domain}.freshdesk.com/api/v2
 */

import { FreshdeskError, REQUEST_TIMEOUT_MS } from './types.js';
import { validateSubdomain } from './utils.js';

export interface FreshdeskFetchOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

/**
 * Make an authenticated request to the Freshdesk API.
 *
 * @param domain   Freshdesk subdomain (e.g. "acme")
 * @param apiKey   Freshdesk API key
 * @param endpoint Path relative to /api/v2, e.g. '/tickets'
 * @param options  Additional fetch options (method, body, headers, params)
 * @returns Parsed JSON response
 */
export async function freshdeskFetch<T>(
  domain: string,
  apiKey: string,
  endpoint: string,
  options: FreshdeskFetchOptions = {},
): Promise<T> {
  // Defence-in-depth: validate domain before URL construction
  validateSubdomain(domain);

  const { params, ...fetchOptions } = options;

  // Build URL with query params
  let url = `https://${domain}.freshdesk.com/api/v2${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        searchParams.append(key, String(value));
      }
    }
    const queryString = searchParams.toString();
    if (queryString) {
      url += (url.includes('?') ? '&' : '?') + queryString;
    }
  }

  // Build auth header: Basic base64("{apiKey}:X")
  const authHeader = `Basic ${Buffer.from(`${apiKey}:X`).toString('base64')}`;

  console.error(`[Freshdesk API] ${fetchOptions.method || 'GET'} ${url}`);

  let response: Response;

  try {
    response = await fetch(url, {
      ...fetchOptions,
      signal: fetchOptions.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(fetchOptions.headers as Record<string, string>),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new FreshdeskError(
        'Request to Freshdesk API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the Freshdesk instance is available.',
      );
    }
    throw error;
  }

  // Handle rate limiting
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const waitTime = retryAfter ? `${retryAfter} seconds` : 'a moment';
    throw new FreshdeskError(
      `Rate limited. Please wait ${waitTime} before retrying.`,
      'RATE_LIMITED',
      `Wait ${waitTime} and try again. Freshdesk rate limits vary by plan (Blossom: 100/min, Estate: 400/min, Forest: 700/min).`,
    );
  }

  // Handle auth errors
  if (response.status === 401) {
    throw new FreshdeskError(
      'Authentication failed',
      'AUTH_FAILED',
      'API key is invalid or revoked. Check your Freshdesk API key in your MCP host\'s settings.',
    );
  }

  // Handle forbidden
  if (response.status === 403) {
    throw new FreshdeskError(
      'Access forbidden',
      'AUTH_FAILED',
      'Your API key does not have permission for this operation. Check your Freshdesk plan and role.',
    );
  }

  // Handle not found
  if (response.status === 404) {
    throw new FreshdeskError(
      'Resource not found',
      'NOT_FOUND',
      'The requested resource does not exist or you do not have permission to access it.',
    );
  }

  // Handle other errors
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    console.error(`Freshdesk API error (${response.status}):`, errorText);

    const statusMessage =
      response.status === 422
        ? 'Validation error - check request parameters'
        : response.status >= 500
          ? 'Freshdesk server error - try again later'
          : 'Request failed';

    throw new FreshdeskError(
      `Freshdesk API error (${response.status}): ${statusMessage}`,
      'API_ERROR',
      'Check the request parameters and try again. If the problem persists, reconnect your Freshdesk account in your MCP host\'s settings.',
    );
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}
