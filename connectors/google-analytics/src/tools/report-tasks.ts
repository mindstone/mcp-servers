/**
 * Report task tools — asynchronous, long-running GA4 reports over the Data
 * API v1alpha `reportTasks` surface (not yet promoted to v1beta; alpha
 * endpoints can change without notice).
 *
 * Report tasks are the sanctioned way to pull large exports without hitting
 * synchronous request timeouts: ga_create_report_task starts the task,
 * ga_get_report_task polls until state is ACTIVE, and ga_query_report_task
 * pages rows with offset/limit (up to 250,000 rows per page).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { googleApi, propertyPath, Bases } from '../client.js';
import { filterExpressionSchema } from '../filters.js';
import { GoogleAnalyticsError, type DataApiResponse } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import {
  compactObject,
  formatRows,
  int64Field,
  parseApiResponse,
  parseOrderBy,
  toNameList,
  UNTRUSTED_SOURCES,
  withErrorHandling,
} from '../utils.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const CREATE_TASK = {
  readOnlyHint: false,
  // Starting a report task materialises up to `limit` rows server-side and
  // charges report-task quota tokens — a production-impacting, non-idempotent
  // operation, so it is annotated destructive (invariant #7).
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Runtime shape of a report task resource. Validated at the boundary
 * (fail-closed) instead of only TypeScript-cast; .passthrough() keeps the
 * alpha surface forward-compatible with new vendor fields.
 */
