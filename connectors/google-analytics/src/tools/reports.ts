/**
 * Reporting tools — runReport, runPivotReport, batchRunReports,
 * runRealtimeReport, getPropertyQuotasSnapshot.
 *
 * runReport / batchRunReports add a row-volume safety net: estimate the
 * row count first, return a warning above the threshold, and only fetch
 * the full result on explicit opt-in or when aggregation can be applied.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { googleApi, propertyPath, Bases } from '../client.js';
import { DEFAULT_ROW_WARNING_THRESHOLD, type DataApiResponse } from '../types.js';
import {
  compactObject,
  dimensionOrderBy,
  formatRows,
  parseOrderBy,
  toNameList,
  UNTRUSTED_SOURCES,
  withErrorHandling,
} from '../utils.js';
import { wrapUntrustedJsonStrings } from '../untrusted-content.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const RunReportInputShape = {
  property_id: z
    .string()
    .optional()
    .describe('Optional GA4 property ID. Defaults to GA4_PROPERTY_ID.'),
  start_date: z
    .string()
    .default('7daysAgo')
    .describe('Start date, e.g. 7daysAgo or 2026-04-01.'),
  end_date: z
    .string()
    .default('today')
    .describe('End date, e.g. today or 2026-04-28.'),
  dimensions: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Dimension names (comma-separated string or array).'),
  metrics: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Metric names (comma-separated string or array).'),
  limit: z.number().int().positive().max(100_000).default(100),
  offset: z.number().int().nonnegative().optional(),
  order_by: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Order field, prefix with - for descending.'),
  dimension_filter: z.any().optional().describe('Raw GA4 dimensionFilter object.'),
  metric_filter: z.any().optional().describe('Raw GA4 metricFilter object.'),
  keep_empty_rows: z.boolean().optional(),
  return_property_quota: z.boolean().optional(),
  include_totals: z.boolean().optional(),
  include_maximums: z.boolean().optional(),
  include_minimums: z.boolean().optional(),
  currency_code: z.string().optional(),
  enable_aggregation: z.boolean().default(true),
  estimate_only: z.boolean().default(false),
  proceed_with_large_dataset: z.boolean().default(false),
  row_warning_threshold: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_ROW_WARNING_THRESHOLD),
};

const RunReportInput = z.object(RunReportInputShape);
type RunReportArgs = z.infer<typeof RunReportInput>;

const RealtimeInputShape = {
  property_id: z.string().optional(),
  dimensions: z.union([z.string(), z.array(z.string())]).optional(),
  metrics: z.union([z.string(), z.array(z.string())]).optional(),
  limit: z.number().int().positive().max(100_000).default(25),
  minute_ranges: z
    .array(
      z.object({
        startMinutesAgo: z.number().int().nonnegative(),
        endMinutesAgo: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  dimension_filter: z.any().optional(),
  metric_filter: z.any().optional(),
  return_property_quota: z.boolean().optional(),
};

const PivotInputShape = {
  property_id: z.string().optional(),
  start_date: z.string().default('7daysAgo'),
  end_date: z.string().default('today'),
  dimensions: z.union([z.string(), z.array(z.string())]),
  metrics: z.union([z.string(), z.array(z.string())]),
  pivots: z
    .array(
      z.object({
        field_names: z.array(z.string()).min(1),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        order_bys: z.array(z.string()).optional(),
      }),
    )
    .min(1),
  dimension_filter: z.any().optional(),
  metric_filter: z.any().optional(),
  keep_empty_rows: z.boolean().optional(),
  return_property_quota: z.boolean().optional(),
};

const BatchRunReportsInputShape = {
  property_id: z.string().optional(),
  reports: z.array(z.object(RunReportInputShape).omit({ property_id: true })).min(1).max(5),
};

async function estimateRowsForReport(
  property: string,
  request: Record<string, unknown>,
): Promise<number> {
  const sampleRequest = {
    ...request,
    limit: '1',
    returnPropertyQuota: false,
  };
  const response = await googleApi<DataApiResponse>(`/${property}:runReport`, {
    method: 'POST',
    body: sampleRequest,
    baseUrl: Bases.data,
  });
  return response.rowCount ?? 0;
}

function buildAggregationSuggestion(dimensions: string[]): string {
  const set = new Set(dimensions);
  if (set.has('date')) return 'Replace date with month or week for a smaller summary.';
  if (set.has('dateHour'))
    return 'Replace dateHour with date or week to reduce row count.';
  if (set.has('pagePath'))
    return 'Add a limit and sort by sessions or views to focus on the most important pages.';
  return 'Reduce the date range, remove a high-cardinality dimension, or lower the limit.';
}

async function buildAndRunReport(args: RunReportArgs) {
  const dimensions = toNameList(args.dimensions);
  const metrics = toNameList(args.metrics);
  const metricList = metrics.length ? metrics : ['totalUsers', 'sessions'];

  const request = compactObject({
    dateRanges: [{ startDate: args.start_date, endDate: args.end_date }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metricList.map((name) => ({ name })),
    limit: String(args.limit),
    offset: args.offset !== undefined ? String(args.offset) : undefined,
    orderBys: (() => {
      const explicit = parseOrderBy(args.order_by, dimensions, metricList);
      if (explicit.length) return explicit;
      if (dimensions.includes('date')) return [dimensionOrderBy('date', true)];
      return undefined;
    })(),
    dimensionFilter: args.dimension_filter,
    metricFilter: args.metric_filter,
    keepEmptyRows: args.keep_empty_rows,
    returnPropertyQuota: args.return_property_quota,
    metricAggregations:
      args.include_totals || args.include_maximums || args.include_minimums
        ? [
            ...(args.include_totals ? ['TOTAL'] : []),
            ...(args.include_maximums ? ['MAXIMUM'] : []),
            ...(args.include_minimums ? ['MINIMUM'] : []),
          ]
        : undefined,
    currencyCode: args.currency_code,
  });

  const property = propertyPath(args.property_id);
  const estimatedRows = await estimateRowsForReport(property, request);
  const aggregationSuggested =
    args.enable_aggregation && estimatedRows > args.row_warning_threshold;

  if (args.estimate_only) {
    return {
      property,
      estimatedRows,
      warning: estimatedRows > args.row_warning_threshold,
      suggestions:
        estimatedRows > args.row_warning_threshold
          ? [
              buildAggregationSuggestion(dimensions),
              'Set proceed_with_large_dataset to true if you really want the full dataset.',
            ]
          : [],
    };
  }

  if (estimatedRows > args.row_warning_threshold && !args.proceed_with_large_dataset) {
    return {
      property,
      warning: true,
      estimatedRows,
      rowWarningThreshold: args.row_warning_threshold,
      suggestions: [
        buildAggregationSuggestion(dimensions),
        'Use estimate_only to inspect row count without fetching rows.',
        'Set proceed_with_large_dataset to true if you want the full result anyway.',
      ],
    };
  }

  const finalRequest: Record<string, unknown> = { ...request };
  if (
    aggregationSuggested &&
    dimensions.includes('date') &&
    !dimensions.includes('month')
  ) {
    finalRequest.dimensions = dimensions.map((name) => ({
      name: name === 'date' ? 'month' : name,
    }));
  }

  const response = await googleApi<DataApiResponse>(`/${property}:runReport`, {
    method: 'POST',
    body: finalRequest,
    baseUrl: Bases.data,
  });

  return {
    property,
    startDate: args.start_date,
    endDate: args.end_date,
    estimatedRows,
    aggregationApplied:
      aggregationSuggested &&
      JSON.stringify(finalRequest.dimensions) !== JSON.stringify(request.dimensions),
    ...formatRows(response),
    propertyQuota: response.propertyQuota || undefined,
  };
}

export function registerReportTools(server: McpServer): void {
  server.registerTool(
    'ga_run_report',
    {
      description:
        'Run a GA4 report with configurable dimensions, metrics, date range, ordering, and safe dataset controls. Estimates row count first; returns a warning above row_warning_threshold (default 2500). Use ga_search_schema to discover dimension/metric apiNames.',
      inputSchema: RunReportInputShape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (rawArgs) => {
      const args = RunReportInput.parse(rawArgs ?? {});
      const result = await buildAndRunReport(args);
      return JSON.stringify({ ok: true, ...result });
    }),
  );

  server.registerTool(
    'ga_run_pivot_report',
    {
      description:
        'Run a GA4 pivot report. Pivots are useful for cross-tabulating dimensions (e.g. country x device).',
      inputSchema: PivotInputShape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (rawArgs) => {
      const args = z.object(PivotInputShape).parse(rawArgs ?? {});
      const dimensions = toNameList(args.dimensions);
      const metrics = toNameList(args.metrics);
      const property = propertyPath(args.property_id);

      const response = await googleApi<DataApiResponse>(`/${property}:runPivotReport`, {
        method: 'POST',
        body: compactObject({
          dateRanges: [{ startDate: args.start_date, endDate: args.end_date }],
          dimensions: dimensions.map((name) => ({ name })),
          metrics: metrics.map((name) => ({ name })),
          pivots: args.pivots.map((pivot) =>
            compactObject({
              fieldNames: pivot.field_names,
              limit: pivot.limit !== undefined ? String(pivot.limit) : undefined,
              offset: pivot.offset !== undefined ? String(pivot.offset) : undefined,
              orderBys: parseOrderBy(pivot.order_bys, dimensions, metrics),
            }),
          ),
          dimensionFilter: args.dimension_filter,
          metricFilter: args.metric_filter,
          keepEmptyRows: args.keep_empty_rows,
          returnPropertyQuota: args.return_property_quota,
        }),
        baseUrl: Bases.data,
      });

      return JSON.stringify({
        ok: true,
        property,
        startDate: args.start_date,
        endDate: args.end_date,
        // Vendor-echoed pivot header blob (dimension names/values) — enveloped
        // wholesale rather than field-enumerated (invariant #6).
        pivots: wrapUntrustedJsonStrings(response.pivotHeaders || [], UNTRUSTED_SOURCES.report),
        ...formatRows(response),
        propertyQuota: response.propertyQuota || undefined,
      });
    }),
  );

  server.registerTool(
    'ga_batch_run_reports',
    {
      description:
        'Run multiple GA4 reports (max 5) in a single batch request. Each report shares the row-volume safety net of ga_run_report.',
      inputSchema: BatchRunReportsInputShape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (rawArgs) => {
      const args = z.object(BatchRunReportsInputShape).parse(rawArgs ?? {});
      const property = propertyPath(args.property_id);
      const results = await Promise.all(
        args.reports.map((report, index) =>
          buildAndRunReport({ ...report, property_id: args.property_id }).then(
            (result) => ({ index, ...result }),
          ),
        ),
      );
      return JSON.stringify({ ok: true, property, reports: results });
    }),
  );

  server.registerTool(
    'ga_run_realtime_report',
    {
      description:
        'Run a GA4 realtime report with configurable dimensions and metrics. Realtime data covers the last 30 minutes by default.',
      inputSchema: RealtimeInputShape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (rawArgs) => {
      const args = z.object(RealtimeInputShape).parse(rawArgs ?? {});
      const dimensions = toNameList(args.dimensions);
      const metrics = toNameList(args.metrics);
      const metricList = metrics.length ? metrics : ['activeUsers'];
      const property = propertyPath(args.property_id);

      const response = await googleApi<DataApiResponse>(
        `/${property}:runRealtimeReport`,
        {
          method: 'POST',
          body: compactObject({
            dimensions: dimensions.map((name) => ({ name })),
            metrics: metricList.map((name) => ({ name })),
            limit: String(args.limit),
            minuteRanges: args.minute_ranges,
            dimensionFilter: args.dimension_filter,
            metricFilter: args.metric_filter,
            returnPropertyQuota: args.return_property_quota,
          }),
          baseUrl: Bases.data,
        },
      );

      return JSON.stringify({
        ok: true,
        property,
        ...formatRows(response),
        propertyQuota: response.propertyQuota || undefined,
      });
    }),
  );

  server.registerTool(
    'ga_get_property_quotas_snapshot',
    {
      description:
        'Return a fresh property quota snapshot using a lightweight GA4 report call. Use this to check remaining tokens / requests before kicking off a large batch.',
      inputSchema: z.object({ property_id: z.string().optional() }),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const response = await googleApi<DataApiResponse>(`/${property}:runReport`, {
        method: 'POST',
        body: {
          dateRanges: [{ startDate: 'today', endDate: 'today' }],
          metrics: [{ name: 'activeUsers' }],
          limit: '1',
          returnPropertyQuota: true,
        },
        baseUrl: Bases.data,
      });
      return JSON.stringify({
        ok: true,
        property,
        propertyQuota: response.propertyQuota || null,
      });
    }),
  );
}
