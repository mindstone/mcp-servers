import {
  ConnectorError,
  OUTREACH_API_BASE,
  REQUEST_TIMEOUT_MS,
  type JsonApiResponse,
  type JsonApiResource,
} from './types.js';
import { getActiveToken, refreshTokenIfNeeded, getAuthMode } from './auth.js';

function getErrorResolution(status: number, detail?: string): string {
  const msg = (detail || '').toLowerCase();
  if (status === 401 || msg.includes('unauthorized') || msg.includes('invalid')) {
    return 'Authentication failed. Call outreach_connect_account to reconnect.';
  }
  if (status === 403 || msg.includes('forbidden') || msg.includes('scope')) {
    return 'Access denied. Check that your OAuth scopes include the required permissions.';
  }
  if (status === 404) {
    return 'Resource not found. Verify the ID is correct.';
  }
  if (status === 422 || msg.includes('validation')) {
    return 'Invalid request parameters. Check the input values and try again.';
  }
  if (status === 429) {
    return 'Rate limited. Wait a moment and try again.';
  }
  return 'Please try again. If the issue persists, reconnect with outreach_connect_account.';
}

/**
 * Ensure the connector is in a mode that can make API calls.
 * Throws ConnectorError with setup guidance for unconfigured mode.
 */
export function requireAuth(): void {
  const mode = getAuthMode();
  if (mode === 'unconfigured') {
    throw new ConnectorError(
      'No Outreach authentication configured',
      'UNCONFIGURED',
      'Set up authentication: (1) Set OUTREACH_CLIENT_ID and OUTREACH_CLIENT_SECRET for OAuth, or (2) Set OUTREACH_ACCESS_TOKEN for manual token mode. See README for details.',
    );
  }
}

/**
 * Make an authenticated API call to the Outreach REST API.
 *
 * Bearer token auth, 30-second timeout, structured error handling.
 */
export async function outreachFetch(
  endpoint: string,
  options: { method?: string; body?: unknown; params?: Record<string, string> } = {},
): Promise<JsonApiResponse> {
  requireAuth();

  const { accountId, token: rawToken } = getActiveToken();
  const token = await refreshTokenIfNeeded(accountId, rawToken);

  let url = endpoint.startsWith('http') ? endpoint : `${OUTREACH_API_BASE}${endpoint}`;
  if (options.params) {
    const searchParams = new URLSearchParams(options.params);
    url += (url.includes('?') ? '&' : '?') + searchParams.toString();
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.access_token}`,
    'Content-Type': 'application/vnd.api+json',
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const fetchOptions: RequestInit = {
      method: options.method || 'GET',
      headers,
      signal: controller.signal,
    };
    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as Record<string, unknown>;
        const errors = errBody.errors as Array<{ detail?: string; title?: string }> | undefined;
        detail = errors?.[0]?.detail || errors?.[0]?.title || '';
      } catch {
        try {
          detail = await response.text();
        } catch {
          /* empty */
        }
      }

      throw new ConnectorError(
        `Outreach API error (HTTP ${response.status}): ${detail || response.statusText}`,
        `HTTP_${response.status}`,
        getErrorResolution(response.status, detail),
      );
    }

    if (response.status === 204) {
      return { data: [] } as unknown as JsonApiResponse;
    }

    return (await response.json()) as JsonApiResponse;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ConnectorError(
        'Request timed out after 30 seconds',
        'TIMEOUT',
        'The Outreach API took too long to respond. Try again.',
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// JSON:API Helpers
// ---------------------------------------------------------------------------

export function formatResource(resource: JsonApiResource): Record<string, unknown> {
  const result: Record<string, unknown> = { id: resource.id, type: resource.type };
  if (resource.attributes) {
    Object.assign(result, resource.attributes);
  }
  if (resource.relationships) {
    for (const [key, rel] of Object.entries(resource.relationships)) {
      if (rel.data) {
        if (Array.isArray(rel.data)) {
          result[`${key}_ids`] = rel.data.map((d) => d.id);
        } else {
          result[`${key}_id`] = rel.data.id;
        }
      }
    }
  }
  return result;
}

export function formatResources(data: JsonApiResource | JsonApiResource[]): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.map(formatResource);
  return [formatResource(data)];
}

/**
 * Clamp limit to valid range.
 */
export function clampLimit(limit?: number, defaultVal = 25): number {
  return Math.min(Math.max(1, limit ?? defaultVal), 50);
}

/**
 * Build pagination query params.
 */
export function paginationParams(limit: number, offset?: number): Record<string, string> {
  const params: Record<string, string> = { 'page[size]': String(limit) };
  if (offset && offset > 0) params['page[offset]'] = String(offset);
  return params;
}
