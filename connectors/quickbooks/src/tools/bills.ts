/**
 * QuickBooks bill tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeQboql, validateAlphanumericId, requireProdWritesEnabled } from '../utils.js';
import { qboFetch, qboQuery } from '../client.js';

export function registerBillTools(server: McpServer): void {
  server.registerTool(
    'list_quickbooks_bills',
    {
      description: `List bills (accounts payable) from QuickBooks Online.

Returns: Id, DocNumber, TxnDate, DueDate, Balance, TotalAmt, VendorRef.

Example: {}
Example: { "vendorId": "123" }`,
      inputSchema: z.object({
        vendorId: z.string().optional().describe('Filter by vendor ID'),
        limit: z.number().optional().describe('Max results (default: 50)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const limit = Math.min(args.limit ?? 50, 1000);
      if (args.vendorId) validateAlphanumericId(args.vendorId, 'vendorId');
      const where = args.vendorId ? ` WHERE VendorRef = '${escapeQboql(args.vendorId)}'` : '';
      const query = `SELECT * FROM Bill${where} ORDERBY TxnDate DESC`;
      const bills = await qboQuery('Bill', query, limit);
      return JSON.stringify({ ok: true, bills, count: bills.length });
    }),
  );

  server.registerTool(
    'create_quickbooks_bill',
    {
      description: `Create a new bill (accounts payable) in QuickBooks Online.

Example: { "vendorId": "123", "lines": [{ "description": "Office supplies", "amount": 250, "accountId": "456" }] }

WORKFLOW:
1. Use list_quickbooks_vendors to find the vendor ID
2. Use list_quickbooks_accounts to find expense account IDs
3. Create with line items`,
      inputSchema: z.object({
        vendorId: z.string().describe('Vendor ID (required)'),
        lines: z.array(z.object({
          description: z.string().describe('Line description'),
          amount: z.number().describe('Line amount'),
          accountId: z.string().optional().describe('Expense account ID'),
        })).describe('Bill line items'),
        dueDate: z.string().optional().describe('Due date (YYYY-MM-DD)'),
        memo: z.string().optional().describe('Memo / notes'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireProdWritesEnabled();
      const billBody: Record<string, unknown> = {
        VendorRef: { value: args.vendorId },
        Line: args.lines.map((line) => ({
          Amount: line.amount,
          DetailType: 'AccountBasedExpenseLineDetail',
          Description: line.description,
          AccountBasedExpenseLineDetail: {
            ...(line.accountId ? { AccountRef: { value: line.accountId } } : {}),
          },
        })),
      };
      if (args.dueDate) billBody.DueDate = args.dueDate;
      if (args.memo) billBody.PrivateNote = args.memo;

      const result = await qboFetch<{ Bill: Record<string, unknown> }>(
        '/bill?minorversion=65',
        { method: 'POST', body: JSON.stringify(billBody) },
      );
      return JSON.stringify({ ok: true, message: 'Bill created.', bill: result.Bill });
    }),
  );
}
