/**
 * Write tools for how a property is set up: the property itself, data
 * streams, enhanced measurement, Measurement Protocol secrets, product links
 * (Google Ads, Firebase, BigQuery), and data retention.
 * All writes are gated by GA4_ALLOW_WRITES (see ../writes.ts).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { accountPath, Bases, googleApi, propertyPath } from '../client.js';
import { wrapUntrustedJsonStrings } from '../untrusted-content.js';
import { parseApiResponse, UNTRUSTED_SOURCES, withErrorHandling } from '../utils.js';
import {
  adminGet,
  adminWrite,
  buildPatch,
  confirmArg,
  dataStreamPath,
  optionalPropertyIdArg,
  propertyChildPath,
  propertyIdArg,
  READ_ONLY,
  streamChildPath,
  WRITE,
  WRITE_NOTE,
} from '../writes.js';

/**
 * Google requires this exact sentence before Measurement Protocol secrets
 * can be created on a property.
 */
const USER_DATA_ACKNOWLEDGEMENT =
  'I acknowledge that I have the necessary privacy disclosures and rights from my end users for the collection and processing of their data, including the association of such data with the visitation information Google Analytics collects from my site and/or app property.';

const dataStreamId = z
  .string()
  .describe('Data stream ID or full resource name (from ga_list_data_streams).');

const currencyCode = z.string().length(3).describe('ISO 4217 currency code, e.g. GBP.');
const timeZone = z.string().min(1).describe('IANA time zone, e.g. Europe/London.');
const industryCategory = z
  .string()
  .regex(/^[A-Z_]+$/)
  .describe('GA4 IndustryCategory enum value, e.g. TECHNOLOGY or JOBS_AND_EDUCATION.');

const retention = z.enum([
  'TWO_MONTHS',
  'FOURTEEN_MONTHS',
  'TWENTY_SIX_MONTHS',
  'THIRTY_EIGHT_MONTHS',
  'FIFTY_MONTHS',
]);

