/**
 * QuickBooks customer tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeQboql } from '../utils.js';
import { qboFetch, qboQuery } from '../client.js';

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
        limit: z.number().optional().describe('Max results (default: 50)'),
      }),
      annotations: { readOnlyHint: true },
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
      const customers = await qboQuery('Customer', query, limit);
      return JSON.stringify({ ok: true, customers, count: customers.length });
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
        email: z.string().optional().describe('Primary email address'),
        phone: z.string().optional().describe('Primary phone number'),
        companyName: z.string().optional().describe('Company name'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      const customerBody: Record<string, unknown> = { DisplayName: args.displayName };
      if (args.email) customerBody.PrimaryEmailAddr = { Address: args.email };
      if (args.phone) customerBody.PrimaryPhone = { FreeFormNumber: args.phone };
      if (args.companyName) customerBody.CompanyName = args.companyName;

      const result = await qboFetch<{ Customer: Record<string, unknown> }>(
        '/customer?minorversion=65',
        { method: 'POST', body: JSON.stringify(customerBody) },
      );
      return JSON.stringify({ ok: true, message: 'Customer created.', customer: result.Customer });
    }),
  );
}
