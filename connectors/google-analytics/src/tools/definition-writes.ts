/**
 * Write tools for what a property measures: custom dimensions and metrics,
 * key events, audiences, channel groups, and event create rules.
 * All writes are gated by GA4_ALLOW_WRITES (see ../writes.ts).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Bases, googleApi, propertyPath } from '../client.js';
import { wrapUntrustedJsonStrings } from '../untrusted-content.js';
import { parseApiResponse, UNTRUSTED_SOURCES, withErrorHandling } from '../utils.js';
import {
  adminWrite,
  buildPatch,
  confirmArg,
  dataStreamPath,
  jsonObject,
  optionalPropertyIdArg,
  propertyChildPath,
  propertyIdArg,
  streamChildPath,
  WRITE,
  WRITE_NOTE,
  READ_ONLY,
} from '../writes.js';

const customDimensionId = z
  .string()
  .describe('Custom dimension ID or full resource name (from ga_get_custom_dimensions_and_metrics).');
const customMetricId = z
  .string()
  .describe('Custom metric ID or full resource name (from ga_get_custom_dimensions_and_metrics).');
const keyEventId = z.string().describe('Key event ID or full resource name (from ga_list_key_events).');
const audienceId = z.string().describe('Audience ID or full resource name (from ga_list_audiences).');
const channelGroupId = z
  .string()
  .describe('Channel group ID or full resource name (from ga_list_channel_groups).');
const dataStreamId = z
  .string()
  .describe('Data stream ID or full resource name (from ga_list_data_streams).');

const keyEventDefaultValue = z
  .object({
    numericValue: z.number().describe('Value assigned to each occurrence.'),
    currencyCode: z.string().length(3).describe('ISO 4217 currency code, e.g. GBP.'),
  })
  .describe('Default value attached to the key event when the event has no value parameter.');

const countingMethod = z
  .enum(['ONCE_PER_EVENT', 'ONCE_PER_SESSION'])
  .describe('Count every occurrence, or at most once per session.');

const eventCreateRuleListSchema = z
  .object({
    eventCreateRules: z.array(z.object({ name: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

export function registerDefinitionWriteTools(server: McpServer): void {
  // --- Custom dimensions -------------------------------------------------

  server.registerTool(
    'ga_create_custom_dimension',
    {
      description: `Create a custom dimension that reports on an event, user, or item parameter. The parameter name cannot be changed later. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        parameter_name: z
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)
          .describe('Event/user/item parameter to report on, e.g. plan_tier. Up to 40 characters.'),
        display_name: z.string().min(1).max(82).describe('Name shown in GA4 reports.'),
        scope: z.enum(['EVENT', 'USER', 'ITEM']).describe('Which parameter type the dimension reads.'),
        description: z.string().max(150).optional(),
        disallow_ads_personalization: z
          .boolean()
          .optional()
          .describe('USER scope only: exclude this dimension from ads personalization.'),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyPath(args.property_id)}/customDimensions`,
        action: 'customDimensions.create',
        body: {
          parameterName: args.parameter_name,
          displayName: args.display_name,
          scope: args.scope,
          description: args.description,
          disallowAdsPersonalization: args.disallow_ads_personalization,
        },
      }),
    ),
  );

  server.registerTool(
    'ga_update_custom_dimension',
    {
      description: `Update a custom dimension's display name, description, or ads-personalization flag. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        custom_dimension: customDimensionId,
        display_name: z.string().min(1).max(82).optional(),
        description: z.string().max(150).optional(),
        disallow_ads_personalization: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        displayName: args.display_name,
        description: args.description,
        disallowAdsPersonalization: args.disallow_ads_personalization,
      });
      return adminWrite({
        method: 'PATCH',
        path: propertyChildPath(args.property_id, args.custom_dimension, 'customDimensions', 'custom dimension ID'),
        action: 'customDimensions.patch',
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_archive_custom_dimension',
    {
      description: `Archive a custom dimension. It stops collecting and frees its quota slot; it cannot be restored. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        custom_dimension: customDimensionId,
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyChildPath(args.property_id, args.custom_dimension, 'customDimensions', 'custom dimension ID')}:archive`,
        action: 'customDimensions.archive',
        body: {},
      }),
    ),
  );

  // --- Custom metrics ----------------------------------------------------

  server.registerTool(
    'ga_create_custom_metric',
    {
      description: `Create an event-scoped custom metric from a numeric event parameter. The parameter name cannot be changed later. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        parameter_name: z
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)
          .describe('Numeric event parameter to report on, e.g. seats_purchased.'),
        display_name: z.string().min(1).max(82),
        measurement_unit: z
          .enum([
            'STANDARD',
            'CURRENCY',
            'FEET',
            'METERS',
            'KILOMETERS',
            'MILES',
            'MILLISECONDS',
            'SECONDS',
            'MINUTES',
            'HOURS',
          ])
          .describe('Unit for the metric value.'),
        description: z.string().max(150).optional(),
        restricted_metric_type: z
          .array(z.enum(['COST_DATA', 'REVENUE_DATA']))
          .optional()
          .describe('CURRENCY metrics only: mark as cost or revenue data.'),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyPath(args.property_id)}/customMetrics`,
        action: 'customMetrics.create',
        body: {
          parameterName: args.parameter_name,
          displayName: args.display_name,
          measurementUnit: args.measurement_unit,
          scope: 'EVENT',
          description: args.description,
          restrictedMetricType: args.restricted_metric_type,
        },
      }),
    ),
  );

  server.registerTool(
    'ga_update_custom_metric',
    {
      description: `Update a custom metric's display name, description, unit, or restricted type. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        custom_metric: customMetricId,
        display_name: z.string().min(1).max(82).optional(),
        description: z.string().max(150).optional(),
        measurement_unit: z
          .enum([
            'STANDARD',
            'CURRENCY',
            'FEET',
            'METERS',
            'KILOMETERS',
            'MILES',
            'MILLISECONDS',
            'SECONDS',
            'MINUTES',
            'HOURS',
          ])
          .optional(),
        restricted_metric_type: z.array(z.enum(['COST_DATA', 'REVENUE_DATA'])).optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        displayName: args.display_name,
        description: args.description,
        measurementUnit: args.measurement_unit,
        restrictedMetricType: args.restricted_metric_type,
      });
      return adminWrite({
        method: 'PATCH',
        path: propertyChildPath(args.property_id, args.custom_metric, 'customMetrics', 'custom metric ID'),
        action: 'customMetrics.patch',
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_archive_custom_metric',
    {
      description: `Archive a custom metric. It stops collecting and frees its quota slot; it cannot be restored. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        custom_metric: customMetricId,
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyChildPath(args.property_id, args.custom_metric, 'customMetrics', 'custom metric ID')}:archive`,
        action: 'customMetrics.archive',
        body: {},
      }),
    ),
  );

  // --- Key events --------------------------------------------------------

  server.registerTool(
    'ga_create_key_event',
    {
      description: `Mark an event as a key event (formerly a conversion). The event does not need to have fired yet. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        event_name: z.string().min(1).max(40).describe('Event name, e.g. sign_up.'),
        counting_method: countingMethod,
        default_value: keyEventDefaultValue.optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyPath(args.property_id)}/keyEvents`,
        action: 'keyEvents.create',
        body: {
          eventName: args.event_name,
          countingMethod: args.counting_method,
          defaultValue: args.default_value,
        },
      }),
    ),
  );

  server.registerTool(
    'ga_update_key_event',
    {
      description: `Change a key event's counting method or default value. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        key_event: keyEventId,
        counting_method: countingMethod.optional(),
        default_value: keyEventDefaultValue.optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        countingMethod: args.counting_method,
        defaultValue: args.default_value,
      });
      return adminWrite({
        method: 'PATCH',
        path: propertyChildPath(args.property_id, args.key_event, 'keyEvents', 'key event ID'),
        action: 'keyEvents.patch',
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_delete_key_event',
    {
      description: `Stop treating an event as a key event. The event itself keeps being collected. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        key_event: keyEventId,
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'DELETE',
        path: propertyChildPath(args.property_id, args.key_event, 'keyEvents', 'key event ID'),
        action: 'keyEvents.delete',
      }),
    ),
  );

  // --- Audiences (v1alpha) -----------------------------------------------

  server.registerTool(
    'ga_create_audience',
    {
      description: `Create an audience from filter clauses (same structure ga_list_audiences returns). Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        display_name: z.string().min(1),
        description: z.string().min(1).describe('Required by GA4.'),
        membership_duration_days: z
          .number()
          .int()
          .min(1)
          .max(540)
          .describe('How long a user stays in the audience, 1-540 days.'),
        filter_clauses: z
          .array(jsonObject)
          .min(1)
          .describe(
            'AudienceFilterClause objects, e.g. [{"clauseType":"INCLUDE","simpleFilter":{"scope":"AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS","filterExpression":{...}}}].',
          ),
        ads_personalization_enabled: z.boolean().optional(),
        exclusion_duration_mode: z
          .enum(['EXCLUDE_TEMPORARILY', 'EXCLUDE_PERMANENTLY'])
          .optional(),
        event_trigger: jsonObject
          .optional()
          .describe('Optional AudienceEventTrigger: {"eventName":"...","logCondition":"AUDIENCE_JOINED"}.'),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyPath(args.property_id)}/audiences`,
        action: 'audiences.create',
        alpha: true,
        body: {
          displayName: args.display_name,
          description: args.description,
          membershipDurationDays: args.membership_duration_days,
          filterClauses: args.filter_clauses,
          adsPersonalizationEnabled: args.ads_personalization_enabled,
          exclusionDurationMode: args.exclusion_duration_mode,
          eventTrigger: args.event_trigger,
        },
      }),
    ),
  );

  server.registerTool(
    'ga_update_audience',
    {
      description: `Update an audience's display name, description, or membership duration. GA4 does not allow changing filter clauses after creation. Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        audience: audienceId,
        display_name: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        membership_duration_days: z.number().int().min(1).max(540).optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        displayName: args.display_name,
        description: args.description,
        membershipDurationDays: args.membership_duration_days,
      });
      return adminWrite({
        method: 'PATCH',
        path: propertyChildPath(args.property_id, args.audience, 'audiences', 'audience ID'),
        action: 'audiences.patch',
        alpha: true,
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_archive_audience',
    {
      description: `Archive an audience. It stops accumulating members and cannot be restored. Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        audience: audienceId,
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyChildPath(args.property_id, args.audience, 'audiences', 'audience ID')}:archive`,
        action: 'audiences.archive',
        alpha: true,
        body: {},
      }),
    ),
  );

  // --- Channel groups (v1alpha) ------------------------------------------

  server.registerTool(
    'ga_create_channel_group',
    {
      description: `Create a custom channel group from grouping rules (same structure ga_list_channel_groups returns). Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        display_name: z.string().min(1).max(80),
        description: z.string().max(256).optional(),
        grouping_rule: z
          .array(jsonObject)
          .min(1)
          .describe(
            'GroupingRule objects in priority order, e.g. [{"displayName":"Paid LinkedIn","expression":{"andGroup":{...}}}].',
          ),
        primary: z
          .boolean()
          .optional()
          .describe('Make this the primary channel group used in standard reports.'),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyPath(args.property_id)}/channelGroups`,
        action: 'channelGroups.create',
        alpha: true,
        body: {
          displayName: args.display_name,
          description: args.description,
          groupingRule: args.grouping_rule,
          primary: args.primary,
        },
      }),
    ),
  );

  server.registerTool(
    'ga_update_channel_group',
    {
      description: `Update a custom channel group's name, description, grouping rules, or primary flag. Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        channel_group: channelGroupId,
        display_name: z.string().min(1).max(80).optional(),
        description: z.string().max(256).optional(),
        grouping_rule: z.array(jsonObject).min(1).optional(),
        primary: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        displayName: args.display_name,
        description: args.description,
        groupingRule: args.grouping_rule,
        primary: args.primary,
      });
      return adminWrite({
        method: 'PATCH',
        path: propertyChildPath(args.property_id, args.channel_group, 'channelGroups', 'channel group ID'),
        action: 'channelGroups.patch',
        alpha: true,
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_delete_channel_group',
    {
      description: `Delete a custom channel group. System-defined groups cannot be deleted. Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        channel_group: channelGroupId,
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'DELETE',
        path: propertyChildPath(args.property_id, args.channel_group, 'channelGroups', 'channel group ID'),
        action: 'channelGroups.delete',
        alpha: true,
      }),
    ),
  );

  // --- Event create rules (v1alpha) --------------------------------------

  server.registerTool(
    'ga_list_event_create_rules',
    {
      description:
        'List the event create rules on a web data stream (rules that create a new event when an incoming event matches conditions). Uses the v1alpha Admin API.',
      inputSchema: {
        property_id: optionalPropertyIdArg,
        data_stream: dataStreamId,
      },
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const stream = dataStreamPath(args.property_id, args.data_stream);
      const response = parseApiResponse(
        eventCreateRuleListSchema,
        (await googleApi(`/${stream}/eventCreateRules`, {
          query: { pageSize: 200 },
          baseUrl: Bases.adminAlpha,
        })) ?? {},
        'eventCreateRules.list',
      );
      return JSON.stringify({
        ok: true,
        dataStream: stream,
        eventCreateRules: (response.eventCreateRules ?? []).map((rule) => ({
          name: rule.name ?? null,
          rule: wrapUntrustedJsonStrings(rule, UNTRUSTED_SOURCES.admin),
        })),
      });
    }),
  );

  server.registerTool(
    'ga_create_event_create_rule',
    {
      description: `Create a rule on a data stream that emits a new event when an incoming event matches conditions, e.g. create "demo_booked" when page_view has page_location containing /thanks. Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        data_stream: dataStreamId,
        destination_event: z.string().min(1).max(40).describe('Name of the event to create.'),
        event_conditions: z
          .array(jsonObject)
          .min(1)
          .describe(
            'MatchingCondition objects, e.g. [{"field":"eventName","comparisonType":"EQUALS","value":"page_view"},{"field":"page_location","comparisonType":"CONTAINS","value":"/thanks"}].',
          ),
        source_copy_parameters: z
          .boolean()
          .optional()
          .describe('Copy parameters from the source event to the new event.'),
        parameter_mutations: z
          .array(jsonObject)
          .optional()
          .describe('ParameterMutation objects: [{"parameter":"value","parameterValue":"100"}].'),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${dataStreamPath(args.property_id, args.data_stream)}/eventCreateRules`,
        action: 'eventCreateRules.create',
        alpha: true,
        body: {
          destinationEvent: args.destination_event,
          eventConditions: args.event_conditions,
          sourceCopyParameters: args.source_copy_parameters,
          parameterMutations: args.parameter_mutations,
        },
      }),
    ),
  );

  server.registerTool(
    'ga_update_event_create_rule',
    {
      description: `Update an event create rule's destination event, conditions, or parameter handling. Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        data_stream: dataStreamId,
        event_create_rule: z.string().describe('Rule ID or full resource name (from ga_list_event_create_rules).'),
        destination_event: z.string().min(1).max(40).optional(),
        event_conditions: z.array(jsonObject).min(1).optional(),
        source_copy_parameters: z.boolean().optional(),
        parameter_mutations: z.array(jsonObject).optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        destinationEvent: args.destination_event,
        eventConditions: args.event_conditions,
        sourceCopyParameters: args.source_copy_parameters,
        parameterMutations: args.parameter_mutations,
      });
      return adminWrite({
        method: 'PATCH',
        path: streamChildPath(args.property_id, args.data_stream, args.event_create_rule, 'eventCreateRules', 'event create rule ID'),
        action: 'eventCreateRules.patch',
        alpha: true,
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_delete_event_create_rule',
    {
      description: `Delete an event create rule. Events it already created stay in reports. Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        data_stream: dataStreamId,
        event_create_rule: z.string().describe('Rule ID or full resource name.'),
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'DELETE',
        path: streamChildPath(args.property_id, args.data_stream, args.event_create_rule, 'eventCreateRules', 'event create rule ID'),
        action: 'eventCreateRules.delete',
        alpha: true,
      }),
    ),
  );
}
