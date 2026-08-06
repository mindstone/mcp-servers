import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodError } from 'zod';
import { GoogleAnalyticsError, type DataApiResponse } from './types.js';
import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

/** Envelope source labels used across the connector. */
export const UNTRUSTED_SOURCES = {
  report: 'ga4-report',
  admin: 'ga4-admin',
  metadata: 'ga4-metadata',
  audienceExport: 'ga4-audience-export',
  apiError: 'ga4-api-error',
} as const;

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Wraps a tool handler with standard error handling.
 * Returns structured JSON errors with code + resolution. Maps known Google
 * API auth errors to friendly user-facing messages.
 */
export function withErrorHandling<T>(
  fn: (args: T, extra: unknown) => Promise<string>,
): ToolHandler<T> {
  return async (args, extra) => {
    try {
      const result = await fn(args, extra);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      if (error instanceof GoogleAnalyticsError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: error.message,
                code: error.code,
                resolution: error.resolution,
              }),
            },
          ],
          isError: true,
        };
      }
      if (error instanceof ZodError) {
        // Connector-generated validation detail (never vendor text) — safe to
        // surface so the caller can correct the arguments.
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: 'Invalid tool arguments.',
                code: 'INVALID_ARGUMENTS',
                issues: error.issues,
              }),
            },
          ],
          isError: true,
        };
      }
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Map common google-auth-library errors to friendly messages.
      const friendly = mapAuthError(errorMessage);
      if (friendly) {
        return {
          content: [{ type: 'text', text: JSON.stringify(friendly) }],
          isError: true,
        };
      }

      // Unexpected runtime errors can embed credential details, file paths, or
      // vendor/proxy-controlled fragments from deep library stacks. Log the
      // detail to server stderr (not model-visible) and return a sanitised
      // message instead of the raw error text.
      console.error('[google-analytics] Unexpected error:', error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'An unexpected error occurred while calling the Google Analytics API.',
              code: 'UNEXPECTED_ERROR',
              resolution:
                'Try again. If the problem persists, check the MCP host server logs for the underlying error detail.',
            }),
          },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Map known auth/credential error strings into structured user-facing
 * resolutions. Keeps non-technical users out of the deep end of gcloud
 * error chains.
 */
function mapAuthError(
  message: string,
): { ok: false; error: string; code: string; resolution: string } | null {
  if (/invalid_grant|reauth|expired/i.test(message)) {
    return {
      ok: false,
      error: 'Your Google credentials have expired or been revoked.',
      code: 'CREDENTIALS_EXPIRED',
      resolution:
        'Re-run `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/cloud-platform --client-id-file=/path/to/your/oauth-client.json` and reconnect this connector in your MCP host.',
    };
  }
  if (/ENOENT|no such file/i.test(message)) {
    return {
      ok: false,
      error: 'The credentials file pointed to by GOOGLE_APPLICATION_CREDENTIALS does not exist.',
      code: 'CREDENTIALS_FILE_MISSING',
      resolution:
        'Verify that GOOGLE_APPLICATION_CREDENTIALS holds the absolute path to your ADC or service-account JSON. Node does not expand ~ or %APPDATA% — provide a fully-resolved absolute path.',
    };
  }
  if (/PERMISSION_DENIED|insufficient.*permission|forbidden/i.test(message)) {
    return {
      ok: false,
      error: 'The credential does not have access to this Google Analytics resource.',
      code: 'PERMISSION_DENIED',
      resolution:
        'Ensure the Google account or service account behind your credentials has access to the GA4 property and that the Google Analytics Admin and Data APIs are enabled in the Google Cloud project attached to the credential.',
    };
  }
  return null;
}

/** Normalise a value to an array of trimmed, non-empty strings. */
export function toNameList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value))
    return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Google returns int64 fields as either JSON numbers or strings depending on
 * the surface — accept both and pass the value through unchanged.
 */
export const int64Field = z.union([z.string(), z.number()]);

/**
 * Validate an external API response body against a Zod schema. Google API
 * responses are otherwise only TypeScript-cast; a shape mismatch must fail
 * closed with a structured error rather than propagate garbage downstream.
 * Schemas use .passthrough() so new vendor fields stay forward-compatible.
 */
