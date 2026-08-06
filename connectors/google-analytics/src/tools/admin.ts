/**
 * Admin visibility tools — custom dimensions/metrics, ads/key event/data
 * stream listings, BigQuery / Firebase links, data retention, change
 * history. Read-only.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { googleApi, paginate, propertyPath, accountPath, Bases, MAX_LIST_PAGES, paginationLimitExceeded } from '../client.js';
import { GoogleAnalyticsError } from '../types.js';
import { wrapUntrusted, wrapUntrustedJsonStrings } from '../untrusted-content.js';
import { parseApiResponse, UNTRUSTED_SOURCES, withErrorHandling } from '../utils.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const requiredPropertyId = z.object({
  property_id: z.string().describe('GA4 property ID, with or without the properties/ prefix.'),
});

/**
 * Runtime shapes of Admin API resources, validated at the boundary
 * (fail-closed) instead of only TypeScript-cast. .passthrough() keeps the
 * surfaces forward-compatible with new vendor fields.
 */
const customDimensionSchema = z
  .object({
    name: z.string().optional(),
    parameterName: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    scope: z.string().optional(),
    disallowAdsPersonalization: z.boolean().optional(),
  })
  .passthrough();

const customMetricSchema = z
  .object({
    name: z.string().optional(),
    parameterName: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    measurementUnit: z.string().optional(),
    restrictedMetricType: z.array(z.string()).optional(),
  })
  .passthrough();

const dataStreamSchema = z
  .object({
    name: z.string().optional(),
    displayName: z.string().optional(),
    type: z.string().optional(),
    createTime: z.string().optional(),
    updateTime: z.string().optional(),
    webStreamData: z
      .object({
        defaultUri: z.string().optional(),
        measurementId: z.string().optional(),
      })
      .passthrough()
      .optional(),
    androidAppStreamData: z.unknown().optional(),
    iosAppStreamData: z.unknown().optional(),
  })
  .passthrough();

const googleAdsLinkSchema = z
  .object({
    name: z.string().optional(),
    customerId: z.string().optional(),
    canManageClients: z.boolean().optional(),
    adsPersonalizationEnabled: z.boolean().optional(),
    creatorEmailAddress: z.string().optional(),
  })
  .passthrough();

const keyEventSchema = z
  .object({
    name: z.string().optional(),
    eventName: z.string().optional(),
    createTime: z.string().optional(),
    countingMethod: z.string().optional(),
    defaultValue: z.unknown().optional(),
    deletable: z.boolean().optional(),
  })
  .passthrough();

const audienceSchema = z
  .object({
    name: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    membershipDurationDays: z.number().optional(),
    adsPersonalizationEnabled: z.boolean().optional(),
    exclusionDurationMode: z.string().optional(),
    filterClauses: z.array(z.unknown()).optional(),
    createTime: z.string().optional(),
  })
  .passthrough();

const channelGroupSchema = z
  .object({
    name: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    systemDefined: z.boolean().optional(),
    groupingRule: z.array(z.unknown()).optional(),
  })
  .passthrough();

const bigQueryLinkSchema = z
  .object({
    name: z.string().optional(),
    project: z.string().optional(),
    exportStreams: z.array(z.string()).optional(),
    dailyExportEnabled: z.boolean().optional(),
    streamingExportEnabled: z.boolean().optional(),
    freshDailyExportEnabled: z.boolean().optional(),
    includeAdvertisingId: z.boolean().optional(),
  })
  .passthrough();

const firebaseLinkSchema = z
  .object({
    name: z.string().optional(),
    project: z.string().optional(),
    createTime: z.string().optional(),
  })
  .passthrough();

const dataRetentionSettingsSchema = z
  .object({
    name: z.string().optional(),
    eventDataRetention: z.string().optional(),
    resetUserDataOnNewActivity: z.boolean().optional(),
  })
  .passthrough();

const globalSiteTagSchema = z
  .object({
    name: z.string().optional(),
    snippet: z.string().optional(),
  })
  .passthrough();

const propertyParentSchema = z
  .object({
    parent: z.string().optional(),
  })
  .passthrough();