const secretListSchema = z
  .object({
    measurementProtocolSecrets: z
      .array(z.object({ name: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

const enhancedMeasurementShape = {
  stream_enabled: z.boolean().optional().describe('Master switch for enhanced measurement.'),
  scrolls_enabled: z.boolean().optional(),
  outbound_clicks_enabled: z.boolean().optional(),
  site_search_enabled: z.boolean().optional(),
  video_engagement_enabled: z.boolean().optional(),
  file_downloads_enabled: z.boolean().optional(),
  page_changes_enabled: z.boolean().optional().describe('Page views on browser history changes.'),
  form_interactions_enabled: z.boolean().optional(),
  search_query_parameter: z
    .string()
    .optional()
    .describe('Comma-separated URL query parameters read as site search terms, e.g. q,s,search.'),
  uri_query_parameter: z.string().optional().describe('Extra query parameters for site search.'),
};

export function registerConfigWriteTools(server: McpServer): void {
  // --- Property ----------------------------------------------------------

  server.registerTool(
    'ga_create_property',
    {
      description: `Create a GA4 property under an account. ${WRITE_NOTE}`,
      inputSchema: {
        account_id: z.string().describe('Account ID, with or without the accounts/ prefix.'),
        display_name: z.string().min(1).max(100),
        time_zone: timeZone,
        currency_code: currencyCode.optional(),
        industry_category: industryCategory.optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: 'properties',
        action: 'properties.create',
        body: {
          parent: accountPath(args.account_id),
          displayName: args.display_name,
          timeZone: args.time_zone,
          currencyCode: args.currency_code,
          industryCategory: args.industry_category,
        },
      }),
    ),
  );

  server.registerTool(
    'ga_update_property',
    {
      description: `Update a property's display name, time zone, currency, or industry category. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        display_name: z.string().min(1).max(100).optional(),
        time_zone: timeZone.optional(),
        currency_code: currencyCode.optional(),
        industry_category: industryCategory.optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        displayName: args.display_name,
        timeZone: args.time_zone,
        currencyCode: args.currency_code,
        industryCategory: args.industry_category,
      });
      return adminWrite({
        method: 'PATCH',
        path: propertyPath(args.property_id),
        action: 'properties.patch',
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_delete_property',
    {
      description: `Move a property to the trash. Google permanently deletes it after 35 days unless it is restored in the GA4 UI. ${WRITE_NOTE}`,
      inputSchema: { property_id: propertyIdArg, confirm: confirmArg },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'DELETE',
        path: propertyPath(args.property_id),
        action: 'properties.delete',
      }),
    ),
  );

  server.registerTool(
    'ga_acknowledge_user_data_collection',
    {
      description: `Accept Google's user-data collection terms for a property, which GA4 requires before Measurement Protocol secrets can be created. This is a legal acknowledgement on behalf of the property owner; only call it when a person has agreed to it. ${WRITE_NOTE}`,
      inputSchema: { property_id: propertyIdArg, confirm: confirmArg },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyPath(args.property_id)}:acknowledgeUserDataCollection`,
        action: 'properties.acknowledgeUserDataCollection',
        body: { acknowledgement: USER_DATA_ACKNOWLEDGEMENT },
      }),
    ),
  );

  // --- Data streams ------------------------------------------------------

  server.registerTool(
    'ga_create_web_data_stream',
    {
      description: `Create a web data stream on a property. The response includes the new measurement ID (G-...). ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        display_name: z.string().min(1),
        default_uri: z.string().url().describe('Website URL, e.g. https://www.example.com.'),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyPath(args.property_id)}/dataStreams`,
        action: 'dataStreams.create',
        body: {
          type: 'WEB_DATA_STREAM',
          displayName: args.display_name,
          webStreamData: { defaultUri: args.default_uri },
        },
      }),
    ),
  );

  server.registerTool(
    'ga_update_data_stream',
    {
      description: `Rename a data stream or change a web stream's website URL. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        data_stream: dataStreamId,
        display_name: z.string().min(1).optional(),
        default_uri: z.string().url().optional().describe('Web streams only.'),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch(
        {
          displayName: args.display_name,
          webStreamData: args.default_uri ? { defaultUri: args.default_uri } : undefined,
        },
        { webStreamData: 'webStreamData.defaultUri' },
      );
      return adminWrite({
        method: 'PATCH',
        path: dataStreamPath(args.property_id, args.data_stream),
        action: 'dataStreams.patch',
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_delete_data_stream',
    {
      description: `Delete a data stream. Data collection through its measurement ID stops immediately and cannot be restored. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        data_stream: dataStreamId,
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'DELETE',
        path: dataStreamPath(args.property_id, args.data_stream),
        action: 'dataStreams.delete',
      }),
    ),
  );

  // --- Enhanced measurement (v1alpha) ------------------------------------

  server.registerTool(
    'ga_get_enhanced_measurement_settings',
    {
      description:
        'Get the enhanced measurement settings (automatic scroll, outbound click, site search, video, file download, and form events) for a web data stream. Uses the v1alpha Admin API.',
      inputSchema: { property_id: optionalPropertyIdArg, data_stream: dataStreamId },
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) =>
      adminGet(
        `${dataStreamPath(args.property_id, args.data_stream)}/enhancedMeasurementSettings`,
        'enhancedMeasurementSettings.get',
        true,
      ),
    ),
  );

  server.registerTool(
    'ga_update_enhanced_measurement_settings',
    {
      description: `Turn enhanced measurement events on or off for a web data stream. Only the fields you pass change. Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        data_stream: dataStreamId,
        ...enhancedMeasurementShape,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        streamEnabled: args.stream_enabled,
        scrollsEnabled: args.scrolls_enabled,
        outboundClicksEnabled: args.outbound_clicks_enabled,
        siteSearchEnabled: args.site_search_enabled,
        videoEngagementEnabled: args.video_engagement_enabled,
        fileDownloadsEnabled: args.file_downloads_enabled,
        pageChangesEnabled: args.page_changes_enabled,
        formInteractionsEnabled: args.form_interactions_enabled,
        searchQueryParameter: args.search_query_parameter,
        uriQueryParameter: args.uri_query_parameter,
      });
      return adminWrite({
        method: 'PATCH',
        path: `${dataStreamPath(args.property_id, args.data_stream)}/enhancedMeasurementSettings`,
        action: 'enhancedMeasurementSettings.patch',
        alpha: true,
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  // --- Measurement Protocol secrets --------------------------------------

  server.registerTool(
    'ga_list_measurement_protocol_secrets',
    {
      description:
        'List the Measurement Protocol API secrets on a data stream. Secret values are returned, so treat the output as sensitive.',
      inputSchema: { property_id: optionalPropertyIdArg, data_stream: dataStreamId },
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const stream = dataStreamPath(args.property_id, args.data_stream);
      const response = parseApiResponse(
        secretListSchema,
        (await googleApi(`/${stream}/measurementProtocolSecrets`, {
          query: { pageSize: 200 },
          baseUrl: Bases.admin,
        })) ?? {},
        'measurementProtocolSecrets.list',
      );
      return JSON.stringify({
        ok: true,
        dataStream: stream,
        measurementProtocolSecrets: (response.measurementProtocolSecrets ?? []).map((secret) => ({
          name: secret.name ?? null,
          secret: wrapUntrustedJsonStrings(secret, UNTRUSTED_SOURCES.admin),
        })),
      });
    }),
  );

  server.registerTool(
    'ga_create_measurement_protocol_secret',
    {
      description: `Create a Measurement Protocol API secret for sending server-side events to a data stream. The property must have accepted ga_acknowledge_user_data_collection first. The secret value is returned; treat it as sensitive. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        data_stream: dataStreamId,
        display_name: z.string().min(1),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${dataStreamPath(args.property_id, args.data_stream)}/measurementProtocolSecrets`,
        action: 'measurementProtocolSecrets.create',
        body: { displayName: args.display_name },
      }),
    ),
  );

  server.registerTool(
    'ga_delete_measurement_protocol_secret',
    {
      description: `Delete a Measurement Protocol API secret. Servers still using it stop being able to send events. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        data_stream: dataStreamId,
        secret: z.string().describe('Secret ID or full resource name (from ga_list_measurement_protocol_secrets).'),
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'DELETE',
        path: streamChildPath(args.property_id, args.data_stream, args.secret, 'measurementProtocolSecrets', 'secret ID'),
        action: 'measurementProtocolSecrets.delete',
      }),
    ),
  );

  // --- Google Ads links --------------------------------------------------

  server.registerTool(
    'ga_create_google_ads_link',
    {
      description: `Link a Google Ads account to the property so key events and audiences flow to Ads. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        customer_id: z
          .string()
          .regex(/^\d{10}$/)
          .describe('Google Ads customer ID, 10 digits without dashes.'),
        ads_personalization_enabled: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyPath(args.property_id)}/googleAdsLinks`,
        action: 'googleAdsLinks.create',
        body: {
          customerId: args.customer_id,
          adsPersonalizationEnabled: args.ads_personalization_enabled,
        },
      }),
    ),
  );

  server.registerTool(
    'ga_update_google_ads_link',
    {
      description: `Turn ads personalization on or off for a Google Ads link. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        google_ads_link: z.string().describe('Link ID or full resource name (from ga_list_google_ads_links).'),
        ads_personalization_enabled: z.boolean(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({ adsPersonalizationEnabled: args.ads_personalization_enabled });
      return adminWrite({
        method: 'PATCH',
        path: propertyChildPath(args.property_id, args.google_ads_link, 'googleAdsLinks', 'Google Ads link ID'),
        action: 'googleAdsLinks.patch',
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_delete_google_ads_link',
    {
      description: `Unlink a Google Ads account from the property. Key event imports and shared audiences stop updating in Ads. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        google_ads_link: z.string().describe('Link ID or full resource name.'),
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'DELETE',
        path: propertyChildPath(args.property_id, args.google_ads_link, 'googleAdsLinks', 'Google Ads link ID'),
        action: 'googleAdsLinks.delete',
      }),
    ),
  );

  // --- Firebase links ----------------------------------------------------

  server.registerTool(
    'ga_create_firebase_link',
    {
      description: `Link a Firebase project to the property. A property can have at most one Firebase link. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        project: z
          .string()
          .regex(/^projects\/[A-Za-z0-9_-]+$/)
          .describe('Firebase project as projects/<number or id>.'),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyPath(args.property_id)}/firebaseLinks`,
        action: 'firebaseLinks.create',
        body: { project: args.project },
      }),
    ),
  );

  server.registerTool(
    'ga_delete_firebase_link',
    {
      description: `Remove the Firebase project link from the property. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        firebase_link: z.string().describe('Link ID or full resource name (from ga_list_firebase_links).'),
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'DELETE',
        path: propertyChildPath(args.property_id, args.firebase_link, 'firebaseLinks', 'Firebase link ID'),
        action: 'firebaseLinks.delete',
      }),
    ),
  );

  // --- BigQuery links (v1alpha) ------------------------------------------

  server.registerTool(
    'ga_create_bigquery_link',
    {
      description: `Start exporting the property's raw events to a BigQuery project. Exports incur BigQuery storage and query costs in that project. Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        project: z
          .string()
          .regex(/^projects\/[A-Za-z0-9_-]+$/)
          .describe('Destination Google Cloud project as projects/<number or id>.'),
        dataset_location: z.string().min(1).describe('BigQuery dataset location, e.g. EU or europe-west2.'),
        daily_export_enabled: z.boolean().optional(),
        streaming_export_enabled: z.boolean().optional(),
        fresh_daily_export_enabled: z.boolean().optional().describe('GA4 360 only.'),
        include_advertising_id: z.boolean().optional(),
        export_streams: z
          .array(z.string())
          .optional()
          .describe('Data stream resource names to export. Defaults to all streams.'),
        excluded_events: z.array(z.string()).optional().describe('Event names to leave out of the export.'),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'POST',
        path: `${propertyPath(args.property_id)}/bigQueryLinks`,
        action: 'bigQueryLinks.create',
        alpha: true,
        body: {
          project: args.project,
          datasetLocation: args.dataset_location,
          dailyExportEnabled: args.daily_export_enabled,
          streamingExportEnabled: args.streaming_export_enabled,
          freshDailyExportEnabled: args.fresh_daily_export_enabled,
          includeAdvertisingId: args.include_advertising_id,
          exportStreams: args.export_streams,
          excludedEvents: args.excluded_events,
        },
      }),
    ),
  );

  server.registerTool(
    'ga_update_bigquery_link',
    {
      description: `Change which exports a BigQuery link runs, or which events and streams it includes. Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        bigquery_link: z.string().describe('Link ID or full resource name (from ga_list_bigquery_links).'),
        daily_export_enabled: z.boolean().optional(),
        streaming_export_enabled: z.boolean().optional(),
        fresh_daily_export_enabled: z.boolean().optional(),
        include_advertising_id: z.boolean().optional(),
        export_streams: z.array(z.string()).optional(),
        excluded_events: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        dailyExportEnabled: args.daily_export_enabled,
        streamingExportEnabled: args.streaming_export_enabled,
        freshDailyExportEnabled: args.fresh_daily_export_enabled,
        includeAdvertisingId: args.include_advertising_id,
        exportStreams: args.export_streams,
        excludedEvents: args.excluded_events,
      });
      return adminWrite({
        method: 'PATCH',
        path: propertyChildPath(args.property_id, args.bigquery_link, 'bigQueryLinks', 'BigQuery link ID'),
        action: 'bigQueryLinks.patch',
        alpha: true,
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );

  server.registerTool(
    'ga_delete_bigquery_link',
    {
      description: `Stop the BigQuery export. Data already exported stays in BigQuery. Uses the v1alpha Admin API. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: optionalPropertyIdArg,
        bigquery_link: z.string().describe('Link ID or full resource name.'),
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) =>
      adminWrite({
        method: 'DELETE',
        path: propertyChildPath(args.property_id, args.bigquery_link, 'bigQueryLinks', 'BigQuery link ID'),
        action: 'bigQueryLinks.delete',
        alpha: true,
      }),
    ),
  );

  // --- Data retention ----------------------------------------------------

  server.registerTool(
    'ga_update_data_retention_settings',
    {
      description: `Change how long GA4 keeps user-level event data (affects explorations, not standard reports). Shortening retention deletes older data and cannot be undone. ${WRITE_NOTE}`,
      inputSchema: {
        property_id: propertyIdArg,
        event_data_retention: retention.optional(),
        reset_user_data_on_new_activity: z
          .boolean()
          .optional()
          .describe('Restart the retention period each time a user is active.'),
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrorHandling(async (args) => {
      const patch = buildPatch({
        eventDataRetention: args.event_data_retention,
        resetUserDataOnNewActivity: args.reset_user_data_on_new_activity,
      });
      return adminWrite({
        method: 'PATCH',
        path: `${propertyPath(args.property_id)}/dataRetentionSettings`,
        action: 'dataRetentionSettings.patch',
        body: patch.body,
        query: { updateMask: patch.updateMask },
      });
    }),
  );
}
