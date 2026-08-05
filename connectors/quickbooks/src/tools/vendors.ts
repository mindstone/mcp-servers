/**
 * QuickBooks vendor tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeQboql, requireProdWritesEnabled } from '../utils.js';
import { qboFetch, qboQuery } from '../client.js';
import { QBO_MINOR_VERSION } from '../types.js';

export function registerVendorTools(server: McpServer): void {
  server.registerTool(
    'list_quickbooks_vendors',
    {
      description: `List vendors from QuickBooks Online.

Returns: Id, DisplayName, PrimaryEmailAddr, PrimaryPhone, Balance, Active.

Example: {}
Example: { "searchTerm": "Office" }`,
      inputSchema: z.object({
        active: z.boolean().optional().describe('Filter by active status'),
        searchTerm: z.string().optional().describe('Search by display name (partial match)'),
        limit: z.number().optional().describe('Max results (default: 50)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const limit = Math.min(args.limit ?? 50, 1000);
      const conditions: string[] = [];

      if (args.active !== undefined) conditions.push(`Active = ${args.active}`);
      if (args.searchTerm) {
        conditions.push(`DisplayName LIKE '%${escapeQboql(args.searchTerm)}%'`);
      }

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
      const query = `SELECT * FROM Vendor${where} ORDERBY DisplayName`;
      const vendors = await qboQuery('Vendor', query, limit);
      return JSON.stringify({ ok: true, vendors, count: vendors.length });
    }),
  );

  server.registerTool(
    'create_quickbooks_vendor',
    {
      description: `Create a new vendor in QuickBooks Online.

Example: { "displayName": "Office Depot" }
Example: { "displayName": "AWS", "email": "billing@aws.amazon.com", "companyName": "Amazon Web Services" }`,
      inputSchema: z.object({
        displayName: z.string().describe('Vendor display name (required, must be unique)'),
        email: z.string().optional().describe('Primary email address'),
        phone: z.string().optional().describe('Primary phone number'),
        companyName: z.string().optional().describe('Company name'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireProdWritesEnabled();
      const vendorBody: Record<string, unknown> = { DisplayName: args.displayName };
      if (args.email) vendorBody.PrimaryEmailAddr = { Address: args.email };
      if (args.phone) vendorBody.PrimaryPhone = { FreeFormNumber: args.phone };
      if (args.companyName) vendorBody.CompanyName = args.companyName;

      const result = await qboFetch<{ Vendor: Record<string, unknown> }>(
        `/vendor?minorversion=${QBO_MINOR_VERSION}`,
        { method: 'POST', body: JSON.stringify(vendorBody) },
      );
      return JSON.stringify({ ok: true, message: 'Vendor created.', vendor: result.Vendor });
    }),
  );
}