const changeHistoryEventSchema = z
  .object({
    id: z.string().optional(),
    changeTime: z.string().optional(),
    actorType: z.string().optional(),
    userActorEmail: z.string().optional(),
    changes: z
      .array(
        z
          .object({
            action: z.string().optional(),
            resource: z.string().optional(),
            resourceAfterChange: z.unknown().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const changeHistoryResponseSchema = z
  .object({
    changeHistoryEvents: z.array(changeHistoryEventSchema).optional(),
    nextPageToken: z.string().optional(),
  })
  .passthrough();

export function registerAdminTools(server: McpServer): void {
  server.registerTool(
    'ga_get_custom_dimensions_and_metrics',
    {
      description:
        'List all custom dimensions and custom metrics configured on a GA4 property.',
      inputSchema: requiredPropertyId.shape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const [customDimensions, customMetrics] = await Promise.all([
        paginate(`/${property}/customDimensions`, {
          itemKey: 'customDimensions',
          itemSchema: customDimensionSchema,
          query: { pageSize: 200 },
        }),
        paginate(`/${property}/customMetrics`, {
          itemKey: 'customMetrics',
          itemSchema: customMetricSchema,
          query: { pageSize: 200 },
        }),
      ]);
      return JSON.stringify({
        ok: true,
        property,
        customDimensions: customDimensions.map((item) => ({
          name: item.name || null,
          parameterName: item.parameterName || null,
          displayName: wrapUntrusted(item.displayName, UNTRUSTED_SOURCES.admin) || null,
          description: wrapUntrusted(item.description, UNTRUSTED_SOURCES.admin) || null,
          scope: item.scope || null,
          disallowAdsPersonalization: item.disallowAdsPersonalization || false,
        })),
        customMetrics: customMetrics.map((item) => ({
          name: item.name || null,
          parameterName: item.parameterName || null,
          displayName: wrapUntrusted(item.displayName, UNTRUSTED_SOURCES.admin) || null,
          description: wrapUntrusted(item.description, UNTRUSTED_SOURCES.admin) || null,
          measurementUnit: item.measurementUnit || null,
          restrictedMetricType: item.restrictedMetricType || [],
        })),
      });
    }),
  );

  server.registerTool(
    'ga_list_google_ads_links',
    {
      description: 'List all Google Ads links configured on a GA4 property.',
      inputSchema: requiredPropertyId.shape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const links = await paginate(`/${property}/googleAdsLinks`, {
        itemKey: 'googleAdsLinks',
        itemSchema: googleAdsLinkSchema,
        query: { pageSize: 200 },
      });
      return JSON.stringify({
        ok: true,
        property,
        googleAdsLinks: links.map((link) => ({
          name: link.name || null,
          customerId: link.customerId || null,
          canManageClients: link.canManageClients || false,
          adsPersonalizationEnabled: link.adsPersonalizationEnabled || false,
          creatorEmailAddress:
            wrapUntrusted(link.creatorEmailAddress, UNTRUSTED_SOURCES.admin) || null,
        })),
      });
    }),
  );

  server.registerTool(
    'ga_list_key_events',
    {
      description:
        'List all key events (formerly conversions) configured on a GA4 property.',
      inputSchema: requiredPropertyId.shape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const keyEvents = await paginate(`/${property}/keyEvents`, {
        itemKey: 'keyEvents',
        itemSchema: keyEventSchema,
        query: { pageSize: 200 },
      });
      return JSON.stringify({
        ok: true,
        property,
        keyEvents: keyEvents.map((item) => ({
          name: item.name || null,
          eventName: wrapUntrusted(item.eventName, UNTRUSTED_SOURCES.admin) || null,
          createTime: item.createTime || null,
          countingMethod: item.countingMethod || null,
          defaultValue: item.defaultValue || null,
          deletable: item.deletable || false,
        })),
      });
    }),
  );

  server.registerTool(
    'ga_list_data_streams',
    {
      description:
        'List all data streams (web, Android app, iOS app) on a GA4 property.',
      inputSchema: requiredPropertyId.shape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const dataStreams = await paginate(`/${property}/dataStreams`, {
        itemKey: 'dataStreams',
        itemSchema: dataStreamSchema,
        query: { pageSize: 200 },
      });
      return JSON.stringify({
        ok: true,
        property,
        dataStreams: dataStreams.map((stream) => ({
          name: stream.name || null,
          displayName: wrapUntrusted(stream.displayName, UNTRUSTED_SOURCES.admin) || null,
          type: stream.type || null,
          createTime: stream.createTime || null,
          updateTime: stream.updateTime || null,
          webStreamData: stream.webStreamData || null,
          androidAppStreamData: stream.androidAppStreamData || null,
          iosAppStreamData: stream.iosAppStreamData || null,
        })),
      });
    }),
  );

  server.registerTool(
    'ga_list_audiences',
    {
      description:
        'List all audiences configured on a GA4 property, including membership duration, ads-personalization flag, and filter clauses. Uses the v1alpha Admin API (audiences are not yet promoted to v1beta); structure may evolve over time.',
      inputSchema: requiredPropertyId.shape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const audiences = await paginate(`/${property}/audiences`, {
        itemKey: 'audiences',
        itemSchema: audienceSchema,
        query: { pageSize: 200 },
        baseUrl: Bases.adminAlpha,
      });
      return JSON.stringify({
        ok: true,
        property,
        audiences: audiences.map((audience) => ({
          name: audience.name || null,
          displayName: wrapUntrusted(audience.displayName, UNTRUSTED_SOURCES.admin) || null,
          description: wrapUntrusted(audience.description, UNTRUSTED_SOURCES.admin) || null,
          membershipDurationDays: audience.membershipDurationDays ?? null,
          adsPersonalizationEnabled: audience.adsPersonalizationEnabled || false,
          exclusionDurationMode: audience.exclusionDurationMode || null,
          // User-authored definition blob — enveloped wholesale.
          filterClauses: wrapUntrustedJsonStrings(
            audience.filterClauses || [],
            UNTRUSTED_SOURCES.admin,
          ),
          createTime: audience.createTime || null,
        })),
      });
    }),
  );

  server.registerTool(
    'ga_list_channel_groups',
    {
      description:
        'List all channel groups configured on a GA4 property, including the grouping rules that define channels such as "Organic Social". Uses the v1alpha Admin API (channel groups are not yet promoted to v1beta); structure may evolve over time.',
      inputSchema: requiredPropertyId.shape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const channelGroups = await paginate(`/${property}/channelGroups`, {
        itemKey: 'channelGroups',
        itemSchema: channelGroupSchema,
        query: { pageSize: 200 },
        baseUrl: Bases.adminAlpha,
      });
      return JSON.stringify({
        ok: true,
        property,
        channelGroups: channelGroups.map((group) => ({
          name: group.name || null,
          displayName: wrapUntrusted(group.displayName, UNTRUSTED_SOURCES.admin) || null,
          description: wrapUntrusted(group.description, UNTRUSTED_SOURCES.admin) || null,
          systemDefined: group.systemDefined || false,
          // User-authored definition blob — enveloped wholesale.
          groupingRule: wrapUntrustedJsonStrings(
            group.groupingRule || [],
            UNTRUSTED_SOURCES.admin,
          ),
        })),
      });
    }),
  );

  server.registerTool(
    'ga_get_global_site_tag',
    {
      description:
        'Get the gtag.js / global site tag snippet for the first web data stream on a GA4 property.',
      inputSchema: requiredPropertyId.shape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const dataStreams = await paginate(`/${property}/dataStreams`, {
        itemKey: 'dataStreams',
        itemSchema: dataStreamSchema,
        query: { pageSize: 200 },
      });
      const webStream = dataStreams.find(
        (stream) => stream.type === 'WEB_DATA_STREAM' || stream.webStreamData,
      );
      if (!webStream?.name) {
        throw new GoogleAnalyticsError(
          'No web data stream found for this property.',
          'NO_WEB_STREAM',
          'ga_get_global_site_tag is only meaningful for properties with at least one web data stream. Use ga_list_data_streams to see what streams exist.',
        );
      }
      const streamId = webStream.name.split('/').pop();
      const response = parseApiResponse(
        globalSiteTagSchema,
        await googleApi(`/${property}/dataStreams/${streamId}/globalSiteTag`, {
          baseUrl: Bases.adminAlpha,
        }),
        'globalSiteTag.get',
      );
      return JSON.stringify({
        ok: true,
        property,
        dataStream: webStream.name,
        displayName: wrapUntrusted(webStream.displayName, UNTRUSTED_SOURCES.admin) || null,
        globalSiteTag: response?.snippet || null,
        globalSiteTagName: response?.name || null,
      });
    }),
  );

  server.registerTool(
    'ga_list_bigquery_links',
    {
      description: 'List all BigQuery export links configured on a GA4 property.',
      inputSchema: requiredPropertyId.shape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const links = await paginate(`/${property}/bigQueryLinks`, {
        itemKey: 'bigQueryLinks',
        itemSchema: bigQueryLinkSchema,
        query: { pageSize: 200 },
        baseUrl: Bases.adminAlpha,
      });
      return JSON.stringify({
        ok: true,
        property,
        bigQueryLinks: links.map((link) => ({
          name: link.name || null,
          project: link.project || null,
          exportStreams: link.exportStreams || [],
          dailyExportEnabled: link.dailyExportEnabled || false,
          streamingExportEnabled: link.streamingExportEnabled || false,
          freshDailyExportEnabled: link.freshDailyExportEnabled || false,
          includeAdvertisingId: link.includeAdvertisingId || false,
        })),
      });
    }),
  );

  server.registerTool(
    'ga_get_data_retention_settings',
    {
      description: 'Get the configured event data retention settings for a GA4 property.',
      inputSchema: requiredPropertyId.shape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const response = parseApiResponse(
        dataRetentionSettingsSchema,
        await googleApi(`/${property}/dataRetentionSettings`),
        'dataRetentionSettings.get',
      );
      return JSON.stringify({
        ok: true,
        property,
        name: response.name || null,
        eventDataRetention: response.eventDataRetention || null,
        resetUserDataOnNewActivity: response.resetUserDataOnNewActivity || false,
      });
    }),
  );

  server.registerTool(
    'ga_list_firebase_links',
    {
      description: 'List all Firebase project links configured on a GA4 property.',
      inputSchema: requiredPropertyId.shape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const links = await paginate(`/${property}/firebaseLinks`, {
        itemKey: 'firebaseLinks',
        itemSchema: firebaseLinkSchema,
        query: { pageSize: 200 },
      });
      return JSON.stringify({
        ok: true,
        property,
        firebaseLinks: links.map((link) => ({
          name: link.name || null,
          project: link.project || null,
          createTime: link.createTime || null,
        })),
      });
    }),
  );

  server.registerTool(
    'ga_search_change_history_events',
    {
      description:
        'Search the change history (created/updated/deleted) for a GA4 property. Follows all result pages automatically, so large histories are returned in full. Uses the v1alpha admin API; structure may evolve over time.',
      inputSchema: requiredPropertyId.shape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const propertyDetails = parseApiResponse(
        propertyParentSchema,
        await googleApi(`/${property}`),
        'properties.get',
      );
      const parentAccount = propertyDetails.parent;
      if (!parentAccount) {
        throw new GoogleAnalyticsError(
          'Property does not expose a parent account.',
          'NO_PARENT_ACCOUNT',
          'GA4 change history requires a parent account on the property record. Re-check the property with ga_get_property_details.',
        );
      }

      type ChangeHistoryEvent = z.infer<typeof changeHistoryEventSchema>;

      // Follow every page — the previous single-shot request silently
      // truncated the history at the first 100 events. The page cap keeps a
      // misbehaving upstream from looping forever; hitting it is an
      // observable error, never a silent truncation.
      const events: ChangeHistoryEvent[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      do {
        pages += 1;
        if (pages > MAX_LIST_PAGES) {
          paginationLimitExceeded('changeHistoryEvents');
        }
        const response = parseApiResponse(
          changeHistoryResponseSchema,
          await googleApi(`/${accountPath(parentAccount)}:searchChangeHistoryEvents`, {
            method: 'POST',
            body: {
              resourceType: ['PROPERTY'],
              action: ['CREATED', 'UPDATED', 'DELETED'],
              property,
              pageSize: 100,
              pageToken,
            },
            baseUrl: Bases.adminAlpha,
          }),
          'searchChangeHistoryEvents',
        );
        events.push(...(response.changeHistoryEvents || []));
        pageToken = response.nextPageToken || undefined;
      } while (pageToken);

      return JSON.stringify({
        ok: true,
        property,
        account: parentAccount,
        changeHistoryEvents: events.map((event) => ({
          id: event.id || null,
          changeTime: event.changeTime || null,
          actorType: event.actorType || null,
          userActorEmail: wrapUntrusted(event.userActorEmail, UNTRUSTED_SOURCES.admin) || null,
          changesFiltered: (event.changes || []).map((change) => ({
            action: change.action || null,
            resource: change.resource || null,
            // Arbitrary resource snapshot authored in the external system —
            // enveloped wholesale rather than field-enumerated.
            resourceAfterChange: change.resourceAfterChange
              ? wrapUntrustedJsonStrings(change.resourceAfterChange, UNTRUSTED_SOURCES.admin)
              : null,
          })),
        })),
      });
    }),
  );
}
