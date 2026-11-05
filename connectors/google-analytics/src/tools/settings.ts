/**
 * Reporting-behaviour tools: annotations, attribution, calculated metrics,
 * event edit rules, Google Signals, and data sharing. Reads are always
 * available; writes are gated by GA4_ALLOW_WRITES (see ../writes.ts).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { accountPath, propertyPath } from '../client.js';
import { GoogleAnalyticsError } from '../types.js';
import { withErrorHandling } from '../utils.js';
import {
  adminGet,
  adminList,
  adminWrite,
  buildPatch,
  confirmArg,
  dataStreamPath,
  jsonObject,
  optionalPropertyIdArg,
  propertyChildPath,
  propertyIdArg,
  READ_ONLY,
  streamChildPath,
  WRITE,
  WRITE_NOTE,
} from '../writes.js';

const ALPHA = 'Uses the v1alpha Admin API.';

const dataStreamId = z
  .string()
  .describe('Data stream ID or full resource name (from ga_list_data_streams).');

/** GA4 enum values are passed through; the descriptions list the known ones. */
const enumValue = (description: string) => z.string().regex(/^[A-Z0-9_]+$/).describe(description);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date as YYYY-MM-DD.');

function toGoogleDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

/** Annotations are either a single day or a date range, never both. */
function annotationDates(args: { date?: string; start_date?: string; end_date?: string }) {
  if (args.date && (args.start_date || args.end_date)) {
    throw new GoogleAnalyticsError(
      'Pass either date or start_date/end_date, not both.',
      'INVALID_ARGUMENTS',
      'Use date for a single-day annotation, or start_date and end_date together for a range.',
    );
  }
  if (Boolean(args.start_date) !== Boolean(args.end_date)) {
    throw new GoogleAnalyticsError(
      'start_date and end_date must be passed together.',
      'INVALID_ARGUMENTS',
      'Pass both ends of the range, or use date for a single day.',
    );
  }
  return {
    annotationDate: args.date ? toGoogleDate(args.date) : undefined,
    annotationDateRange:
      args.start_date && args.end_date
        ? { startDate: toGoogleDate(args.start_date), endDate: toGoogleDate(args.end_date) }
        : undefined,
  };
}

const annotationColor = z
  .enum(['PURPLE', 'BROWN', 'BLUE', 'GREEN', 'RED', 'CYAN', 'ORANGE'])
  .describe('Colour shown on charts.');

const metricUnit = z.enum([
  'STANDARD',
  'CURRENCY',
  'FEET',
  'MILES',
  'METERS',
  'KILOMETERS',
  'MILLISECONDS',
  'SECONDS',
  'MINUTES',
  'HOURS',
]);

