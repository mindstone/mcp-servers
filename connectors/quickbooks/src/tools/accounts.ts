/**
 * QuickBooks account (chart of accounts) tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeQboql } from '../utils.js';
import { qboQuery } from '../client.js';

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    'list_quickbooks_accounts',
    {
      description: `List chart of accounts from QuickBooks Online.

Returns: Id, Name, AccountType, AccountSubType, CurrentBalance, Active.

Example: {}
Example: { "accountType": "Expense" }

Account types: Bank, Accounts Receivable, Other Current Asset, Fixed Asset, Other Asset, Accounts Payable, Credit Card, Other Current Liability, Long Term Liability, Equity, Income, Cost of Goods Sold, Expense, Other Income, Other Expense.`,
      inputSchema: z.object({
        accountType: z.string().optional().describe('Filter by account type (e.g., "Expense", "Income", "Bank")'),
        active: z.boolean().optional().describe('Filter by active status'),
        limit: z.number().optional().describe('Max results (default: 100)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const limit = Math.min(args.limit ?? 100, 1000);
      const conditions: string[] = [];

      if (args.accountType) conditions.push(`AccountType = '${escapeQboql(args.accountType)}'`);
      if (args.active !== undefined) conditions.push(`Active = ${args.active}`);

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
      const query = `SELECT * FROM Account${where} ORDERBY Name`;
      const accounts = await qboQuery('Account', query, limit);
      return JSON.stringify({ ok: true, accounts, count: accounts.length });
    }),
  );
}
