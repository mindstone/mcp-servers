import {
  type ZendeskAccount,
  type ZendeskFetchOptions,
  type ZendeskComment,
  ZendeskError,
  REQUEST_TIMEOUT_MS,
  MAX_COMMENTS_PER_TICKET,
  assertValidSubdomain,
} from './types.js';
import { getAuthHeader, refreshToken } from './auth.js';

function parseRetryAfterMs(header: string | null): number {
  if (!header) return 1000;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) {
    return Math.max(0, Math.min(seconds * 1000, 30000));
  }
  const dateMs = Date.parse(header);
  if (!isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return Math.max(0, Math.min(delta, 30000));
  }
  return 1000;
}

/**
 * Render a `Retry-After` header for a model-visible error message. The header
 * is vendor/proxy-controlled arbitrary printable text, so it is never
 * interpolated raw: only a non-negative integer is shown (bounded to 5
 * minutes), anything else falls back to static text.
 */
function describeRetryAfter(header: string | null): string {
  if (!header) return 'a moment';
  if (/^\d+$/.test(header.trim())) {
    const seconds = Math.min(parseInt(header.trim(), 10), 300);
    return `${seconds} seconds`;
  }
  return 'a moment';
}

/**
 * Parse a Zendesk JSON response body. The runtime's JSON parse error can
 * embed a fragment of the (vendor/proxy-controlled, potentially attacker
 * influenced) body; never let that propagate into model-visible output or
 * logs. Fail closed with a sanitised error instead.
 */
async function parseJsonResponse<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ZendeskError(
      `Zendesk API returned a response that could not be parsed (HTTP ${response.status})`,
      'API_ERROR',
      'Try again. If the problem persists, reconnect your Zendesk account in your MCP host app settings.'
    );
  }
}

