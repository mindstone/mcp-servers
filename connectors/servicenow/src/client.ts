/**
 * ServiceNow API HTTP client.
 *
 * Centralises Basic auth header injection, error handling, rate-limit
 * messaging, and instance URL construction for all ServiceNow API calls.
 *
 * Auth: Authorization: Basic base64(username:password)
 * Base URL: https://{instance}.service-now.com/api/now/table
 */

import { getInstance, getUsername, getPassword, isConfigured } from './auth.js';
import { ServiceNowError, REQUEST_TIMEOUT_MS } from './types.js';

/**
 * Returns the ServiceNow Table API base URL for the current instance.
 */
function getBaseUrl(): string {
  return `https://${getInstance()}.service-now.com/api/now/table`;
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
      'Use configure_servicenow to set your instance name, username, and password first.',
    );
  }

  const url = `${getBaseUrl()}${tablePath}`;
  const authHeader =
    'Basic ' + Buffer.from(`${getUsername()}:${getPassword()}`).toString('base64');

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
    throw new ServiceNowError(
      'Authentication failed. Check your instance name, username, and password.',
      'AUTH_FAILED',
      'Re-configure with configure_servicenow. Ensure the account has itil and knowledge roles.',
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
        error?: { message?: string; detail?: string };
      };
      errorText =
        errorBody?.error?.message || errorBody?.error?.detail || JSON.stringify(errorBody);
    } catch {
      errorText = await response.text().catch(() => 'Unknown error');
    }
    throw new ServiceNowError(
      `ServiceNow API error (${response.status}): ${errorText}`,
      'API_ERROR',
      'Check the request parameters and try again.',
    );
  }

  if (!contentType.includes('application/json')) {
    const bodyPreview = await response.text().catch(() => '(could not read body)');
    const isHibernating = bodyPreview.toLowerCase().includes('hibernat');
    throw new ServiceNowError(
      isHibernating
        ? `ServiceNow instance '${getInstance()}' is hibernating. Wake it at https://developer.servicenow.com and try again in a few minutes.`
        : `ServiceNow returned non-JSON response (Content-Type: ${contentType}). The instance may be down, misconfigured, or returning a login page.`,
      isHibernating ? 'INSTANCE_HIBERNATING' : 'UNEXPECTED_CONTENT_TYPE',
      isHibernating
        ? 'Wake the instance at https://developer.servicenow.com, wait a few minutes, then try again.'
        : 'Check that the instance name is correct and the instance is active.',
    );
  }

  const body = (await response.json()) as { result: T };
  return body.result;
}
