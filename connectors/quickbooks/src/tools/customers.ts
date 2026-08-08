/**
 * QuickBooks customer tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeQboql, validateAlphanumericId } from '../utils.js';
import { qboFetch, qboQueryPage, qboSparseUpdate, truncationNote } from '../client.js';
import { QBO_MINOR_VERSION, QuickBooksError } from '../types.js';
import { sanitizeQboEntity } from '../sanitize.js';

export function registerCustomerTools(server: McpServer): void {
  server.registerTool(
    'list_quickbooks_customers',
    {
      description: `List customers from QuickBooks Online.

Returns: Id, DisplayName, PrimaryEmailAddr, PrimaryPhone, Balance, Active.

Example: {}
Example: { "active": true }
Example: { "searchTerm": "Smith" }`,
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
      const query = `SELECT * FROM Customer${where} ORDERBY DisplayName`;
      const page = await qboQueryPage('Customer', query, limit);
      return JSON.stringify({
        ok: true,
        customers: sanitizeQboEntity(page.rows, 'quickbooks:list_quickbooks_customers'),
        count: page.rows.length,
        hasMore: page.hasMore,
        ...(page.hasMore ? { note: truncationNote(limit) } : {}),
      });
    }),
  );

  server.registerTool(
    'create_quickbooks_customer',
    {
      description: `Create a new customer in QuickBooks Online.

Example: { "displayName": "Acme Corp" }
Example: { "displayName": "Jane Smith", "email": "jane@smith.com", "phone": "555-1234" }`,
      inputSchema: z.object({
        displayName: z.string().describe('Customer display name (required, must be unique)'),
        email: z.string().email().optional().describe('Primary email address'),
        phone: z.string().optional().describe('Primary phone number'),
        companyName: z.string().optional().describe('Company name'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const customerBody: Record<string, unknown> = { DisplayName: args.displayName };
      if (args.email) customerBody.PrimaryEmailAddr = { Address: args.email };
      if (args.phone) customerBody.PrimaryPhone = { FreeFormNumber: args.phone };
      if (args.companyName) customerBody.CompanyName = args.companyName;

      const result = await qboFetch<{ Customer: Record<string, unknown> }>(
        `/customer?minorversion=${QBO_MINOR_VERSION}`,
        { method: 'POST', body: JSON.stringify(customerBody) },
      );
      return JSON.stringify({
        ok: true,
        message: 'Customer created.',
        customer: sanitizeQboEntity(result.Customer, 'quickbooks:create_quickbooks_customer'),
      });
    }),
  );

  server.registerTool(
    'update_quickbooks_customer',
    {
      description: `Sparse-update an existing customer in QuickBooks Online.

Example: { "customerId": "123", "email": "ap@example.com" }
Example: { "customerId": "123", "active": false }

If syncToken is omitted the customer is read
first to obtain the current one (QuickBooks rejects stale SyncTokens).
Setting active to false deactivates the customer.`,
      inputSchema: z.object({
        customerId: z.string().describe('Customer ID (required)'),
        syncToken: z.string().optional()
          .describe('Current SyncToken (omit to read it from QuickBooks first)'),
        displayName: z.string().optional().describe('New display name'),
        email: z.string().email().optional().describe('New primary email address'),
        phone: z.string().optional().describe('New primary phone number'),
        companyName: z.string().optional().describe('New company name'),
        active: z.boolean().optional().describe('Set false to deactivate the customer'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      validateAlphanumericId(args.customerId, 'customerId');

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

      const customer = await qboSparseUpdate('customer', 'Customer', args.customerId, args.syncToken, fields);
      return JSON.stringify({
        ok: true,
        message: 'Customer updated.',
        customer: sanitizeQboEntity(customer, 'quickbooks:update_quickbooks_customer'),
      });
    }),
  );
}
