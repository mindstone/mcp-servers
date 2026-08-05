/**
 * Shared types and constants for the Google Analytics MCP server.
 */

export const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

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

/** Response shape from the Data API runReport / runPivotReport / runRealtimeReport calls. */
export interface DataApiResponse {
  rowCount?: number;
  dimensionHeaders?: Array<{ name: string }>;
  metricHeaders?: Array<{ name: string }>;
  rows?: Array<{
    dimensionValues?: Array<{ value: string }>;
    metricValues?: Array<{ value: string }>;
  }>;
  totals?: Array<{ metricValues?: Array<{ value: string }> }>;
  maximums?: Array<{ metricValues?: Array<{ value: string }> }>;
  minimums?: Array<{ metricValues?: Array<{ value: string }> }>;
  pivotHeaders?: unknown[];
  propertyQuota?: unknown;
}
