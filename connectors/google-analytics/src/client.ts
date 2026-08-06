/**
 * Thin REST client for the Google Analytics Admin API and Data API.
 * Uses google-auth-library for token minting and node fetch for the
 * actual HTTP calls — direct REST avoids the auth transport edge cases
 * that gRPC client libraries can hit with `authorized_user` ADC tokens.
 */

import { z } from 'zod';
import { getAccessToken } from './auth.js';
import {
  ADMIN_BASE_URL,
  ADMIN_ALPHA_BASE_URL,
  DATA_BASE_URL,
  DATA_ALPHA_BASE_URL,
  GoogleAnalyticsError,
  USER_AGENT,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from './types.js';
import { wrapUntrusted } from './untrusted-content.js';
import { parseApiResponse, UNTRUSTED_SOURCES } from './utils.js';

/** Shape of the standard Google API error payload, validated at the boundary. */
const apiErrorPayloadSchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        status: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

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
  dataAlpha: DATA_ALPHA_BASE_URL,
} as const;

/**
 * Hard cap on followed list pages. A misbehaving or compromised upstream
 * that returns a perpetual nextPageToken must fail observably instead of
 * looping forever and growing memory without bound. 250 pages at the
 * connector's page sizes (100-200 items) is far beyond any legitimate GA4
 * collection.
 */
export const MAX_LIST_PAGES = 250;

/**
 * Throw the shared observable failure for pagination that does not terminate.
 */
export function paginationLimitExceeded(context: string): never {
  throw new GoogleAnalyticsError(
    `Google API pagination for ${context} did not terminate after ${MAX_LIST_PAGES} pages.`,
    'PAGINATION_LIMIT_EXCEEDED',
    'The API kept returning a nextPageToken beyond the safety cap. Try again; if the problem persists, narrow the query or check for a connector update.',
  );
}

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

    // The runtime's JSON parse error can embed a fragment of the
    // (vendor-controlled, potentially attacker-influenced) body; never let it
    // propagate into model-visible output. Fail closed with a sanitised
    // error instead.
    let data: Record<string, unknown> | null = null;
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('non-object JSON body');
        }
        data = parsed as Record<string, unknown>;
      } catch {
        throw new GoogleAnalyticsError(
          `Google API returned a response that could not be parsed (HTTP ${response.status}).`,
          'INVALID_API_RESPONSE',
          'Try again. If the problem persists, the API response format may have changed — check for a connector update.',
        );
      }
    }

    if (!response.ok) {
      const parsedError = apiErrorPayloadSchema.safeParse(data ?? {});
      const apiError = parsedError.success ? parsedError.data.error : undefined;
      // Vendor error text is untrusted external content — envelope it before
      // it reaches model-visible output (invariant #6). Never fall back to
      // raw response.statusText, which is also vendor-controlled.
      const message = apiError?.message
        ? (wrapUntrusted(apiError.message, UNTRUSTED_SOURCES.apiError) ??
          `Google API request failed (HTTP ${response.status}).`)
        : `Google API request failed (HTTP ${response.status}).`;
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
 *
 * Every page's items are fail-closed validated against `itemSchema` at the
 * boundary (INVALID_API_RESPONSE on shape mismatch) instead of being
 * TypeScript-cast only. A non-string nextPageToken ends pagination rather
 * than being coerced into a query parameter.
 */
export async function paginate<T>(
  apiPath: string,
  options: {
    itemKey: string;
    itemSchema: z.ZodType<T>;
    query?: GoogleApiOptions['query'];
    baseUrl?: string;
  },
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    pages += 1;
    if (pages > MAX_LIST_PAGES) {
      paginationLimitExceeded(options.itemKey);
    }
    const response = await googleApi<Record<string, unknown>>(apiPath, {
      method: 'GET',
      query: { ...options.query, pageToken },
      baseUrl: options.baseUrl,
    });
    const page = parseApiResponse(
      z.array(options.itemSchema),
      response?.[options.itemKey] ?? [],
      `${options.itemKey}.list`,
    );
    items.push(...page);
    const rawToken = response?.nextPageToken;
    pageToken = typeof rawToken === 'string' && rawToken !== '' ? rawToken : undefined;
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