const reportTaskSchema = z
  .object({
    name: z.string().optional(),
    reportMetadata: z
      .object({
        state: z.string().optional(),
        taskRowCount: int64Field.optional(),
        totalRowCount: int64Field.optional(),
        beginCreatingTime: z.string().optional(),
        creationQuotaTokensCharged: int64Field.optional(),
        errorMessage: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type ReportTask = z.infer<typeof reportTaskSchema>;

/** Resolve `properties/<id>/reportTasks/<taskId>` from flexible input. */
function reportTaskPath(propertyId: string | undefined, taskId: string): string {
  const property = propertyPath(propertyId);
  const clean = String(taskId)
    .replace(/^properties\/[^/]+\/reportTasks\//, '')
    .replace(/^reportTasks\//, '');
  if (!clean) {
    throw new GoogleAnalyticsError(
      'Report task ID is required.',
      'REPORT_TASK_ID_REQUIRED',
      'Pass `task_id` as the bare task ID or the full resource name returned by ga_create_report_task.',
    );
  }
  return `${property}/reportTasks/${clean}`;
}

function mapReportTask(task: ReportTask) {
  return {
    name: task.name || null,
    state: task.reportMetadata?.state || null,
    taskRowCount: task.reportMetadata?.taskRowCount ?? null,
    totalRowCount: task.reportMetadata?.totalRowCount ?? null,
    beginCreatingTime: task.reportMetadata?.beginCreatingTime || null,
    creationQuotaTokensCharged: task.reportMetadata?.creationQuotaTokensCharged ?? null,
    // Vendor-authored failure detail — envelope before model output
    // (invariant #6).
    errorMessage:
      wrapUntrusted(task.reportMetadata?.errorMessage, UNTRUSTED_SOURCES.report) || null,
  };
}

const taskIdShape = {
  property_id: z
    .string()
    .optional()
    .describe('Optional GA4 property ID. Defaults to GA4_PROPERTY_ID.'),
  task_id: z
    .string()
    .describe(
      'Report task ID — bare ID or full resource name (properties/<id>/reportTasks/<taskId>), as returned by ga_create_report_task.',
    ),
};

const CreateReportTaskInputShape = {
  property_id: z
    .string()
    .optional()
    .describe('Optional GA4 property ID. Defaults to GA4_PROPERTY_ID.'),
  start_date: z
    .string()
    .default('7daysAgo')
    .describe('Start date, e.g. 7daysAgo or 2026-04-01.'),
  end_date: z.string().default('today').describe('End date, e.g. today or 2026-04-28.'),
  dimensions: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Dimension names (comma-separated string or array).'),
  metrics: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Metric names (comma-separated string or array).'),
  limit: z
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .default(10_000)
    .describe(
      'Total rows the task materialises from Analytics storage. Page through them with ga_query_report_task.',
    ),
  offset: z.number().int().nonnegative().optional(),
  order_by: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Order field, prefix with - for descending.'),
  dimension_filter: filterExpressionSchema
    .optional()
    .describe('GA4 dimensionFilter (FilterExpression object).'),
  metric_filter: filterExpressionSchema
    .optional()
    .describe('GA4 metricFilter (FilterExpression object).'),
  keep_empty_rows: z.boolean().optional(),
  currency_code: z.string().optional(),
};

const QueryReportTaskInputShape = {
  ...taskIdShape,
  offset: z.number().int().nonnegative().default(0),
  limit: z
    .number()
    .int()
    .positive()
    .max(250_000)
    .default(10_000)
    .describe('Rows per page. The API caps a single page at 250,000 rows.'),
};

export function registerReportTaskTools(server: McpServer): void {
  server.registerTool(
    'ga_create_report_task',
    {
      description:
        'Start an asynchronous report task for a large GA4 export. Unlike ga_run_report this has no synchronous timeout and no row-volume warning gate — the task materialises up to `limit` rows server-side. Poll ga_get_report_task until state is ACTIVE, then page rows with ga_query_report_task. Uses the v1alpha Data API; structure may evolve over time.',
      inputSchema: CreateReportTaskInputShape,
      annotations: CREATE_TASK,
    },
    withErrorHandling(async (rawArgs) => {
      const args = z.object(CreateReportTaskInputShape).parse(rawArgs ?? {});
      const dimensions = toNameList(args.dimensions);
      const metrics = toNameList(args.metrics);
      const metricList = metrics.length ? metrics : ['totalUsers', 'sessions'];
      const orderBys = parseOrderBy(args.order_by, dimensions, metricList);
      const property = propertyPath(args.property_id);

      const response = parseApiResponse(
        reportTaskSchema,
        await googleApi(`/${property}/reportTasks`, {
          method: 'POST',
          body: {
            reportDefinition: compactObject({
              dateRanges: [{ startDate: args.start_date, endDate: args.end_date }],
              dimensions: dimensions.map((name) => ({ name })),
              metrics: metricList.map((name) => ({ name })),
              limit: String(args.limit),
              offset: args.offset !== undefined ? String(args.offset) : undefined,
              orderBys: orderBys.length ? orderBys : undefined,
              dimensionFilter: args.dimension_filter,
              metricFilter: args.metric_filter,
              keepEmptyRows: args.keep_empty_rows,
              currencyCode: args.currency_code,
            }),
          },
          baseUrl: Bases.dataAlpha,
        }),
        'reportTasks.create',
      );
      return JSON.stringify({ ok: true, property, reportTask: mapReportTask(response) });
    }),
  );

  server.registerTool(
    'ga_get_report_task',
    {
      description:
        'Get the metadata and state of a report task. Poll this after ga_create_report_task until state is ACTIVE before querying rows. Uses the v1alpha Data API.',
      inputSchema: z.object(taskIdShape),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const name = reportTaskPath(args.property_id, args.task_id);
      const response = parseApiResponse(
        reportTaskSchema,
        await googleApi(`/${name}`, { baseUrl: Bases.dataAlpha }),
        'reportTasks.get',
      );
      return JSON.stringify({
        ok: true,
        property: name.split('/reportTasks/')[0],
        reportTask: mapReportTask(response),
      });
    }),
  );

  server.registerTool(
    'ga_query_report_task',
    {
      description:
        'Retrieve rows from an ACTIVE report task with offset/limit pagination (up to 250,000 rows per page). The task must be ACTIVE; poll ga_get_report_task first. Uses the v1alpha Data API.',
      inputSchema: QueryReportTaskInputShape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (rawArgs) => {
      const args = z.object(QueryReportTaskInputShape).parse(rawArgs ?? {});
      const name = reportTaskPath(args.property_id, args.task_id);
      const response = await googleApi<DataApiResponse>(`/${name}:query`, {
        method: 'POST',
        body: { offset: String(args.offset), limit: String(args.limit) },
        baseUrl: Bases.dataAlpha,
      });
      return JSON.stringify({
        ok: true,
        reportTask: name,
        offset: args.offset,
        limit: args.limit,
        ...formatRows(response),
      });
    }),
  );
}
