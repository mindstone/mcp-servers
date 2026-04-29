/**
 * Schema discovery tools — metadata, search, categories, compatibility.
 * All read-only.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { googleApi, propertyPath, Bases } from '../client.js';
import { mapMetadataField, toNameList, withErrorHandling } from '../utils.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

interface MetadataResponse {
  dimensions?: Parameters<typeof mapMetadataField>[0][];
  metrics?: Parameters<typeof mapMetadataField>[0][];
}

async function fetchMetadata(propertyId: string | undefined) {
  const property = propertyPath(propertyId);
  const response = await googleApi<MetadataResponse>(`/${property}/metadata`, {
    baseUrl: Bases.data,
  });
  return {
    property,
    dimensions: (response.dimensions || []).map((field) => mapMetadataField(field, 'dimension')),
    metrics: (response.metrics || []).map((field) => mapMetadataField(field, 'metric')),
  };
}

export function registerSchemaTools(server: McpServer): void {
  server.registerTool(
    'ga_get_metadata',
    {
      description:
        'Get the live GA4 metadata for the property, including all available dimensions and metrics. Use this when you need the raw schema; prefer ga_search_schema for keyword lookups.',
      inputSchema: z.object({
        property_id: z
          .string()
          .optional()
          .describe('Optional GA4 property ID. Defaults to GA4_PROPERTY_ID.'),
      }),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const meta = await fetchMetadata(args.property_id);
      return JSON.stringify({ ok: true, ...meta });
    }),
  );

  server.registerTool(
    'ga_get_property_schema',
    {
      description:
        'Return the full GA4 property schema, including dimension count and metric count. Same data as ga_get_metadata with summary counts.',
      inputSchema: z.object({
        property_id: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const meta = await fetchMetadata(args.property_id);
      return JSON.stringify({
        ok: true,
        property: meta.property,
        dimensionCount: meta.dimensions.length,
        metricCount: meta.metrics.length,
        dimensions: meta.dimensions,
        metrics: meta.metrics,
      });
    }),
  );

  server.registerTool(
    'ga_search_schema',
    {
      description:
        'Search dimensions and metrics by keyword across the live GA4 property schema. Use this to discover the exact apiName for a concept (e.g. "session", "revenue", "country").',
      inputSchema: z.object({
        property_id: z.string().optional(),
        query: z.string().describe('Keyword to search for.'),
        field_type: z
          .enum(['dimension', 'metric', 'all'])
          .default('all')
          .describe('Filter by dimensions, metrics, or both.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .default(50)
          .describe('Maximum matches to return.'),
      }),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const meta = await fetchMetadata(args.property_id);
      const needle = args.query.toLowerCase();

      const matches = (
        items: ReturnType<typeof mapMetadataField>[],
        fieldType: 'dimension' | 'metric',
      ) =>
        items
          .filter((item) =>
            [item.apiName, item.uiName, item.description, item.category].some(
              (value) => String(value || '').toLowerCase().includes(needle),
            ),
          )
          .map((item) => ({ fieldType, ...item }));

      const dimensions =
        args.field_type === 'metric' ? [] : matches(meta.dimensions, 'dimension');
      const metrics =
        args.field_type === 'dimension' ? [] : matches(meta.metrics, 'metric');
      const results = [...dimensions, ...metrics].slice(0, args.limit);

      return JSON.stringify({
        ok: true,
        property: meta.property,
        query: args.query,
        fieldType: args.field_type,
        resultCount: results.length,
        results,
      });
    }),
  );

  server.registerTool(
    'ga_list_dimension_categories',
    {
      description: 'List available dimension categories for the property schema.',
      inputSchema: z.object({ property_id: z.string().optional() }),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const meta = await fetchMetadata(args.property_id);
      const categories = [
        ...new Set(meta.dimensions.map((field) => field.category).filter(Boolean)),
      ].sort();
      return JSON.stringify({
        ok: true,
        property: meta.property,
        categories,
        count: categories.length,
      });
    }),
  );

  server.registerTool(
    'ga_list_metric_categories',
    {
      description: 'List available metric categories for the property schema.',
      inputSchema: z.object({ property_id: z.string().optional() }),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const meta = await fetchMetadata(args.property_id);
      const categories = [
        ...new Set(meta.metrics.map((field) => field.category).filter(Boolean)),
      ].sort();
      return JSON.stringify({
        ok: true,
        property: meta.property,
        categories,
        count: categories.length,
      });
    }),
  );

  server.registerTool(
    'ga_get_dimensions_by_category',
    {
      description: 'Get dimensions for a given category name (from ga_list_dimension_categories).',
      inputSchema: z.object({
        property_id: z.string().optional(),
        category: z.string().describe('Category name from ga_list_dimension_categories.'),
        limit: z.number().int().positive().max(500).default(200),
      }),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const meta = await fetchMetadata(args.property_id);
      const target = args.category.toLowerCase();
      const dimensions = meta.dimensions
        .filter((field) => String(field.category || '').toLowerCase() === target)
        .slice(0, args.limit);
      return JSON.stringify({
        ok: true,
        property: meta.property,
        category: args.category,
        count: dimensions.length,
        dimensions,
      });
    }),
  );

  server.registerTool(
    'ga_get_metrics_by_category',
    {
      description: 'Get metrics for a given category name (from ga_list_metric_categories).',
      inputSchema: z.object({
        property_id: z.string().optional(),
        category: z.string().describe('Category name from ga_list_metric_categories.'),
        limit: z.number().int().positive().max(500).default(200),
      }),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const meta = await fetchMetadata(args.property_id);
      const target = args.category.toLowerCase();
      const metrics = meta.metrics
        .filter((field) => String(field.category || '').toLowerCase() === target)
        .slice(0, args.limit);
      return JSON.stringify({
        ok: true,
        property: meta.property,
        category: args.category,
        count: metrics.length,
        metrics,
      });
    }),
  );

  server.registerTool(
    'ga_check_compatibility',
    {
      description:
        'Check whether a set of dimensions and metrics can be used together in a GA4 report. Useful before running a complex report to avoid INCOMPATIBLE errors.',
      inputSchema: z.object({
        property_id: z.string().optional(),
        dimensions: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('Dimension names (comma-separated string or array).'),
        metrics: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('Metric names (comma-separated string or array).'),
      }),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const dimensions = toNameList(args.dimensions);
      const metrics = toNameList(args.metrics);

      const response = await googleApi<{
        dimensionCompatibilities?: Array<{
          dimensionMetadata?: { apiName?: string };
          compatibility?: string;
        }>;
        metricCompatibilities?: Array<{
          metricMetadata?: { apiName?: string };
          compatibility?: string;
        }>;
      }>(`/${property}:checkCompatibility`, {
        method: 'POST',
        body: {
          dimensions: dimensions.map((name) => ({ name })),
          metrics: metrics.map((name) => ({ name })),
          compatibilityFilter: 'COMPATIBLE',
        },
        baseUrl: Bases.data,
      });

      return JSON.stringify({
        ok: true,
        property,
        compatibleDimensions: (response.dimensionCompatibilities || []).map((item) => ({
          apiName: item.dimensionMetadata?.apiName || null,
          compatibility: item.compatibility || null,
        })),
        compatibleMetrics: (response.metricCompatibilities || []).map((item) => ({
          apiName: item.metricMetadata?.apiName || null,
          compatibility: item.compatibility || null,
        })),
      });
    }),
  );
}
