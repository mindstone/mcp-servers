/**
 * ServiceNow API HTTP client.
 *
 * Centralises auth header injection, error handling, rate-limit
 * messaging, and instance URL construction for all ServiceNow API calls.
 *
 * Auth: Basic (username:password) by default; OAuth 2.0 client-credentials
 * Bearer tokens when SERVICENOW_CLIENT_ID / SERVICENOW_CLIENT_SECRET are set
 * and basic credentials are absent.
 * Base URL: https://{instance}.service-now.com/api/now/table
 */

import { z } from 'zod';
import {
  getInstance,
  getUsername,
  getPassword,
  isConfigured,
  isBasicConfigured,
  getOAuthClientId,
  getOAuthClientSecret,
  getCachedOAuthToken,
  setCachedOAuthToken,
  clearOAuthToken,
} from './auth.js';
import { ServiceNowError, REQUEST_TIMEOUT_MS } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

/** Bound on vendor error text surfaced to the model (chars). */
const MAX_VENDOR_ERROR_CHARS = 500;

/**
 * Returns the ServiceNow Table API base URL for the current instance.
 */
function getBaseUrl(): string {
  return `https://${getInstance()}.service-now.com/api/now/table`;
}

const OAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().nonnegative().optional(),
});

/**
 * Fetch an OAuth access token from the instance's token endpoint using the
 * client credentials grant. The token endpoint requires the instance-side
 * OAuth application registry entry and the inbound client-credentials grant
 * to be enabled.
 */
async function fetchOAuthToken(): Promise<string> {
  const url = `https://${getInstance()}.service-now.com/oauth_token.do`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: getOAuthClientId(),
        client_secret: getOAuthClientSecret(),
      }).toString(),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ServiceNowError(
        'Request to the ServiceNow OAuth token endpoint timed out',
        'TIMEOUT',
        'The token request took too long. Try again or check if the ServiceNow instance is available.',
      );
    }
    throw error;
  }

  if (!response.ok) {
    // Never echo the client secret or the response body — it can contain
    // instance-specific detail; the resolution carries the guidance.
    throw new ServiceNowError(
      `OAuth token request failed (${response.status}). Check your client ID and secret.`,
      'AUTH_FAILED',
      'Verify SERVICENOW_CLIENT_ID and SERVICENOW_CLIENT_SECRET, and that the instance has an OAuth application registry entry with the client credentials grant enabled.',
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ServiceNowError(
      'The ServiceNow OAuth token endpoint returned a non-JSON response.',
      'UNEXPECTED_CONTENT_TYPE',
      'Check that the instance name is correct and the OAuth plugin is active on the instance.',
    );
  }

  const token = OAuthTokenResponseSchema.safeParse(parsed);
  if (!token.success) {
    throw new ServiceNowError(
      'The ServiceNow OAuth token endpoint returned an unexpected response shape.',
      'API_ERROR',
      'The token response did not contain an access_token. Check the OAuth application registry entry on the instance.',
    );
  }

  setCachedOAuthToken(token.data.access_token, token.data.expires_in ?? 1800);
  return token.data.access_token;
}

/**
 * Builds the Authorization header for the configured auth method. Basic auth
 * takes precedence when both methods are configured.
 */
async function getAuthorizationHeader(): Promise<string> {
  if (isBasicConfigured()) {
    return 'Basic ' + Buffer.from(`${getUsername()}:${getPassword()}`).toString('base64');
  }
  const cached = getCachedOAuthToken();
  const token = cached ?? (await fetchOAuthToken());
  return `Bearer ${token}`;
}

/**
 * Builds a query string from key-value pairs, omitting undefined/empty values.
 */
export function buildQueryParams(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return entries.length > 0 ? `?${entries.join('&')}` : '';
}

/**
 * Make an authenticated request to the ServiceNow Table API.
 *
 * @param tablePath  Path relative to /api/now/table, e.g. `/incident`
 * @param options    Additional fetch options (method, body, headers)
 * @returns Parsed JSON result from the ServiceNow response
 */
