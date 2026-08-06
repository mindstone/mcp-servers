import { z } from 'zod';
import {
  ConnectorError,
  MAX_VENDOR_ERROR_CHARS,
  OUTREACH_API_BASE,
  REQUEST_TIMEOUT_MS,
  type JsonApiResponse,
  type JsonApiResource,
} from './types.js';
import { getActiveToken, refreshTokenIfNeeded, getAuthMode } from './auth.js';
import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

// JSON:API envelope validation for every external response (repo convention:
// validate external responses with Zod instead of casting). Attribute values
// stay `unknown` — they are resource-specific and handled by formatResource —
// but the envelope structure the tools rely on is checked before use.
const jsonApiResourceSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    attributes: z.record(z.unknown()).optional(),
    relationships: z
      .record(
        z
          .object({
            data: z
              .union([
                z.object({ id: z.string(), type: z.string() }).passthrough(),
                z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
                z.null(),
              ])
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    links: z.record(z.unknown()).optional(),
  })
  .passthrough();

const jsonApiResponseSchema = z
  .object({
    data: z.union([jsonApiResourceSchema, z.array(jsonApiResourceSchema)]),
    meta: z
      .object({
        count: z.number().optional(),
        page: z
          .object({ current: z.number().optional(), total: z.number().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    links: z.record(z.unknown()).optional(),
  })
  .passthrough();

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

      // Vendor-authored error text (JSON error details or a raw non-JSON body)
      // is external content: bound it and wrap it in an untrusted-content
      // envelope (AGENTS.md invariant #6) before it reaches model context via
      // the error message. getErrorResolution keeps the raw detail — its
      // keyword matching stays internal and its output is fixed strings.
      const boundedDetail = (detail || response.statusText).slice(0, MAX_VENDOR_ERROR_CHARS);
      const envelopedDetail =
        wrapUntrusted(boundedDetail, 'outreach:api-error') ?? 'Unknown error';
      throw new ConnectorError(
        `Outreach API error (HTTP ${response.status}): ${envelopedDetail}`,
        `HTTP_${response.status}`,
        getErrorResolution(response.status, detail),
      );
    }

    if (response.status === 204) {
      return { data: [] } as unknown as JsonApiResponse;
    }

    const parsed = jsonApiResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ConnectorError(
        'Outreach API returned an unexpected response shape',
        'INVALID_RESPONSE',
        'The API response did not match the expected JSON:API structure. Try again; if it persists, reconnect with outreach_connect_account.',
      );
    }
    return parsed.data as JsonApiResponse;
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

/**
 * String-valued attribute keys whose values are vendor-generated structure
 * (timestamps, lifecycle enums) rather than user-authored prose. Everything
 * else is treated as external text and enveloped per AGENTS.md security
 * invariant #6 — fail-closed, so prospect custom fields (`custom1..custom35`)
 * and any attribute Outreach adds later are enveloped by default.
 */
const STRUCTURAL_ATTRIBUTES = new Set([
  'addedAt',
  'answeredAt',
  'bouncedAt',
  'clickedAt',
  'completedAt',
  'createdAt',
  'deliveredAt',
  'dueAt',
  'engagedAt',
  'finishedAt',
  'lastContactedAt',
  'lastEngagedAt',
  'openedAt',
  'pausedAt',
  'repliedAt',
  'scheduledAt',
  'stateChangedAt',
  'touchedAt',
  'updatedAt',
  'action',
  'direction',
  'outcome',
  'sequenceType',
  'state',
  'status',
  'stepType',
  'taskType',
]);

export function formatResource(resource: JsonApiResource): Record<string, unknown> {
  const result: Record<string, unknown> = { id: resource.id, type: resource.type };
  if (resource.attributes) {
    for (const [key, value] of Object.entries(resource.attributes)) {
      result[key] = STRUCTURAL_ATTRIBUTES.has(key)
        ? value
        : wrapUntrustedJsonStrings(value, `outreach:${resource.type}:${key}`);
    }
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
