/**
 * Shared types and constants for the Google Analytics MCP server.
 */

import { z } from 'zod';

export const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

/** Scope required by the Admin API write tools. */
export const ANALYTICS_EDIT_SCOPE = 'https://www.googleapis.com/auth/analytics.edit';

/** Env var that opts the connector into Admin API writes (invariant #7). */
export const WRITES_ENV_VAR = 'GA4_ALLOW_WRITES';

/**
 * Writes are off unless the operator explicitly opts in. Read at call time so
 * the flag cannot be latched by an earlier import.
 */
export function writesEnabled(): boolean {
  const value = process.env[WRITES_ENV_VAR]?.trim().toLowerCase();
  return value === 'true' || value === '1';
}

/** The scope the connector requests: edit only when writes are enabled. */
export function activeScope(): string {
  return writesEnabled() ? ANALYTICS_EDIT_SCOPE : ANALYTICS_SCOPE;
}

/** gcloud command that mints ADC with the scope the connector needs. */
export function adcLoginCommand(): string {
  return `gcloud auth application-default login --scopes=${activeScope()} --client-id-file=/path/to/your/oauth-client.json`;
}

/** Default base URL for the GA Admin API. v1beta is generally available. */
export const ADMIN_BASE_URL = 'https://analyticsadmin.googleapis.com/v1beta';

/**
 * v1alpha base URL — only used for endpoints that are not yet promoted to
 * v1beta. Currently `searchChangeHistoryEvents`, `bigQueryLinks`,
 * `dataStreams.globalSiteTag`, `audiences`, and `channelGroups`. Keep this
 * surface narrow; alpha endpoints can change without notice.
 */
export const ADMIN_ALPHA_BASE_URL = 'https://analyticsadmin.googleapis.com/v1alpha';

/** Default base URL for the GA Data API. v1beta is generally available. */
export const DATA_BASE_URL = 'https://analyticsdata.googleapis.com/v1beta';

/**
 * v1alpha base URL for the GA Data API — only used for endpoints that are
 * not yet promoted to v1beta. Currently only `reportTasks`. Keep this
 * surface narrow; alpha endpoints can change without notice.
 */
export const DATA_ALPHA_BASE_URL = 'https://analyticsdata.googleapis.com/v1alpha';

/** Threshold above which run_report warns and asks for explicit opt-in. */
export const DEFAULT_ROW_WARNING_THRESHOLD = 2500;

/** User-Agent header sent on outbound Google API calls. */
export const USER_AGENT = 'mcp-server-google-analytics/0.1.0';

/** Default request timeout (ms) for outbound API calls. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class GoogleAnalyticsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'GoogleAnalyticsError';
  }
}

/**
 * Runtime shape of the Data API runReport / runPivotReport / runRealtimeReport
 * responses (and reportTasks:query, which returns the same row payload).
 * Validated at the boundary (fail-closed) instead of only TypeScript-cast;
 * .passthrough() keeps the surface forward-compatible with new vendor fields.
 * pivotHeaders / propertyQuota stay opaque: pivot headers are enveloped
 * wholesale downstream and quota snapshots are vendor-numeric structures.
 */
const dataApiHeaderSchema = z.object({ name: z.string().optional() }).passthrough();
const dataApiValueSchema = z.object({ value: z.string().optional() }).passthrough();

export const dataApiResponseSchema = z
  .object({
    rowCount: z.number().optional(),
    dimensionHeaders: z.array(dataApiHeaderSchema).optional(),
    metricHeaders: z.array(dataApiHeaderSchema).optional(),
    rows: z
      .array(
        z
          .object({
            dimensionValues: z.array(dataApiValueSchema).optional(),
            metricValues: z.array(dataApiValueSchema).optional(),
          })
          .passthrough(),
      )
      .optional(),
    totals: z
      .array(z.object({ metricValues: z.array(dataApiValueSchema).optional() }).passthrough())
      .optional(),
    maximums: z
      .array(z.object({ metricValues: z.array(dataApiValueSchema).optional() }).passthrough())
      .optional(),
    minimums: z
      .array(z.object({ metricValues: z.array(dataApiValueSchema).optional() }).passthrough())
      .optional(),
    pivotHeaders: z.array(z.unknown()).optional(),
    propertyQuota: z.unknown().optional(),
  })
  .passthrough();

export type DataApiResponse = z.infer<typeof dataApiResponseSchema>;
