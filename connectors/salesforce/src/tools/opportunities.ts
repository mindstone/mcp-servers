import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeSOQL, escapeSOQLLike, validateFields, validateAndMergeCustomFields, formatSOQLDate, checkSaveResult, formatVendorErrors, sanitizeRecords } from '../utils.js';
import { withConnection } from '../client.js';
import { ConnectorError, type SaveResult } from '../types.js';

export function registerOpportunityTools(server: McpServer): void {
  server.registerTool(
    'salesforce_get_opportunities',
    {
      description: `Get opportunities. Filters: name_contains, stage, related_account_id, close_date_from, close_date_to. Dates must be YYYY-MM-DD. Max 200 (default: 50).`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
        name_contains: z.string().optional().describe('Filter by name'),
        stage: z.string().optional().describe('Filter by stage'),
        related_account_id: z.string().optional().describe('Filter by Account ID'),
        close_date_from: z.string().optional().describe('Closing on/after date (YYYY-MM-DD)'),
        close_date_to: z.string().optional().describe('Closing on/before date (YYYY-MM-DD)'),
        fields: z.array(z.string()).optional().describe('Custom fields'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const defaultFields = ['Id', 'Name', 'StageName', 'Amount', 'CloseDate', 'AccountId', 'Probability'];
        const fields = validateFields(args.fields || [], defaultFields);
        let query = `SELECT ${fields.join(', ')} FROM Opportunity`;
        const conditions: string[] = [];
        if (args.name_contains) conditions.push(`Name LIKE '%${escapeSOQLLike(args.name_contains)}%'`);
        if (args.stage) conditions.push(`StageName = '${escapeSOQL(args.stage)}'`);
        if (args.related_account_id) conditions.push(`AccountId = '${escapeSOQL(args.related_account_id)}'`);
        if (args.close_date_from) conditions.push(`CloseDate >= ${formatSOQLDate(args.close_date_from, 'close_date_from')}`);
        if (args.close_date_to) conditions.push(`CloseDate <= ${formatSOQLDate(args.close_date_to, 'close_date_to')}`);
        if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        query += ` LIMIT ${limit}`;
        const result = await conn.query(query);
        return JSON.stringify({ ok: true, records: sanitizeRecords(result.records, 'salesforce:get_opportunities:records'), totalSize: result.totalSize });
      });
    }),
  );

  server.registerTool(
    'salesforce_create_opportunity',
    {
      description: `Create an opportunity. Required: name, stage_name, close_date (YYYY-MM-DD). Optional: amount, related_account_id, description, fields.`,
      inputSchema: z.object({
        name: z.string().min(1).describe('Opportunity name (required)'),
        stage_name: z.string().min(1).describe('Stage name (required)'),
        close_date: z.string().min(1).describe('Close date YYYY-MM-DD (required)'),
        amount: z.number().optional().describe('Opportunity amount'),
        related_account_id: z.string().optional().describe('Account ID to associate with'),
        description: z.string().optional().describe('Description'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields as key-value pairs'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      formatSOQLDate(args.close_date, 'close_date');
      return withConnection(undefined, async (conn) => {
        const data: Record<string, unknown> = { Name: args.name, StageName: args.stage_name, CloseDate: args.close_date };
        if (args.amount !== undefined) data.Amount = args.amount;
        if (args.related_account_id) data.AccountId = args.related_account_id;
        if (args.description) data.Description = args.description;
        if (args.fields) validateAndMergeCustomFields(data, args.fields);
        const result = await conn.sobject('Opportunity').create(data);
        if (!result.success) throw new ConnectorError('Failed to create opportunity', 'CREATE_ERROR', formatVendorErrors(result.errors));
        return JSON.stringify({ ok: true, status: 'success', object: 'Opportunity', id: result.id, name: args.name });
      });
    }),
  );

  server.registerTool(
    'salesforce_update_opportunity',
    {
      description: `Update an opportunity. Required: id. Updatable: name, stage_name, close_date (YYYY-MM-DD), amount, description, fields.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Salesforce Opportunity ID (required)'),
        name: z.string().optional().describe('Opportunity name'),
        stage_name: z.string().optional().describe('Stage name'),
        close_date: z.string().optional().describe('Close date YYYY-MM-DD'),
        amount: z.number().optional().describe('Amount'),
        description: z.string().optional().describe('Description'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (args.close_date) formatSOQLDate(args.close_date, 'close_date');
      return withConnection(undefined, async (conn) => {
        const updateData: Record<string, unknown> = { Id: args.id };
        if (args.name) updateData.Name = args.name;
        if (args.stage_name) updateData.StageName = args.stage_name;
        if (args.close_date) updateData.CloseDate = args.close_date;
        if (args.amount !== undefined) updateData.Amount = args.amount;
        if (args.description) updateData.Description = args.description;
        if (args.fields) validateAndMergeCustomFields(updateData, args.fields);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await conn.sobject('Opportunity').update(updateData as any) as unknown as SaveResult;
        checkSaveResult(result, 'Failed to update opportunity');
        return JSON.stringify({ ok: true, status: 'success', object: 'Opportunity', id: args.id });
      });
    }),
  );
}
