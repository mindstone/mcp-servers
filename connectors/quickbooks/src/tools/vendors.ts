/**
 * QuickBooks vendor tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeQboql, validateAlphanumericId } from '../utils.js';
import { qboFetch, qboQueryPage, qboSparseUpdate, truncationNote } from '../client.js';
import { QBO_MINOR_VERSION, QuickBooksError } from '../types.js';
import { sanitizeQboEntity } from '../sanitize.js';

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
        limit: z.number().int().positive().optional().describe('Max results (default: 50)'),
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
      const page = await qboQueryPage('Vendor', query, limit);
      return JSON.stringify({
        ok: true,
        vendors: sanitizeQboEntity(page.rows, 'quickbooks:list_quickbooks_vendors'),
        count: page.rows.length,
        hasMore: page.hasMore,
        ...(page.hasMore ? { note: truncationNote(limit) } : {}),
      });
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
        email: z.string().email().optional().describe('Primary email address'),
        phone: z.string().optional().describe('Primary phone number'),
        companyName: z.string().optional().describe('Company name'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const vendorBody: Record<string, unknown> = { DisplayName: args.displayName };
      if (args.email) vendorBody.PrimaryEmailAddr = { Address: args.email };
      if (args.phone) vendorBody.PrimaryPhone = { FreeFormNumber: args.phone };
      if (args.companyName) vendorBody.CompanyName = args.companyName;

      const result = await qboFetch<{ Vendor: Record<string, unknown> }>(
        `/vendor?minorversion=${QBO_MINOR_VERSION}`,
        { method: 'POST', body: JSON.stringify(vendorBody) },
      );
      return JSON.stringify({
        ok: true,
        message: 'Vendor created.',
        vendor: sanitizeQboEntity(result.Vendor, 'quickbooks:create_quickbooks_vendor'),
      });
    }),
  );

  server.registerTool(
    'update_quickbooks_vendor',
    {
      description: `Sparse-update an existing vendor in QuickBooks Online.

Example: { "vendorId": "123", "email": "ap@example.com" }
Example: { "vendorId": "123", "active": false }

If syncToken is omitted the vendor is read
first to obtain the current one (QuickBooks rejects stale SyncTokens).
Setting active to false deactivates the vendor.`,
      inputSchema: z.object({
        vendorId: z.string().describe('Vendor ID (required)'),
        syncToken: z.string().optional()
          .describe('Current SyncToken (omit to read it from QuickBooks first)'),
        displayName: z.string().optional().describe('New display name'),
        email: z.string().email().optional().describe('New primary email address'),
        phone: z.string().optional().describe('New primary phone number'),
        companyName: z.string().optional().describe('New company name'),
        active: z.boolean().optional().describe('Set false to deactivate the vendor'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      validateAlphanumericId(args.vendorId, 'vendorId');

      const fields: Record<string, unknown> = {};
      if (args.displayName) fields.DisplayName = args.displayName;
      if (args.email) fields.PrimaryEmailAddr = { Address: args.email };
      if (args.phone) fields.PrimaryPhone = { FreeFormNumber: args.phone };
      if (args.companyName) fields.CompanyName = args.companyName;
      if (args.active !== undefined) fields.Active = args.active;
      if (Object.keys(fields).length === 0) {
        throw new QuickBooksError(
          'Nothing to update: provide at least one of displayName, email, phone, companyName, active.',
          'INVALID_INPUT',
          'Pass at least one field to update.',
        );
      }

      const vendor = await qboSparseUpdate('vendor', 'Vendor', args.vendorId, args.syncToken, fields);
      return JSON.stringify({
        ok: true,
        message: 'Vendor updated.',
        vendor: sanitizeQboEntity(vendor, 'quickbooks:update_quickbooks_vendor'),
      });
    }),
  );
}
