/**
 * QuickBooks estimate (quote) tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeQboql, validateAlphanumericId, requireProdWritesEnabled, qboDate } from '../utils.js';
import { qboFetch, qboQueryPage, truncationNote } from '../client.js';
import { QBO_MINOR_VERSION } from '../types.js';
import { sanitizeQboEntity } from '../sanitize.js';

export function registerEstimateTools(server: McpServer): void {
  server.registerTool(
    'list_quickbooks_estimates',
    {
      description: `List estimates (quotes) from QuickBooks Online.

Returns: Id, DocNumber, TxnDate, ExpirationDate, TotalAmt, TxnStatus, CustomerRef, Line items.

Example: {}
Example: { "status": "Pending" }
Example: { "customerId": "123" }

WORKFLOW:
1. Call with no args to see recent estimates
2. Filter by status (Pending/Accepted/Closed/Rejected) or customer
3. Use get_quickbooks_entity with entityType "Estimate" for full details`,
      inputSchema: z.object({
        status: z.enum(['Pending', 'Accepted', 'Closed', 'Rejected']).optional()
          .describe('Filter by estimate status'),
        customerId: z.string().optional().describe('Filter by customer ID'),
        limit: z.number().int().positive().optional().describe('Max results (default: 50)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const limit = Math.min(args.limit ?? 50, 1000);
      const conditions: string[] = [];

      if (args.status) conditions.push(`TxnStatus = '${args.status}'`);
      if (args.customerId) {
        validateAlphanumericId(args.customerId, 'customerId');
        conditions.push(`CustomerRef = '${escapeQboql(args.customerId)}'`);
      }

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
      const query = `SELECT * FROM Estimate${where} ORDERBY TxnDate DESC`;
      const page = await qboQueryPage('Estimate', query, limit);
      return JSON.stringify({
        ok: true,
        estimates: sanitizeQboEntity(page.rows, 'quickbooks:list_quickbooks_estimates'),
        count: page.rows.length,
        hasMore: page.hasMore,
        ...(page.hasMore ? { note: truncationNote(limit) } : {}),
      });
    }),
  );

  server.registerTool(
    'create_quickbooks_estimate',
    {
      description: `Create a new estimate (quote) in QuickBooks Online.

Example: { "customerId": "123", "lines": [{ "description": "Consulting services", "amount": 1500 }] }

WORKFLOW:
1. Use list_quickbooks_customers to find the customer ID
2. Create with line items (description + amount required)
3. Optionally set expirationDate and memo

COMMON MISTAKES:
- customerId is required (use list_quickbooks_customers to find it)
- Each line needs at least description and amount
- Dates use YYYY-MM-DD format`,
      inputSchema: z.object({
        customerId: z.string().describe('Customer ID (required)'),
        lines: z.array(z.object({
          description: z.string().min(1).describe('Line description'),
          amount: z.number().finite().positive().describe('Line amount (must be > 0)'),
          qty: z.number().finite().positive().optional().describe('Quantity (default: 1, must be > 0)'),
          itemId: z.string().optional().describe('Item/service ID (optional)'),
        })).min(1).describe('Estimate line items (at least one required)'),
        expirationDate: qboDate.optional().describe('Expiration date (YYYY-MM-DD)'),
        memo: z.string().optional().describe('Customer memo / notes'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireProdWritesEnabled();
      validateAlphanumericId(args.customerId, 'customerId');
      for (const line of args.lines) {
        if (line.itemId) validateAlphanumericId(line.itemId, 'itemId');
      }
      const estimateBody: Record<string, unknown> = {
        CustomerRef: { value: args.customerId },
        Line: args.lines.map((line) => ({
          Amount: line.amount,
          DetailType: 'SalesItemLineDetail',
          Description: line.description,
          SalesItemLineDetail: {
            Qty: line.qty || 1,
            UnitPrice: line.amount / (line.qty || 1),
            ...(line.itemId ? { ItemRef: { value: line.itemId } } : {}),
          },
        })),
      };
      if (args.expirationDate) estimateBody.ExpirationDate = args.expirationDate;
      if (args.memo) estimateBody.CustomerMemo = { value: args.memo };

      const result = await qboFetch<{ Estimate: Record<string, unknown> }>(
        `/estimate?minorversion=${QBO_MINOR_VERSION}`,
        { method: 'POST', body: JSON.stringify(estimateBody) },
      );
      return JSON.stringify({
        ok: true,
        message: 'Estimate created.',
        estimate: sanitizeQboEntity(result.Estimate, 'quickbooks:create_quickbooks_estimate'),
      });
    }),
  );
}
