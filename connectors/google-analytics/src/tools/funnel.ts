/**
 * Funnel report tool — Data API runFunnelReport (v1alpha).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Bases, googleApi, propertyPath } from '../client.js';
import { filterExpressionSchema } from '../filters.js';
import { dataApiResponseSchema, GoogleAnalyticsError } from '../types.js';
import { compactObject, formatRows, parseApiResponse, withErrorHandling } from '../utils.js';
import { READ_ONLY } from '../writes.js';

const funnelStepSchema = z.object({
  name: z.string().min(1).describe('Step label shown in the results, e.g. "Signed up".'),
  event_name: z
    .string()
    .optional()
    .describe('Shortcut: the step is reached when this event fires. Use filter_expression for anything richer.'),
  filter_expression: z
    .record(z.unknown())
    .optional()
    .describe('Raw FunnelFilterExpression, e.g. {"funnelEventFilter":{"eventName":"page_view","funnelParameterFilterExpression":{...}}}.'),
  is_directly_followed_by: z
    .boolean()
    .optional()
    .describe('Require this step to follow the previous one with no other events between.'),
  within_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Require this step within this many seconds of the previous step.'),
});

const funnelResponseSchema = z
  .object({
    funnelTable: dataApiResponseSchema.optional(),
    funnelVisualization: dataApiResponseSchema.optional(),
    propertyQuota: z.unknown().optional(),
  })
  .passthrough();

export function registerFunnelTools(server: McpServer): void {
  server.registerTool(
    'ga_run_funnel_report',
    {
      description:
        'Run a funnel report: how many users reach each step in order (e.g. landing page → sign_up → demo_booked), with completion and abandonment rates per step, optionally broken down by a dimension. Uses the v1alpha Data API.',
      inputSchema: {
        property_id: z.string().optional().describe('Optional GA4 property ID. Defaults to GA4_PROPERTY_ID.'),
        start_date: z.string().default('28daysAgo').describe('Start date, e.g. 28daysAgo or 2026-10-01.'),
        end_date: z.string().default('today'),
        steps: z.array(funnelStepSchema).min(2).max(10).describe('Funnel steps in order.'),
        is_open_funnel: z
          .boolean()
          .optional()
          .describe('Open funnel: users can enter at any step. Closed (default): users must start at step 1.'),
        breakdown_dimension: z
          .string()
          .optional()
          .describe('Dimension to split each step by, e.g. deviceCategory or sessionDefaultChannelGroup.'),
        breakdown_limit: z.number().int().positive().max(15).optional(),
        next_action_dimension: z
          .string()
          .optional()
          .describe('Show what users did next after each step: eventName or pageTitle.'),
        visualization: z
          .enum(['STANDARD_FUNNEL', 'TRENDED_FUNNEL'])
          .optional()
          .describe('TRENDED_FUNNEL adds a per-date series in funnelVisualization.'),
        dimension_filter: filterExpressionSchema.optional().describe('Limit the users considered (FilterExpression).'),
        limit: z.number().int().positive().max(250_000).optional(),
        return_property_quota: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const steps = args.steps.map((step, index) => {
        if (!step.event_name && !step.filter_expression) {
          throw new GoogleAnalyticsError(
            `Funnel step ${index + 1} ("${step.name}") needs event_name or filter_expression.`,
            'INVALID_ARGUMENTS',
            'Give each step the event that completes it, or a FunnelFilterExpression.',
          );
        }
        return compactObject({
          name: step.name,
          isDirectlyFollowedBy: step.is_directly_followed_by,
          withinDurationFromPriorStep: step.within_seconds ? `${step.within_seconds}s` : undefined,
          filterExpression: step.filter_expression ?? { funnelEventFilter: { eventName: step.event_name } },
        });
      });

      const body = compactObject({
        dateRanges: [{ startDate: args.start_date, endDate: args.end_date }],
        funnel: compactObject({ isOpenFunnel: args.is_open_funnel, steps }),
        funnelBreakdown: args.breakdown_dimension
          ? compactObject({ breakdownDimension: { name: args.breakdown_dimension }, limit: args.breakdown_limit })
          : undefined,
        funnelNextAction: args.next_action_dimension
          ? { nextActionDimension: { name: args.next_action_dimension } }
          : undefined,
        funnelVisualizationType: args.visualization,
        dimensionFilter: args.dimension_filter,
        limit: args.limit,
        returnPropertyQuota: args.return_property_quota,
      });

      const response = parseApiResponse(
        funnelResponseSchema,
        await googleApi(`/${property}:runFunnelReport`, {
          method: 'POST',
          body,
          baseUrl: Bases.dataAlpha,
        }),
        'runFunnelReport',
      );

      return JSON.stringify({
        ok: true,
        property,
        funnelTable: response.funnelTable ? formatRows(response.funnelTable) : null,
        funnelVisualization: response.funnelVisualization ? formatRows(response.funnelVisualization) : null,
        propertyQuota: response.propertyQuota ?? null,
      });
    }),
  );
}
