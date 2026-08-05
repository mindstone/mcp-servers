/**
 * Audience export tools — create/get/list/query GA4 audience exports
 * (Data API v1beta, generally available).
 *
 * An audience export is a server-side snapshot of the users in an audience.
 * The workflow is: ga_create_audience_export -> poll ga_get_audience_export
 * until state is ACTIVE -> page rows with ga_query_audience_export. Creating
 * an export charges audience-export quota tokens, so the create tool is
 * annotated non-read-only and destructive (production-impacting, quota-
 * consuming materialisation) even though it does not modify property
 * configuration.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { googleApi, paginate, propertyPath, Bases } from '../client.js';
import { GoogleAnalyticsError } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { compactObject, UNTRUSTED_SOURCES, withErrorHandling } from '../utils.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const CREATE_EXPORT = {
  readOnlyHint: false,
  // Creating an audience export materialises a server-side snapshot and
  // charges audience-export quota tokens — a production-impacting,
  // non-idempotent operation, so it is annotated destructive (invariant #7).
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

interface AudienceExport {
  name?: string;
  audience?: string;
  audienceDisplayName?: string;
  dimensions?: Array<{ dimensionName?: string }>;
  state?: string;
  beginCreatingTime?: string;
  creationQuotaTokensCharged?: number;
  rowCount?: number;
}

/** Resolve `properties/<id>/audienceExports/<exportId>` from flexible input. */
function audienceExportPath(propertyId: string | undefined, exportId: string): string {
  const property = propertyPath(propertyId);
  const clean = String(exportId)
    .replace(/^properties\/[^/]+\/audienceExports\//, '')
    .replace(/^audienceExports\//, '');
  if (!clean) {
    throw new GoogleAnalyticsError(
      'Audience export ID is required.',
      'AUDIENCE_EXPORT_ID_REQUIRED',
      'Pass `export_id` as the bare export ID or the full resource name returned by ga_create_audience_export.',
    );
  }
  return `${property}/audienceExports/${clean}`;
}

/** Resolve `properties/<id>/audiences/<audienceId>` from flexible input. */
function audiencePath(propertyId: string | undefined, audienceId: string): string {
  const property = propertyPath(propertyId);
  const clean = String(audienceId)
    .replace(/^properties\/[^/]+\/audiences\//, '')
    .replace(/^audiences\//, '');
  if (!clean) {
    throw new GoogleAnalyticsError(
      'Audience ID is required.',
      'AUDIENCE_ID_REQUIRED',
      'Pass `audience` as the bare audience ID or the full resource name. Use ga_list_audiences to discover audience IDs.',
    );
  }
  return `${property}/audiences/${clean}`;
}

function mapAudienceExport(audienceExport: AudienceExport) {
  return {
    name: audienceExport.name || null,
    audience: audienceExport.audience || null,
    audienceDisplayName:
      wrapUntrusted(audienceExport.audienceDisplayName, UNTRUSTED_SOURCES.audienceExport) ||
      null,
    // Vendor-echoed audience dimension names — envelope (invariant #6).
    dimensions: (audienceExport.dimensions || []).map(
      (dim) =>
        wrapUntrusted(dim.dimensionName, UNTRUSTED_SOURCES.audienceExport) || null,
    ),
    state: audienceExport.state || null,
    beginCreatingTime: audienceExport.beginCreatingTime || null,
    creationQuotaTokensCharged: audienceExport.creationQuotaTokensCharged ?? null,
    rowCount: audienceExport.rowCount ?? null,
  };
}

const exportIdShape = {
  property_id: z
    .string()
    .optional()
    .describe('Optional GA4 property ID. Defaults to GA4_PROPERTY_ID.'),
  export_id: z
    .string()
    .describe(
      'Audience export ID — bare ID or full resource name (properties/<id>/audienceExports/<exportId>), as returned by ga_create_audience_export.',
    ),
};

const CreateAudienceExportInputShape = {
  property_id: z
    .string()
    .optional()
    .describe('Optional GA4 property ID. Defaults to GA4_PROPERTY_ID.'),
  audience: z
    .string()
    .describe(
      'Audience to export — bare ID or full resource name. Use ga_list_audiences to discover audience IDs.',
    ),
  dimensions: z
    .array(z.string())
    .optional()
    .describe(
      'Optional audience dimension names (e.g. userId, deviceId, isAdsPersonalizationAllowed). Defaults to the API default set when omitted.',
    ),
};

const QueryAudienceExportInputShape = {
  ...exportIdShape,
  offset: z.number().int().nonnegative().default(0),
  limit: z
    .number()
    .int()
    .positive()
    .max(250_000)
    .default(1_000)
    .describe('Rows per page. The API caps a single page at 250,000 rows.'),
};

export function registerAudienceExportTools(server: McpServer): void {
  server.registerTool(
    'ga_create_audience_export',
    {
      description:
        'Create an audience export — a server-side snapshot of the users in a GA4 audience for later retrieval. Charges audience-export quota tokens and takes seconds-to-minutes to become ACTIVE; poll with ga_get_audience_export, then page users with ga_query_audience_export. Does not modify property configuration.',
      inputSchema: CreateAudienceExportInputShape,
      annotations: CREATE_EXPORT,
    },
    withErrorHandling(async (rawArgs) => {
      const args = z.object(CreateAudienceExportInputShape).parse(rawArgs ?? {});
      const property = propertyPath(args.property_id);
      const response = await googleApi<AudienceExport>(`/${property}/audienceExports`, {
        method: 'POST',
        body: {
          audienceExport: compactObject({
            audience: audiencePath(args.property_id, args.audience),
            dimensions: args.dimensions?.map((dimensionName) => ({ dimensionName })),
          }),
        },
        baseUrl: Bases.data,
      });
      return JSON.stringify({ ok: true, property, audienceExport: mapAudienceExport(response) });
    }),
  );

  server.registerTool(
    'ga_get_audience_export',
    {
      description:
        'Get the configuration metadata and state of an audience export. Poll this after ga_create_audience_export until state is ACTIVE before querying rows.',
      inputSchema: z.object(exportIdShape),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const name = audienceExportPath(args.property_id, args.export_id);
      const response = await googleApi<AudienceExport>(`/${name}`, { baseUrl: Bases.data });
      return JSON.stringify({
        ok: true,
        property: name.split('/audienceExports/')[0],
        audienceExport: mapAudienceExport(response),
      });
    }),
  );

  server.registerTool(
    'ga_list_audience_exports',
    {
      description:
        'List all audience exports for a GA4 property. Useful to find and reuse an existing export rather than creating a new one.',
      inputSchema: z.object({
        property_id: z
          .string()
          .optional()
          .describe('Optional GA4 property ID. Defaults to GA4_PROPERTY_ID.'),
      }),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const exports = await paginate<AudienceExport>(`/${property}/audienceExports`, {
        itemKey: 'audienceExports',
        query: { pageSize: 200 },
        baseUrl: Bases.data,
      });
      return JSON.stringify({
        ok: true,
        property,
        audienceExports: exports.map(mapAudienceExport),
      });
    }),
  );

  server.registerTool(
    'ga_query_audience_export',
    {
      description:
        'Retrieve users from an ACTIVE audience export, with offset/limit pagination. Rows contain user-level identifiers (user IDs / device IDs) — treat them as privacy-sensitive. The export must be ACTIVE; poll ga_get_audience_export first.',
      inputSchema: QueryAudienceExportInputShape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (rawArgs) => {
      const args = z.object(QueryAudienceExportInputShape).parse(rawArgs ?? {});
      const name = audienceExportPath(args.property_id, args.export_id);
      const response = await googleApi<{
        audienceRows?: Array<{ dimensionValues?: Array<{ value?: string }> }>;
        audienceExport?: AudienceExport;
        rowCount?: number;
      }>(`/${name}:query`, {
        method: 'POST',
        body: { offset: String(args.offset), limit: String(args.limit) },
        baseUrl: Bases.data,
      });

      // Vendor-echoed dimension names become structural keys in the row
      // objects — envelope them like the recursive helper does (invariant #6).
      const dimensionNames = (response.audienceExport?.dimensions || []).map(
        (dim) =>
          wrapUntrusted(dim.dimensionName, UNTRUSTED_SOURCES.audienceExport) ?? 'unknown',
      );
      const rows = (response.audienceRows || []).map((row) => {
        const item: Record<string, string | null> = {};
        dimensionNames.forEach((dimensionName, index) => {
          item[dimensionName] =
            wrapUntrusted(
              row.dimensionValues?.[index]?.value,
              UNTRUSTED_SOURCES.audienceExport,
            ) ?? null;
        });
        return item;
      });

      return JSON.stringify({
        ok: true,
        audienceExport: response.audienceExport
          ? mapAudienceExport(response.audienceExport)
          : null,
        rowCount: response.rowCount ?? rows.length,
        offset: args.offset,
        limit: args.limit,
        rows,
      });
    }),
  );
}
