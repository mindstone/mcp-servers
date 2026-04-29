/**
 * Thin REST client for the Google Analytics Admin API and Data API.
 * Uses google-auth-library for token minting and node fetch for the
 * actual HTTP calls — direct REST avoids the auth transport edge cases
 * that gRPC client libraries can hit with `authorized_user` ADC tokens.
 */

import { getAccessToken } from './auth.js';
import {
  ADMIN_BASE_URL,
  ADMIN_ALPHA_BASE_URL,
  DATA_BASE_URL,
  GoogleAnalyticsError,
  USER_AGENT,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from './types.js';

interface GoogleApiOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  baseUrl?: string;
  signal?: AbortSignal;
}

/** Bases the client may target. Re-exported for tests and tools. */
export const Bases = {
  admin: ADMIN_BASE_URL,
  adminAlpha: ADMIN_ALPHA_BASE_URL,
  data: DATA_BASE_URL,
} as const;

/**
 * Call a Google API endpoint with the configured ADC bearer token.
 * Surfaces the API's `error.message` field on non-2xx responses.
 */
export async function googleApi<T = unknown>(
  apiPath: string,
  options: GoogleApiOptions = {},
): Promise<T> {
  const { method = 'GET', query, body, baseUrl = ADMIN_BASE_URL, signal } = options;

  const token = await getAccessToken();
  const url = new URL(`${baseUrl}${apiPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const controller = signal ? undefined : new AbortController();
  const timer = controller
    ? setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS)
    : undefined;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ?? controller?.signal,
    });

    const text = await response.text();
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : null;

    if (!response.ok) {
      const apiError = (data as { error?: { message?: string; status?: string } })?.error;
      const message =
        apiError?.message || `${response.status} ${response.statusText}`;
      throw new GoogleAnalyticsError(
        message,
        apiError?.status || `HTTP_${response.status}`,
        'Check that the credential has access to this resource and that the relevant Google APIs are enabled in the Cloud project attached to the credential.',
      );
    }

    return data as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Iterate paginated list endpoints, accumulating all items. Used for the
 * smaller admin collections (account summaries, properties, links) where
 * full enumeration is the expected mode.
 */
export async function paginate<T>(
  apiPath: string,
  options: { itemKey: string; query?: GoogleApiOptions['query']; baseUrl?: string },
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;

  do {
    const response = await googleApi<Record<string, unknown>>(apiPath, {
      method: 'GET',
      query: { ...options.query, pageToken },
      baseUrl: options.baseUrl,
    });
    const page = (response?.[options.itemKey] as T[] | undefined) || [];
    items.push(...page);
    pageToken = response?.nextPageToken as string | undefined;
  } while (pageToken);

  return items;
}

/** Resolve `properties/<id>`, accepting either bare IDs or prefixed forms. */
export function propertyPath(propertyId?: string): string {
  const resolved = propertyId || process.env.GA4_PROPERTY_ID;
  if (!resolved) {
    throw new GoogleAnalyticsError(
      'GA4 property ID is required.',
      'PROPERTY_ID_REQUIRED',
      'Pass `property_id` in the tool arguments or set the GA4_PROPERTY_ID environment variable. Use `ga_list_account_summaries` to discover available property IDs.',
    );
  }
  const clean = String(resolved).replace(/^properties\//, '');
  return `properties/${clean}`;
}

/** Resolve `accounts/<id>`, accepting either bare IDs or prefixed forms. */
export function accountPath(accountId: string): string {
  const clean = String(accountId).replace(/^accounts\//, '');
  return `accounts/${clean}`;
}
