/**
 * QuickBooks invoice tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeQboql, validateAlphanumericId, requireProdWritesEnabled } from '../utils.js';
import { qboFetch, qboQuery } from '../client.js';
import { QBO_MINOR_VERSION } from '../types.js';

export function registerInvoiceTools(server: McpServer): void {
  server.registerTool(
    'list_quickbooks_invoices',
    {
      description: `List invoices from QuickBooks Online.

Returns: Id, DocNumber, TxnDate, DueDate, Balance, TotalAmt, CustomerRef, Line items.

Example: {}
Example: { "status": "unpaid" }
Example: { "customerId": "123" }

WORKFLOW:
1. Call with no args to see recent invoices
2. Filter by status (unpaid/paid/overdue) or customer
3. Use get_quickbooks_entity for full invoice details`,
      inputSchema: z.object({
        status: z.enum(['unpaid', 'paid', 'overdue']).optional()
          .describe('Filter: "unpaid", "paid", or "overdue"'),
        customerId: z.string().optional().describe('Filter by customer ID'),
        limit: z.number().optional().describe('Max results (default: 50)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const limit = Math.min(args.limit ?? 50, 1000);
      const conditions: string[] = [];

      if (args.status === 'unpaid') conditions.push("Balance > '0'");
      else if (args.status === 'paid') conditions.push("Balance = '0'");
      else if (args.status === 'overdue') {
        conditions.push(`Balance > '0' AND DueDate < '${new Date().toISOString().split('T')[0]}'`);
      }
      if (args.customerId) {
        validateAlphanumericId(args.customerId, 'customerId');
        conditions.push(`CustomerRef = '${escapeQboql(args.customerId)}'`);
      }

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
      const query = `SELECT * FROM Invoice${where} ORDERBY TxnDate DESC`;
      const invoices = await qboQuery('Invoice', query, limit);
      return JSON.stringify({ ok: true, invoices, count: invoices.length });
    }),
  );

  server.registerTool(
    'create_quickbooks_invoice',
    {
      description: `Create a new invoice in QuickBooks Online.

Example: { "customerId": "123", "lines": [{ "description": "Consulting services", "amount": 1500 }] }

WORKFLOW:
1. Use list_quickbooks_customers to find the customer ID
2. Create with line items (description + amount required)
3. Optionally set dueDate and memo

COMMON MISTAKES:
- customerId is required (use list_quickbooks_customers to find it)
- Each line needs at least description and amount
- Dates use YYYY-MM-DD format`,
      inputSchema: z.object({
        customerId: z.string().describe('Customer ID (required)'),
        lines: z.array(z.object({
          description: z.string().describe('Line description'),
          amount: z.number().describe('Line amount'),
          qty: z.number().optional().describe('Quantity (default: 1)'),
          itemId: z.string().optional().describe('Item/service ID (optional)'),
        })).describe('Invoice line items'),
        dueDate: z.string().optional().describe('Due date (YYYY-MM-DD)'),
        memo: z.string().optional().describe('Customer memo / notes'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireProdWritesEnabled();
      const invoiceBody: Record<string, unknown> = {
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
      if (args.dueDate) invoiceBody.DueDate = args.dueDate;
      if (args.memo) invoiceBody.CustomerMemo = { value: args.memo };

      const result = await qboFetch<{ Invoice: Record<string, unknown> }>(
        `/invoice?minorversion=${QBO_MINOR_VERSION}`,
        { method: 'POST', body: JSON.stringify(invoiceBody) },
      );
      return JSON.stringify({ ok: true, message: 'Invoice created.', invoice: result.Invoice });
    }),
  );
}
