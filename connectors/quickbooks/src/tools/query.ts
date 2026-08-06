/**
 * QuickBooks query and entity retrieval tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import { qboFetch, qboQueryPage, truncationNote } from '../client.js';
import { QBO_MINOR_VERSION } from '../types.js';
import { wrapUntrustedJsonStrings } from '../untrusted-content.js';

export function registerQueryTools(server: McpServer): void {
  server.registerTool(
    'query_quickbooks',
    {
      description: `Run a QuickBooks query using the QuickBooks Query Language.

Returns matching entities. QuickBooks uses a SQL-like query language.

Example: { "query": "SELECT * FROM Invoice WHERE Balance > '0' ORDERBY DueDate" }
Example: { "query": "SELECT * FROM Customer WHERE Active = true" }

WORKFLOW:
1. Use this for flexible searches across any entity type
2. Entity names are PascalCase: Invoice, Customer, Vendor, Bill, Employee, etc.
3. String values use single quotes, dates use 'YYYY-MM-DD' format

COMMON MISTAKES:
- Entity names are case-sensitive PascalCase (Invoice, not invoice)
- Use single quotes for string/date values, not double quotes
- LIKE operator uses % wildcard: DisplayName LIKE '%Smith%'`,
      inputSchema: z.object({
        query: z.string().describe('QuickBooks Query Language statement'),
        limit: z.number().int().positive().optional().describe('Max results (default: 100, max: 1000)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const query = args.query;
      const limit = Math.min(args.limit ?? 100, 1000);

      // Extract entity name from query for response parsing
      const entityMatch = query.match(/FROM\s+(\w+)/i);
      const entityName = entityMatch ? entityMatch[1] : 'Unknown';
      const page = await qboQueryPage(entityName, query, limit);
      // Arbitrary entity shape: envelope every string value wholesale.
      return JSON.stringify({
        ok: true,
        entity: entityName,
        data: wrapUntrustedJsonStrings(page.rows, 'quickbooks:query_quickbooks'),
        count: page.rows.length,
        hasMore: page.hasMore,
        ...(page.hasMore ? { note: truncationNote(limit) } : {}),
      });
    }),
  );

  server.registerTool(
    'get_quickbooks_entity',
    {
      description: `Get a single QuickBooks entity by type and ID.

Example: { "entityType": "Invoice", "entityId": "123" }

Supported entity types: Account, Bill, BillPayment, Customer, Employee, Estimate, Invoice, Item, JournalEntry, Purchase, Vendor`,
      inputSchema: z.object({
        entityType: z.enum([
          'Account', 'Bill', 'BillPayment', 'Customer', 'Employee',
          'Estimate', 'Invoice', 'Item', 'JournalEntry', 'Purchase', 'Vendor',
        ]).describe('Entity type (PascalCase)'),
        entityId: z.string().describe('Entity ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const { entityType, entityId } = args;
      const result = await qboFetch<Record<string, unknown>>(
        `/${entityType.toLowerCase()}/${encodeURIComponent(entityId)}?minorversion=${QBO_MINOR_VERSION}`,
      );
      // Arbitrary entity shape: envelope every string value wholesale.
      return JSON.stringify({
        ok: true,
        [entityType]: wrapUntrustedJsonStrings(
          result[entityType] || result,
          `quickbooks:get_quickbooks_entity:${entityType}`,
        ),
      });
    }),
  );
}