export async function zendeskFetch<T>(
  account: ZendeskAccount,
  endpoint: string,
  options: ZendeskFetchOptions = {}
): Promise<T> {
  const { params, ...fetchOptions } = options;
  const method = (options.method ?? 'GET').toUpperCase();
  assertValidSubdomain(account.subdomain);

  let url = `https://${account.subdomain}.zendesk.com/api/v2${endpoint}`;
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

  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const authHeader = getAuthHeader(account);
    console.error(`[Zendesk API] Calling ${url} with subdomain=${account.subdomain}`);

    const response = await fetch(url, {
      ...fetchOptions,
      signal: fetchOptions.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...fetchOptions.headers,
      },
    });

    if (response.status === 429) {
      if (method !== 'GET' || attempt >= maxRetries) {
        const waitTime = describeRetryAfter(response.headers.get('Retry-After'));
        throw new ZendeskError(
          `Rate limited. Please wait ${waitTime} before retrying.`,
          'RATE_LIMITED',
          `Wait ${waitTime} and try again. Zendesk limits vary by plan (~400 req/min typical).`
        );
      }
      const waitMs = parseRetryAfterMs(response.headers.get('Retry-After'));
      const jitter = Math.floor(Math.random() * 500);
      console.error(`[Zendesk API] Rate limited, retrying in ${waitMs + jitter}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, waitMs + jitter));
      continue;
    }

    if (response.status === 401) {
      if (account.authType === 'api-token') {
        throw new ZendeskError(
          'Authentication failed',
          'AUTH_FAILED',
          'API token is invalid or revoked. Check your Zendesk API token and email, or reconnect in your MCP host app settings.'
        );
      }

      console.error(`[Zendesk API] 401 Unauthorized for ${url}, attempting token refresh`);
      const refreshed = await refreshToken(account.subdomain);
      if (refreshed) {
        const retryResponse = await fetch(url, {
          ...fetchOptions,
          signal: fetchOptions.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: getAuthHeader(account),
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...fetchOptions.headers,
          },
        });

        if (retryResponse.ok || retryResponse.status === 204) {
          if (retryResponse.status === 204) return {} as T;
          return parseJsonResponse<T>(retryResponse);
        }

        if (retryResponse.status === 401) {
          throw new ZendeskError(
            'Authentication failed after token refresh',
            'AUTH_FAILED',
            'OAuth token is invalid. Please reconnect your Zendesk account in your MCP host app settings.'
          );
        }

        // Do not read or log the raw vendor error body — it is
        // attacker/vendor-controlled and may contain echoed request data.
        console.error(`Zendesk API error after token refresh (HTTP ${retryResponse.status})`);

        if (retryResponse.status === 429) {
          const waitTime = describeRetryAfter(retryResponse.headers.get('Retry-After'));
          throw new ZendeskError(
            `Rate limited. Please wait ${waitTime} before retrying.`,
            'RATE_LIMITED',
            `Wait ${waitTime} and try again. Zendesk limits vary by plan (~400 req/min typical).`
          );
        }

        const postRefreshStatusMsg = retryResponse.status === 403 ? 'Forbidden - check permissions'
          : retryResponse.status === 422 ? 'Validation error - check request parameters'
          : retryResponse.status >= 500 ? 'Zendesk server error - try again later'
          : 'Request failed';
        throw new ZendeskError(
          `Zendesk API error (${retryResponse.status}): ${postRefreshStatusMsg}`,
          'API_ERROR',
          'Check the request parameters and try again.'
        );
      }

      throw new ZendeskError(
        'Authentication failed',
        'AUTH_FAILED',
        'OAuth token is expired or invalid. Please reconnect your Zendesk account in your MCP host app settings.'
      );
    }

    if (response.status === 404) {
      throw new ZendeskError(
        'Resource not found',
        'NOT_FOUND',
        'The requested resource does not exist or you do not have permission to access it.'
      );
    }

    if (!response.ok) {
      // Do not read or log the raw vendor error body — it is
      // attacker/vendor-controlled and may contain echoed request data.
      console.error(`Zendesk API error (HTTP ${response.status})`);
      const statusMessage = response.status === 403 ? 'Forbidden - check permissions'
        : response.status === 422 ? 'Validation error - check request parameters'
        : response.status >= 500 ? 'Zendesk server error - try again later'
        : 'Request failed';
      throw new ZendeskError(
        `Zendesk API error (${response.status}): ${statusMessage}`,
        'API_ERROR',
        'Check the request parameters and try again. If the problem persists, reconnect your Zendesk account in your MCP host app settings.'
      );
    }

    if (response.status === 204) return {} as T;
    return parseJsonResponse<T>(response);
  }

  throw new ZendeskError(
    'Rate limited. Maximum retries exhausted.',
    'RATE_LIMITED',
    'Zendesk API is rate limiting requests. Try again later.'
  );
}

export async function fetchAllTicketComments(
  account: ZendeskAccount,
  ticketId: number,
  options?: { maxComments?: number }
): Promise<{ comments: ZendeskComment[]; truncated: boolean }> {
  const maxComments = options?.maxComments ?? MAX_COMMENTS_PER_TICKET;
  const allComments: ZendeskComment[] = [];
  let page = 1;
  let hasMorePages = true;

  while (allComments.length < maxComments && hasMorePages) {
    const response = await zendeskFetch<{
      comments: ZendeskComment[];
      next_page: string | null;
      count: number;
    }>(account, `/tickets/${ticketId}/comments.json`, {
      params: { page: String(page), per_page: '100' },
    });
    allComments.push(...response.comments);
    hasMorePages = !!response.next_page;
    page++;
  }

  const overLimit = allComments.length > maxComments;
  const atLimitWithMore = allComments.length >= maxComments && hasMorePages;
  const truncated = overLimit || atLimitWithMore;
  return {
    comments: allComments.length > maxComments ? allComments.slice(0, maxComments) : allComments,
    truncated,
  };
}

export function noAccountError(): string {
  return JSON.stringify({
    ok: false,
    error: 'No Zendesk account connected',
    resolution: 'Use authenticate_zendesk_account or configure credentials via environment variables.',
  });
}
