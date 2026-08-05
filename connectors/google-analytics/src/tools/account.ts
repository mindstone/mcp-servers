/**
 * Account- and property-level tools.
 * All read-only.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { googleApi, paginate, propertyPath } from '../client.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { UNTRUSTED_SOURCES, withErrorHandling } from '../utils.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

interface AccountSummary {
  account?: string;
  displayName?: string;
  propertySummaries?: Array<{
    property?: string;
    displayName?: string;
    propertyType?: string;
    parent?: string;
  }>;
}

async function listAccountSummariesRaw(): Promise<AccountSummary[]> {
  return paginate<AccountSummary>('/accountSummaries', {
    itemKey: 'accountSummaries',
    query: { pageSize: 200 },
  });
}

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    'ga_list_account_summaries',
    {
      description:
        'List Google Analytics accounts and their property summaries available to the authenticated user. Use this first to discover available property IDs before calling other tools.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    withErrorHandling(async () => {
      const accountSummaries = await listAccountSummariesRaw();
      return JSON.stringify({
        ok: true,
        accountSummaries: accountSummaries.map((summary) => ({
          account: summary.account,
          displayName: wrapUntrusted(summary.displayName, UNTRUSTED_SOURCES.admin),
          propertySummaries: (summary.propertySummaries || []).map((property) => ({
            property: property.property,
            displayName: wrapUntrusted(property.displayName, UNTRUSTED_SOURCES.admin),
            propertyType: property.propertyType,
            parent: property.parent,
          })),
        })),
      });
    }),
  );

  server.registerTool(
    'ga_list_properties',
    {
      description:
        'List GA4 properties visible to the authenticated user, optionally filtered by account_id or property_id. Returns a flat list — easier to consume than ga_list_account_summaries when you just want property IDs.',
      inputSchema: z.object({
        account_id: z
          .string()
          .optional()
          .describe('Optional account ID, with or without the accounts/ prefix.'),
        property_id: z
          .string()
          .optional()
          .describe('Optional property ID, with or without the properties/ prefix.'),
      }),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const summaries = await listAccountSummariesRaw();
      const accountFilter = args.account_id
        ? String(args.account_id).replace(/^accounts\//, '')
        : null;
      const propertyFilter = args.property_id
        ? String(args.property_id).replace(/^properties\//, '')
        : null;

      const properties = summaries
        .flatMap((accountSummary) => {
          const accountId =
            accountSummary.account?.replace(/^accounts\//, '') || null;
          if (accountFilter && accountId !== accountFilter) return [];
          return (accountSummary.propertySummaries || []).map((property) => ({
            account_id: accountId,
            account_name: wrapUntrusted(accountSummary.displayName, UNTRUSTED_SOURCES.admin),
            property_id: property.property?.replace(/^properties\//, '') || null,
            property_name: wrapUntrusted(property.displayName, UNTRUSTED_SOURCES.admin),
            property_type: property.propertyType || null,
            parent: property.parent || null,
          }));
        })
        .filter((item) => !propertyFilter || item.property_id === propertyFilter);

      return JSON.stringify({ ok: true, properties });
    }),
  );

  server.registerTool(
    'ga_get_property_details',
    {
      description:
        'Get details for a single GA4 property — display name, currency code, configured time zone, industry category, service level, and timestamps.',
      inputSchema: z.object({
        property_id: z
          .string()
          .describe('GA4 property ID, with or without the properties/ prefix.'),
      }),
      annotations: READ_ONLY,
    },
    withErrorHandling(async (args) => {
      const property = await googleApi<{
        name?: string;
        displayName?: string;
        propertyType?: string;
        parent?: string;
        currencyCode?: string;
        timeZone?: string;
        industryCategory?: string;
        serviceLevel?: string;
        createTime?: string;
        updateTime?: string;
        deleted?: boolean;
      }>(`/${propertyPath(args.property_id)}`);

      return JSON.stringify({
        ok: true,
        property_id: property.name?.replace(/^properties\//, '') || null,
        displayName: wrapUntrusted(property.displayName, UNTRUSTED_SOURCES.admin) || null,
        propertyType: property.propertyType || null,
        parent: property.parent || null,
        currencyCode: property.currencyCode || null,
        timeZone: property.timeZone || null,
        industryCategory: property.industryCategory || null,
        serviceLevel: property.serviceLevel || null,
        createTime: property.createTime || null,
        updateTime: property.updateTime || null,
        deleted: property.deleted || false,
      });
    }),
  );
}