export function parseApiResponse<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new GoogleAnalyticsError(
      `Google API returned an unexpected response shape for ${context}.`,
      'INVALID_API_RESPONSE',
      'Try again. If the problem persists, the API response format may have changed — check for a connector update.',
    );
  }
  return result.data;
}

/** Strip undefined values so the request body stays compact. */
export function compactObject<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** Build an order-by clause that targets a metric. */
export function metricOrderBy(name: string, desc: boolean) {
  return { metric: { metricName: name }, desc };
}

/** Build an order-by clause that targets a dimension. */
export function dimensionOrderBy(name: string, desc: boolean) {
  return { dimension: { dimensionName: name }, desc };
}

/**
 * Parse "dim1,dim2,-metric1" or array equivalents into Data API order-by
 * clauses. A leading `-` indicates descending sort.
 */
export function parseOrderBy(
  value: string | string[] | undefined,
  dimensions: string[],
  metrics: string[],
): Array<ReturnType<typeof metricOrderBy> | ReturnType<typeof dimensionOrderBy>> {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => {
    const raw = String(entry).trim();
    const desc = raw.startsWith('-');
    const name = raw.replace(/^-/, '');
    if (metrics.includes(name)) return metricOrderBy(name, desc);
    return dimensionOrderBy(name, desc);
  });
}

/** Format Data API rows into a flat per-row object map. */
export function formatRows(response: DataApiResponse) {
  // Header names are vendor-echoed strings (custom dimension/metric names are
  // authored by property editors) and become structural keys in the output —
  // envelope them the same way the recursive helper envelopes object keys
  // (invariant #6).
  const dimensionHeaders = (response.dimensionHeaders || []).map(
    (h) => wrapUntrusted(h.name, UNTRUSTED_SOURCES.report) ?? 'unknown',
  );
  const metricHeaders = (response.metricHeaders || []).map(
    (h) => wrapUntrusted(h.name, UNTRUSTED_SOURCES.report) ?? 'unknown',
  );

  const rows = (response.rows || []).map((row) => {
    const item: Record<string, string | null> = {};
    dimensionHeaders.forEach((header, index) => {
      // Dimension values (page titles, campaign names, custom-dimension
      // values) are authored or influenced outside Google's control and
      // rendered to the model — envelope them (invariant #6). Metric values
      // are numeric strings and stay raw.
      item[header] =
        wrapUntrusted(row.dimensionValues?.[index]?.value, UNTRUSTED_SOURCES.report) ?? null;
    });
    metricHeaders.forEach((header, index) => {
      item[header] = row.metricValues?.[index]?.value ?? null;
    });
    return item;
  });

  const mapAggregate = (entries: Array<{ metricValues?: Array<{ value?: string }> }>) =>
    entries.map((entry) => {
      const item: Record<string, string | null> = {};
      metricHeaders.forEach((header, index) => {
        item[header] = entry.metricValues?.[index]?.value ?? null;
      });
      return item;
    });

  return {
    rowCount: response.rowCount ?? rows.length,
    dimensionHeaders,
    metricHeaders,
    totals: mapAggregate(response.totals || []),
    maximums: mapAggregate(response.maximums || []),
    minimums: mapAggregate(response.minimums || []),
    rows,
  };
}

