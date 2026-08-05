/**
 * QuickBooks invoice tools.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeQboql, validateAlphanumericId, requireProdWritesEnabled } from '../utils.js';
import { qboFetch, qboFetchBinary, qboQuery, qboSparseUpdate } from '../client.js';
import { QBO_MINOR_VERSION, QuickBooksError } from '../types.js';
import { sanitizeQboEntity } from '../sanitize.js';

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
      return JSON.stringify({
        ok: true,
        invoices: sanitizeQboEntity(invoices, 'quickbooks:list_quickbooks_invoices'),
        count: invoices.length,
      });
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
      return JSON.stringify({
        ok: true,
        message: 'Invoice created.',
        invoice: sanitizeQboEntity(result.Invoice, 'quickbooks:create_quickbooks_invoice'),
      });
    }),
  );

  server.registerTool(
    'update_quickbooks_invoice',
    {
      description: `Sparse-update an existing invoice in QuickBooks Online (header fields only — line items cannot be sparse-updated).

Example: { "invoiceId": "123", "dueDate": "2026-04-01" }
Example: { "invoiceId": "123", "memo": "Net 30", "privateNote": "Chased 2026-03-01" }

Requires QB_ALLOW_PROD_WRITES=1. If syncToken is omitted the invoice is read
first to obtain the current one (QuickBooks rejects stale SyncTokens).`,
      inputSchema: z.object({
        invoiceId: z.string().describe('Invoice ID (required)'),
        syncToken: z.string().optional()
          .describe('Current SyncToken (omit to read it from QuickBooks first)'),
        dueDate: z.string().optional().describe('New due date (YYYY-MM-DD)'),
        memo: z.string().optional().describe('New customer memo'),
        privateNote: z.string().optional().describe('New private note (not visible to the customer)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireProdWritesEnabled();
      validateAlphanumericId(args.invoiceId, 'invoiceId');

      const fields: Record<string, unknown> = {};
      if (args.dueDate) fields.DueDate = args.dueDate;
      if (args.memo) fields.CustomerMemo = { value: args.memo };
      if (args.privateNote) fields.PrivateNote = args.privateNote;
      if (Object.keys(fields).length === 0) {
        throw new QuickBooksError(
          'Nothing to update: provide at least one of dueDate, memo, privateNote.',
          'INVALID_INPUT',
          'Pass at least one field to update.',
        );
      }

      const invoice = await qboSparseUpdate('invoice', 'Invoice', args.invoiceId, args.syncToken, fields);
      return JSON.stringify({
        ok: true,
        message: 'Invoice updated.',
        invoice: sanitizeQboEntity(invoice, 'quickbooks:update_quickbooks_invoice'),
      });
    }),
  );

  server.registerTool(
    'send_quickbooks_invoice_email',
    {
      description: `Email an invoice to its customer via QuickBooks Online.

Example: { "invoiceId": "123" }
Example: { "invoiceId": "123", "sendTo": "billing@example.com" }

WORKFLOW:
1. Use list_quickbooks_invoices to find the invoice ID
2. Send to the invoice's billing email, or override with sendTo

Requires QB_ALLOW_PROD_WRITES=1 — this emails a real customer.`,
      inputSchema: z.object({
        invoiceId: z.string().describe('Invoice ID (required)'),
        sendTo: z.string().email().optional()
          .describe('Override recipient email (default: the invoice billing email)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireProdWritesEnabled();
      validateAlphanumericId(args.invoiceId, 'invoiceId');

      const params = new URLSearchParams({ minorversion: QBO_MINOR_VERSION });
      if (args.sendTo) params.set('sendTo', args.sendTo);

      const result = await qboFetch<{ Invoice: Record<string, unknown> }>(
        `/invoice/${encodeURIComponent(args.invoiceId)}/send?${params.toString()}`,
        { method: 'POST' },
      );
      return JSON.stringify({
        ok: true,
        message: 'Invoice sent.',
        invoice: sanitizeQboEntity(result.Invoice, 'quickbooks:send_quickbooks_invoice_email'),
      });
    }),
  );

  server.registerTool(
    'download_quickbooks_invoice_pdf',
    {
      description: `Download an invoice as a PDF file from QuickBooks Online.

Returns the local file path where the PDF has been saved (system temp directory).

Example: { "invoiceId": "123" }

WORKFLOW:
1. Use list_quickbooks_invoices to find the invoice ID
2. Download the PDF, then attach or share the saved file`,
      inputSchema: z.object({
        invoiceId: z.string().describe('Invoice ID (required)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      validateAlphanumericId(args.invoiceId, 'invoiceId');

      const pdfBuffer = await qboFetchBinary(
        `/invoice/${encodeURIComponent(args.invoiceId)}/pdf?minorversion=${QBO_MINOR_VERSION}`,
        'application/pdf',
      );
      // invoiceId is alphanumeric-validated above, so the basename is safe —
      // but a validated pathname is never re-trusted as a write target. The
      // PDF lands inside a fresh, unpredictable staging directory created
      // atomically with fs.mkdtempSync directly under the canonical temp
      // root (mode 0700), so another local principal cannot pre-create,
      // rename, or symlink-swap any path component, and concurrent same-ID
      // downloads cannot collide. The file itself is opened with
      // O_CREAT|O_EXCL|O_WRONLY (mode 0600), fstat-checked to be a regular
      // file, and written through the single verified descriptor.
      const tmpRoot = fs.realpathSync(os.tmpdir());
      const stagingDir = fs.mkdtempSync(path.join(tmpRoot, 'quickbooks-invoice-'));
      const outputPath = path.join(stagingDir, `quickbooks_invoice_${args.invoiceId}.pdf`);
      try {
        const fd = fs.openSync(outputPath, 'wx', 0o600);
        try {
          if (!fs.fstatSync(fd).isFile()) {
            throw new QuickBooksError(
              'Download target is not a regular file.',
              'DOWNLOAD_WRITE_FAILED',
              'Try the download again.',
            );
          }
          fs.writeSync(fd, pdfBuffer);
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        // Never leave a partial download behind; removal is best-effort so
        // the original error stays observable.
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        } catch { /* best effort */ }
        throw error;
      }

      return JSON.stringify({
        ok: true,
        filePath: outputPath,
        fileSizeKb: Number((pdfBuffer.length / 1024).toFixed(1)),
        message: `Invoice PDF downloaded to ${outputPath}`,
      });
    }),
  );
}
