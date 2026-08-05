/**
 * Admin visibility tools — custom dimensions/metrics, ads/key event/data
 * stream listings, BigQuery / Firebase links, data retention, change
 * history. Read-only.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { googleApi, paginate, propertyPath, accountPath, Bases } from '../client.js';
import { GoogleAnalyticsError } from '../types.js';
import { wrapUntrusted, wrapUntrustedJsonStrings } from '../untrusted-content.js';
import { UNTRUSTED_SOURCES, withErrorHandling } from '../utils.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const requiredPropertyId = z.object({
  property_id: z.string().describe('GA4 property ID, with or without the properties/ prefix.'),
});

interface CustomDimension {
  name?: string;
  parameterName?: string;
  displayName?: string;
  description?: string;
  scope?: string;
  disallowAdsPersonalization?: boolean;
}

interface CustomMetric {
  name?: string;
  parameterName?: string;
  displayName?: string;
  description?: string;
  measurementUnit?: string;
  restrictedMetricType?: string[];
}

interface DataStream {
  name?: string;
  displayName?: string;
  type?: string;
  createTime?: string;
  updateTime?: string;
  webStreamData?: { defaultUri?: string; measurementId?: string };
  androidAppStreamData?: unknown;
  iosAppStreamData?: unknown;
}

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
        paginate<CustomDimension>(`/${property}/customDimensions`, {
          itemKey: 'customDimensions',
          query: { pageSize: 200 },
        }),
        paginate<CustomMetric>(`/${property}/customMetrics`, {
          itemKey: 'customMetrics',
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
      const links = await paginate<{
        name?: string;
        customerId?: string;
        canManageClients?: boolean;
        adsPersonalizationEnabled?: boolean;
        creatorEmailAddress?: string;
      }>(`/${property}/googleAdsLinks`, {
        itemKey: 'googleAdsLinks',
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
      const keyEvents = await paginate<{
        name?: string;
        eventName?: string;
        createTime?: string;
        countingMethod?: string;
        defaultValue?: unknown;
        deletable?: boolean;
      }>(`/${property}/keyEvents`, {
        itemKey: 'keyEvents',
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
      const dataStreams = await paginate<DataStream>(`/${property}/dataStreams`, {
        itemKey: 'dataStreams',
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
      const audiences = await paginate<{
        name?: string;
        displayName?: string;
        description?: string;
        membershipDurationDays?: number;
        adsPersonalizationEnabled?: boolean;
        exclusionDurationMode?: string;
        filterClauses?: unknown[];
        createTime?: string;
      }>(`/${property}/audiences`, {
        itemKey: 'audiences',
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
      const channelGroups = await paginate<{
        name?: string;
        displayName?: string;
        description?: string;
        systemDefined?: boolean;
        groupingRule?: unknown[];
      }>(`/${property}/channelGroups`, {
        itemKey: 'channelGroups',
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
      const dataStreams = await paginate<DataStream>(`/${property}/dataStreams`, {
        itemKey: 'dataStreams',
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
      const response = await googleApi<{ snippet?: string; name?: string }>(
        `/${property}/dataStreams/${streamId}/globalSiteTag`,
        { baseUrl: Bases.adminAlpha },
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
      const links = await paginate<{
        name?: string;
        project?: string;
        exportStreams?: string[];
        dailyExportEnabled?: boolean;
        streamingExportEnabled?: boolean;
        freshDailyExportEnabled?: boolean;
        includeAdvertisingId?: boolean;
      }>(`/${property}/bigQueryLinks`, {
        itemKey: 'bigQueryLinks',
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
      const response = await googleApi<{
        name?: string;
        eventDataRetention?: string;
        resetUserDataOnNewActivity?: boolean;
      }>(`/${property}/dataRetentionSettings`);
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
      const links = await paginate<{
        name?: string;
        project?: string;
        createTime?: string;
      }>(`/${property}/firebaseLinks`, {
        itemKey: 'firebaseLinks',
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
        'Search the change history (created/updated/deleted) for a GA4 property. Uses the v1alpha admin API; structure may evolve over time.',
      inputSchema: requiredPropertyId.shape,
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = propertyPath(args.property_id);
      const propertyDetails = await googleApi<{ parent?: string }>(`/${property}`);
      const parentAccount = propertyDetails.parent;
      if (!parentAccount) {
        throw new GoogleAnalyticsError(
          'Property does not expose a parent account.',
          'NO_PARENT_ACCOUNT',
          'GA4 change history requires a parent account on the property record. Re-check the property with ga_get_property_details.',
        );
      }

      const response = await googleApi<{
        changeHistoryEvents?: Array<{
          id?: string;
          changeTime?: string;
          actorType?: string;
          userActorEmail?: string;
          changes?: Array<{
            action?: string;
            resource?: string;
            resourceAfterChange?: unknown;
          }>;
        }>;
      }>(`/${accountPath(parentAccount)}:searchChangeHistoryEvents`, {
        method: 'POST',
        body: {
          resourceType: ['PROPERTY'],
          action: ['CREATED', 'UPDATED', 'DELETED'],
          property,
          pageSize: 100,
        },
        baseUrl: Bases.adminAlpha,
      });

      return JSON.stringify({
        ok: true,
        property,
        account: parentAccount,
        changeHistoryEvents: (response.changeHistoryEvents || []).map((event) => ({
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
