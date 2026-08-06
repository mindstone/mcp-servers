/**
 * QuickBooks Online API HTTP client.
 *
 * Centralises Bearer auth injection, error handling,
 * rate-limit retry with exponential backoff, and timeout handling.
 *
 * Auth: OAuth2 Bearer token via getAccessToken()
 * Base URL: https://{host}/v3/company/{realmId}
 */

import { QuickBooksError, USER_AGENT, REQUEST_TIMEOUT_MS, QBO_MINOR_VERSION } from './types.js';
import { getAccessToken, getBaseUrl, isConfigured, clearTokenCache } from './auth.js';
import { wrapUntrusted } from './untrusted-content.js';

/**
 * Make an authenticated request to the QuickBooks Online API and return the
 * raw Response. Callers parse the body (JSON entities vs binary documents).
 */
async function qboRequest(
  entityPath: string,
  options: RequestInit = {},
  retryCount = 0,
): Promise<Response> {
  if (!isConfigured()) {
    throw new QuickBooksError(
      'QuickBooks not configured. Call configure_quickbooks first.',
      'NOT_CONFIGURED',
      'Configure QuickBooks with your Intuit Developer app credentials first.',
    );
  }

  const accessToken = await getAccessToken();
  const url = `${getBaseUrl()}${entityPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    ...(options.headers as Record<string, string>),
  };

  console.error(`[QuickBooks API] ${options.method || 'GET'} ${url}`);

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new QuickBooksError(
        'Request to QuickBooks API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the QuickBooks API is available.',
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
      return qboRequest(entityPath, options, retryCount + 1);
    }

    let errorText: string;
    try {
      const errorBody = await response.json() as {
        Fault?: { Error?: Array<{ Message?: string; Detail?: string }> };
      };
      const firstError = errorBody?.Fault?.Error?.[0];
      errorText = firstError?.Detail || firstError?.Message || JSON.stringify(errorBody);
    } catch {
      errorText = await response.text().catch(() => 'Unknown error');
    }
    // Fault Detail/Message is vendor-controlled text on its way to the model
    // (QuickBooksError.message -> withErrorHandling -> tool output). Envelope
    // it so a compromised API response cannot inject instructions or break
    // out of the surrounding untrusted-content envelope (AGENTS.md #6).
    errorText = wrapUntrusted(errorText, 'quickbooks:api-error') ?? 'Unknown error';

    if (response.status === 401) {
      clearTokenCache();
      throw new QuickBooksError(
        `Authentication failed (${response.status}): ${errorText}`,
        'AUTH_FAILED',
        'Re-configure with configure_quickbooks. Check your credentials.',
      );
    }

    if (response.status === 403) {
      throw new QuickBooksError(
        `Insufficient permissions (${response.status}): ${errorText}`,
        'FORBIDDEN',
        'Check your QuickBooks app permissions.',
      );
    }

    if (response.status === 404) {
      throw new QuickBooksError(
        `Resource not found (${response.status}): ${errorText}`,
        'NOT_FOUND',
        'Verify the entity type and ID are correct.',
      );
    }

    if (response.status === 429) {
      throw new QuickBooksError(
        'Rate limited. Maximum retries exhausted.',
        'RATE_LIMITED',
        'Please wait before retrying.',
      );
    }

    if (response.status >= 500) {
      throw new QuickBooksError(
        `QuickBooks server error (${response.status}): ${errorText}`,
        'SERVER_ERROR',
        'QuickBooks server error. Try again later.',
      );
    }

    throw new QuickBooksError(
      `QuickBooks API error (${response.status}): ${errorText}`,
      `HTTP_${response.status}`,
      'Check the request parameters and try again.',
    );
  }

  return response;
}

/**
 * Make an authenticated JSON request to the QuickBooks Online API.
 */
export async function qboFetch<T>(
  entityPath: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await qboRequest(entityPath, options);
  try {
    return await response.json() as T;
  } catch {
    // A 2xx with a non-JSON body: the runtime's JSON parse error embeds a
    // snippet of the (vendor-controlled) body in its message. Do not
    // propagate it — surface a static error so raw vendor bytes never reach
    // model output via withErrorHandling's generic branch.
    throw new QuickBooksError(
      `QuickBooks API returned a non-JSON response to ${options.method || 'GET'} ${entityPath}.`,
      'INVALID_RESPONSE',
      'The API returned an unexpected response format. Retry the request; if it persists, check the QuickBooks API status.',
    );
  }
}

/**
 * Fetch a binary document (e.g. an invoice PDF) from the QuickBooks Online API.
 */
export async function qboFetchBinary(entityPath: string, accept: string): Promise<Buffer> {
  const response = await qboRequest(entityPath, { headers: { Accept: accept } });
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Sparse-update a QuickBooks entity: POST { Id, SyncToken, sparse: true, ...fields }
 * to the entity endpoint. When `syncToken` is not supplied the entity is read
 * first to obtain the current one (QBO rejects updates with a stale SyncToken).
 * Returns the updated entity object.
 */
export async function qboSparseUpdate(
  entityPath: string,
  entityKey: string,
  id: string,
  syncToken: string | undefined,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let token = syncToken;
  if (token === undefined) {
    const current = await qboFetch<Record<string, Record<string, unknown>>>(
      `/${entityPath}/${encodeURIComponent(id)}?minorversion=${QBO_MINOR_VERSION}`,
    );
    const entity = current[entityKey] ?? current;
    if (typeof entity?.SyncToken !== 'string') {
      throw new QuickBooksError(
        `Could not read the current SyncToken for ${entityKey} ${id}.`,
        'SYNC_TOKEN_UNAVAILABLE',
        'Verify the entity ID is correct with get_quickbooks_entity, then retry.',
      );
    }
    token = entity.SyncToken;
  }

  const result = await qboFetch<Record<string, Record<string, unknown>>>(
    `/${entityPath}?minorversion=${QBO_MINOR_VERSION}`,
    {
      method: 'POST',
      body: JSON.stringify({ Id: id, SyncToken: token, sparse: true, ...fields }),
    },
  );
  return result[entityKey] ?? {};
}

/**
 * Run a QuickBooks query using the Query Language.
 */
export async function qboQuery<T>(
  entity: string,
  query: string,
  limit = 100,
  offset = 1,
): Promise<T[]> {
  const fullQuery = `${query} MAXRESULTS ${limit} STARTPOSITION ${offset}`;
  const encoded = encodeURIComponent(fullQuery);
  const result = await qboFetch<{ QueryResponse: Record<string, T[]> }>(`/query?query=${encoded}`);
  return result.QueryResponse[entity] || [];
}

export interface QboQueryPage<T> {
  rows: T[];
  /** True when more rows exist beyond the requested limit. */
  hasMore: boolean;
}

/**
 * Run a QuickBooks query and report whether the result was truncated at
 * `limit`. Requests one extra row as a probe so `hasMore` is exact rather
 * than a "returned count equals limit" guess; the probe row is sliced off.
 */
export async function qboQueryPage<T>(
  entity: string,
  query: string,
  limit: number,
  offset = 1,
): Promise<QboQueryPage<T>> {
  const rows = await qboQuery<T>(entity, query, limit + 1, offset);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * Standard truncation note for list-tool output, so the model knows the
 * page is partial instead of silently treating it as complete.
 */
export function truncationNote(limit: number): string {
  return `Results truncated at ${limit}. Narrow the filters or pass a higher limit (max 1000) to see more.`;
}