export async function servicenowFetch<T>(
  tablePath: string,
  options: RequestInit = {},
): Promise<T> {
  if (!isConfigured()) {
    throw new ServiceNowError(
      'ServiceNow not configured',
      'AUTH_REQUIRED',
      'Use configure_servicenow to set your instance name, username, and password first, or set SERVICENOW_INSTANCE, SERVICENOW_CLIENT_ID, and SERVICENOW_CLIENT_SECRET for OAuth.',
    );
  }

  const url = `${getBaseUrl()}${tablePath}`;
  const authHeader = await getAuthorizationHeader();

  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string>),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ServiceNowError(
        'Request to ServiceNow API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the ServiceNow instance is available.',
      );
    }
    throw error;
  }

  if (response.status === 401 || response.status === 403) {
    if (isBasicConfigured()) {
      throw new ServiceNowError(
        'Authentication failed. Check your instance name, username, and password.',
        'AUTH_FAILED',
        'Re-configure with configure_servicenow. Ensure the account has itil and knowledge roles.',
      );
    }
    // OAuth: the cached token may have been revoked instance-side — drop it
    // so a retry fetches a fresh one.
    clearOAuthToken();
    throw new ServiceNowError(
      'Authentication failed. Check your OAuth client ID and secret.',
      'AUTH_FAILED',
      'Verify SERVICENOW_CLIENT_ID and SERVICENOW_CLIENT_SECRET, and that the OAuth application on the instance has the required API scopes. A fresh token will be requested on retry.',
    );
  }

  if (response.status === 429) {
    throw new ServiceNowError(
      'Rate limited by ServiceNow. Please wait before retrying.',
      'RATE_LIMITED',
      'Please wait before retrying. ServiceNow has rate limits based on your instance configuration.',
    );
  }

  if (response.status === 404) {
    throw new ServiceNowError(
      'Resource not found',
      'NOT_FOUND',
      'The requested record does not exist. Verify the identifier.',
    );
  }

  // Check for non-JSON responses (hibernating instance, login page, etc.)
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!response.ok) {
    let errorText: string;
    try {
      const errorBody = (await response.json()) as {
        error?: { message?: unknown; detail?: unknown };
      };
      // The vendor body is unchecked: a hostile shape (e.g. an object under
      // error.message) must not crash the error path — only strings are
      // picked, anything else falls back to the stringified body.
      const message = errorBody?.error?.message;
      const detail = errorBody?.error?.detail;
      errorText =
        (typeof message === 'string' && message) ||
        (typeof detail === 'string' && detail) ||
        JSON.stringify(errorBody) ||
        'Unknown error';
    } catch {
      errorText = await response.text().catch(() => 'Unknown error');
    }
    // Vendor error text is instance-authored and can embed record content or
    // prompt-injection payloads — envelope it (invariant #6) and bound its
    // length so a hostile body cannot flood the model context.
    const bounded = errorText.slice(0, MAX_VENDOR_ERROR_CHARS);
    const safeErrorText = wrapUntrusted(bounded, 'servicenow:api-error');
    throw new ServiceNowError(
      `ServiceNow API error (${response.status}): ${safeErrorText}`,
      'API_ERROR',
      'Check the request parameters and try again.',
    );
  }

  if (!contentType.includes('application/json')) {
    const bodyPreview = await response.text().catch(() => '(could not read body)');
    const isHibernating = bodyPreview.toLowerCase().includes('hibernat');
    // The Content-Type header is instance-authored too — envelope it like any
    // other vendor error material before it reaches model-visible output.
    const safeContentType = contentType
      ? wrapUntrusted(contentType.slice(0, MAX_VENDOR_ERROR_CHARS), 'servicenow:api-error')
      : '(absent)';
    throw new ServiceNowError(
      isHibernating
        ? `ServiceNow instance '${getInstance()}' is hibernating. Wake it at https://developer.servicenow.com and try again in a few minutes.`
        : `ServiceNow returned non-JSON response (Content-Type: ${safeContentType}). The instance may be down, misconfigured, or returning a login page.`,
      isHibernating ? 'INSTANCE_HIBERNATING' : 'UNEXPECTED_CONTENT_TYPE',
      isHibernating
        ? 'Wake the instance at https://developer.servicenow.com, wait a few minutes, then try again.'
        : 'Check that the instance name is correct and the instance is active.',
    );
  }

  // A JSON parse failure must not surface the parser's message — some runtimes
  // embed a fragment of the offending (instance-authored) body in it.
  let body: { result: T };
  try {
    body = (await response.json()) as { result: T };
  } catch {
    throw new ServiceNowError(
      'ServiceNow returned a malformed JSON response.',
      'MALFORMED_RESPONSE',
      'The instance returned an invalid response. Try again; if it persists, check the instance status.',
    );
  }
  return body.result;
}