/** Strip the `properties/` or `customEvent:` prefix from an API name. */
export function normaliseApiName(value: unknown): string {
  return String(value || '')
    .replace(/^properties\/\d+\//, '')
    .replace(/^customEvent:/, '')
    .trim();
}

/** Best-effort categorisation for dimensions and metrics. */
export function categoriseField(
  field: { apiName?: string; uiName?: string; description?: string; category?: string },
  kind: 'dimension' | 'metric',
): string {
  const haystack = [
    field.apiName,
    field.uiName,
    field.description,
    ...(field.category ? [field.category] : []),
  ]
    .join(' ')
    .toLowerCase();

  const rules: Array<{ category: string; match: RegExp }> = [
    { category: 'Time', match: /(date|time|hour|minute|week|month|year|quarter|nth)/ },
    {
      category: 'Geography',
      match: /(country|city|region|continent|metro|subcontinent|territory)/,
    },
    {
      category: 'Technology',
      match: /(browser|device|platform|operating system|os |mobile|screen|app version|stream platform)/,
    },
    {
      category: 'Traffic Source',
      match: /(campaign|source|medium|channel group|google ads|ad group|keyword|session source|traffic)/,
    },
    {
      category: 'Content',
      match: /(page|screen|landing page|content|host name|page path|page title|hostname)/,
    },
    {
      category: 'E-commerce',
      match: /(item|product|purchase|revenue|refund|transaction|cart|checkout|shipping|tax|promotion)/,
    },
    {
      category: 'Events',
      match: /(event|key event|conversion|session key event rate|user key event rate)/,
    },
    {
      category: 'User Demographics',
      match: /(user|new users|active users|age|gender|language|interest|audience)/,
    },
    {
      category: 'Engagement',
      match: /(engage|bounce|session duration|stickiness|views per session|wau|mau|dau)/,
    },
    {
      category: 'Advertising',
      match: /(ad revenue|return on ad spend|publisher|ad unit|impression)/,
    },
    { category: 'Cohorts', match: /(cohort)/ },
    { category: 'Custom', match: /(custom)/ },
  ];

  const found = rules.find((rule) => rule.match.test(haystack));
  if (found) return found.category;
  return kind === 'metric' ? 'Other Metrics' : 'Other Dimensions';
}

/**
 * Runtime shape of a Data-API metadata field. Validated at the boundary
 * (fail-closed) instead of only TypeScript-cast; .passthrough() keeps the
 * surface forward-compatible with new vendor fields.
 */
export const metadataFieldSchema = z
  .object({
    apiName: z.string().optional(),
    uiName: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    type: z.string().optional(),
    expression: z.string().optional(),
    customDefinition: z.boolean().optional(),
    deprecatedApiNames: z.array(z.string()).optional(),
    allowedInSegments: z.boolean().optional(),
    dimensionCompatibleMetrics: z.array(z.string()).optional(),
    metricCompatibleDimensions: z.array(z.string()).optional(),
  })
  .passthrough();

type MetadataField = z.infer<typeof metadataFieldSchema>;

/** Map a raw Data-API metadata field into a cleaner shape. */
export function mapMetadataField(field: MetadataField, kind: 'dimension' | 'metric') {
  // Standard dimension/metric uiName/description are Google-authored
  // documentation. Custom definitions are authored by property editors, so
  // only those are enveloped (invariant #6).
  const userAuthored = field.customDefinition === true;
  return {
    apiName: field.apiName || null,
    uiName: userAuthored
      ? wrapUntrusted(field.uiName, UNTRUSTED_SOURCES.metadata) ?? null
      : field.uiName || null,
    description: userAuthored
      ? wrapUntrusted(field.description, UNTRUSTED_SOURCES.metadata) ?? null
      : field.description || null,
    category: categoriseField(field, kind),
    type: field.type || null,
    // The expression of a custom calculated metric is property-editor-authored
    // — envelope it under the same gate as uiName/description (invariant #6).
    expression: userAuthored
      ? wrapUntrusted(field.expression, UNTRUSTED_SOURCES.metadata) ?? null
      : field.expression || null,
    customDefinition: field.customDefinition || false,
    deprecatedApiNames: field.deprecatedApiNames || [],
    allowedInSegments: field.allowedInSegments || false,
    // Vendor-echoed field-name lists — envelope before model output
    // (invariant #6).
    dimensionCompatibleMetrics: field.dimensionCompatibleMetrics
      ? wrapUntrustedJsonStrings(field.dimensionCompatibleMetrics, UNTRUSTED_SOURCES.metadata)
      : undefined,
    metricCompatibleDimensions: field.metricCompatibleDimensions
      ? wrapUntrustedJsonStrings(field.metricCompatibleDimensions, UNTRUSTED_SOURCES.metadata)
      : undefined,
  };
}