export function registerSettingsTools(server: McpServer): void {
  // --- Reporting data annotations (v1alpha) ------------------------------

  server.registerTool(
    'ga_list_annotations',
    {
      description: `List the annotations on a property's report charts (notes such as "campaign launched" pinned to a date or date range). ${ALPHA}`,
      inputSchema: { property_id: optionalPropertyIdArg },
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const items = await adminList(`${property}/reportingDataAnnotations`, 'reportingDataAnnotations', true);
      return JSON.stringify({ ok: true, property, annotations: items });
    }),
  );

  server.registerTool(
    'ga_create_annotation',
    {
      description: `Add an annotation to the property's report charts for a day or a date range, e.g. a campaign launch or a tracking change. ${ALPHA} ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        title: z.string().min(1).max(60),
        description: z.string().max(150).optional(),
        date: isoDate.optional().describe('Single day, YYYY-MM-DD.'),
        start_date: isoDate.optional().describe('Range start, YYYY-MM-DD.'),
        end_date: isoDate.optional().describe('Range end, YYYY-MM-DD.'),
        color: annotationColor.optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const dates = annotationDates(args);
      if (!dates.annotationDate && !dates.annotationDateRange) {
        throw new GoogleAnalyticsError(
          'An annotation needs a date or a date range.',
          'INVALID_ARGUMENTS',
          'Pass date (YYYY-MM-DD), or start_date and end_date.',
        );
      }
      return adminWrite({
        method: 'POST',
        path: `${propertyPath(args.property_id)}/reportingDataAnnotations`,
        action: 'reportingDataAnnotations.create',
        alpha: true,
        body: { title: args.title, description: args.description, color: args.color, ...dates },
      });
    }),
  );

  server.registerTool(
    'ga_update_annotation',
    {
      description: `Change an annotation's title, description, colour, or dates. System-generated annotations cannot be changed. ${ALPHA} ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        annotation: z.string().describe('Annotation ID or full resource name (from ga_list_annotations).'),
        title: z.string().min(1).max(60).optional(),
        description: z.string().max(150).optional(),
        date: isoDate.optional(),
        start_date: isoDate.optional(),
        end_date: isoDate.optional(),
        color: annotationColor.optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        title: args.title,
        description: args.description,
        color: args.color,
        ...annotationDates(args),
      });
      return adminWrite({
        method: 'PATCH',
        path: propertyChildPath(args.property_id, args.annotation, 'reportingDataAnnotations', 'annotation ID'),
        action: 'reportingDataAnnotations.patch',
        alpha: true,
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_delete_annotation',
    {
      description: `Delete an annotation from the property's charts. ${ALPHA} ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        annotation: z.string().describe('Annotation ID or full resource name.'),
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'DELETE',
        path: propertyChildPath(args.property_id, args.annotation, 'reportingDataAnnotations', 'annotation ID'),
        action: 'reportingDataAnnotations.delete',
        alpha: true,
      }),
    ),
  );

  // --- Attribution settings (v1alpha) ------------------------------------

  server.registerTool(
    'ga_get_attribution_settings',
    {
      description: `Get the property's attribution model, key event lookback windows, and which channels can receive credit for conversions exported to Google Ads. ${ALPHA}`,
      inputSchema: { property_id: optionalPropertyIdArg },
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) =>
      adminGet(`${propertyPath(args.property_id)}/attributionSettings`, 'attributionSettings.get', true),
    ),
  );

  server.registerTool(
    'ga_update_attribution_settings',
    {
      description: `Change the property's attribution model or lookback windows. Applies to historical and future data in reports. ${ALPHA} ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        reporting_attribution_model: enumValue(
          'e.g. PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN, PAID_AND_ORGANIC_CHANNELS_LAST_CLICK, GOOGLE_PAID_CHANNELS_LAST_CLICK.',
        ).optional(),
        acquisition_conversion_event_lookback_window: enumValue(
          'e.g. ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_7_DAYS or _30_DAYS.',
        ).optional(),
        other_conversion_event_lookback_window: enumValue(
          'e.g. OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS, _60_DAYS, or _90_DAYS.',
        ).optional(),
        ads_web_conversion_data_export_scope: enumValue(
          'Channels that can receive credit in linked Google Ads: PAID_AND_ORGANIC_CHANNELS or GOOGLE_PAID_CHANNELS.',
        ).optional(),
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        reportingAttributionModel: args.reporting_attribution_model,
        acquisitionConversionEventLookbackWindow: args.acquisition_conversion_event_lookback_window,
        otherConversionEventLookbackWindow: args.other_conversion_event_lookback_window,
        adsWebConversionDataExportScope: args.ads_web_conversion_data_export_scope,
      });
      return adminWrite({
        method: 'PATCH',
        path: `${propertyPath(args.property_id)}/attributionSettings`,
        action: 'attributionSettings.patch',
        alpha: true,
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  // --- Calculated metrics (v1alpha) --------------------------------------

  server.registerTool(
    'ga_list_calculated_metrics',
    {
      description: `List the calculated metrics on a property (custom formulas over other metrics, e.g. cost per sign-up). ${ALPHA}`,
      inputSchema: { property_id: optionalPropertyIdArg },
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const items = await adminList(`${property}/calculatedMetrics`, 'calculatedMetrics', true);
      return JSON.stringify({ ok: true, property, calculatedMetrics: items });
    }),
  );

  server.registerTool(
    'ga_create_calculated_metric',
    {
      description: `Create a calculated metric from a formula over other metrics, e.g. "{{advertiserAdCost}} / {{keyEvents:sign_up}}". Reports reference it as calcMetric:<id>. ${ALPHA} ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        calculated_metric_id: z
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
          .describe('Stable ID used in reports as calcMetric:<id>, e.g. cost_per_signup.'),
        display_name: z.string().min(1).max(82),
        formula: z.string().min(1).describe('Formula with metrics in double braces, e.g. {{sessions}} / {{totalUsers}}.'),
        metric_unit: metricUnit,
        description: z.string().max(4096).optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyPath(args.property_id)}/calculatedMetrics`,
        action: 'calculatedMetrics.create',
        alpha: true,
        query: { calculatedMetricId: args.calculated_metric_id },
        body: {
          displayName: args.display_name,
          formula: args.formula,
          metricUnit: args.metric_unit,
          description: args.description,
        },
      }),
    ),
  );

  server.registerTool(
    'ga_update_calculated_metric',
    {
      description: `Change a calculated metric's name, formula, unit, or description. ${ALPHA} ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        calculated_metric: z.string().describe('Calculated metric ID or full resource name (from ga_list_calculated_metrics).'),
        display_name: z.string().min(1).max(82).optional(),
        formula: z.string().min(1).optional(),
        metric_unit: metricUnit.optional(),
        description: z.string().max(4096).optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        displayName: args.display_name,
        formula: args.formula,
        metricUnit: args.metric_unit,
        description: args.description,
      });
      return adminWrite({
        method: 'PATCH',
        path: propertyChildPath(args.property_id, args.calculated_metric, 'calculatedMetrics', 'calculated metric ID'),
        action: 'calculatedMetrics.patch',
        alpha: true,
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_delete_calculated_metric',
    {
      description: `Delete a calculated metric. Saved reports and explorations that use it lose that column. ${ALPHA} ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        calculated_metric: z.string().describe('Calculated metric ID or full resource name.'),
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'DELETE',
        path: propertyChildPath(args.property_id, args.calculated_metric, 'calculatedMetrics', 'calculated metric ID'),
        action: 'calculatedMetrics.delete',
        alpha: true,
      }),
    ),
  );

  // --- Event edit rules (v1alpha) ----------------------------------------

  server.registerTool(
    'ga_list_event_edit_rules',
    {
      description: `List the event edit rules on a web data stream (rules that rename events or change their parameters as they arrive), in processing order. ${ALPHA}`,
      inputSchema: { property_id: optionalPropertyIdArg, data_stream: dataStreamId },
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const stream = dataStreamPath(args.property_id, args.data_stream);
      const items = await adminList(`${stream}/eventEditRules`, 'eventEditRules', true);
      return JSON.stringify({ ok: true, dataStream: stream, eventEditRules: items });
    }),
  );

  server.registerTool(
    'ga_create_event_edit_rule',
    {
      description: `Create a rule that edits matching incoming events, e.g. rename "Sign Up" to "sign_up" or set a parameter. New rules run after existing ones. ${ALPHA} ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        data_stream: dataStreamId,
        display_name: z.string().min(1).max(255),
        conditions: z
          .array(jsonObject)
          .min(1)
          .describe(
            'MatchingCondition objects, e.g. [{"field":"eventName","comparisonType":"EQUALS","value":"Sign Up"}].',
          ),
        parameter_mutations: z
          .array(jsonObject)
          .min(1)
          .describe('ParameterMutation objects, e.g. [{"parameter":"event_name","parameterValue":"sign_up"}].'),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${dataStreamPath(args.property_id, args.data_stream)}/eventEditRules`,
        action: 'eventEditRules.create',
        alpha: true,
        body: {
          displayName: args.display_name,
          conditions: args.conditions,
          parameterMutations: args.parameter_mutations,
        },
      }),
    ),
  );

  server.registerTool(
    'ga_update_event_edit_rule',
    {
      description: `Change an event edit rule's name, conditions, or parameter mutations. ${ALPHA} ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        data_stream: dataStreamId,
        event_edit_rule: z.string().describe('Rule ID or full resource name (from ga_list_event_edit_rules).'),
        display_name: z.string().min(1).max(255).optional(),
        conditions: z.array(jsonObject).min(1).optional(),
        parameter_mutations: z.array(jsonObject).min(1).optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        displayName: args.display_name,
        conditions: args.conditions,
        parameterMutations: args.parameter_mutations,
      });
      return adminWrite({
        method: 'PATCH',
        path: streamChildPath(args.property_id, args.data_stream, args.event_edit_rule, 'eventEditRules', 'event edit rule ID'),
        action: 'eventEditRules.patch',
        alpha: true,
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_delete_event_edit_rule',
    {
      description: `Delete an event edit rule. Events already collected keep their edited form. ${ALPHA} ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        data_stream: dataStreamId,
        event_edit_rule: z.string().describe('Rule ID or full resource name.'),
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'DELETE',
        path: streamChildPath(args.property_id, args.data_stream, args.event_edit_rule, 'eventEditRules', 'event edit rule ID'),
        action: 'eventEditRules.delete',
        alpha: true,
      }),
    ),
  );

  // --- Google Signals and data sharing (read-only) -----------------------

  server.registerTool(
    'ga_get_google_signals_settings',
    {
      description: `Get whether Google Signals (cross-device data from signed-in Google users) is enabled on the property. ${ALPHA}`,
      inputSchema: { property_id: optionalPropertyIdArg },
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) =>
      adminGet(`${propertyPath(args.property_id)}/googleSignalsSettings`, 'googleSignalsSettings.get', true),
    ),
  );

  server.registerTool(
    'ga_get_data_sharing_settings',
    {
      description:
        'Get the account-level data sharing settings (what GA shares with Google for support, benchmarking, and product improvement).',
      inputSchema: {
        account_id: z.string().describe('Account ID, with or without the accounts/ prefix (see ga_list_account_summaries).'),
      },
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) =>
      adminGet(`${accountPath(args.account_id)}/dataSharingSettings`, 'dataSharingSettings.get'),
    ),
  );
}
