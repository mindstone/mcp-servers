import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeSOQL, escapeSOQLLike, validateFields, validateAndMergeCustomFields, checkSaveResult, formatVendorErrors, sanitizeRecords } from '../utils.js';
import { withConnection } from '../client.js';
import { type SaveResult } from '../types.js';

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    'salesforce_get_accounts',
    {
      description: `Get CRM accounts. Filters: name_contains, industry, account_type. Returns: Id, Name, Industry, Type, Phone, Website, Description. Max 200 records (default: 50).`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
        name_contains: z.string().optional().describe('Filter by name (case-insensitive)'),
        industry: z.string().optional().describe('Filter by industry'),
        account_type: z.string().optional().describe('Filter by type (Customer, Partner, Competitor)'),
        fields: z.array(z.string()).optional().describe('Custom fields (must be valid API names)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const defaultFields = ['Id', 'Name', 'Industry', 'Type', 'Phone', 'Website', 'Description'];
        const fields = validateFields(args.fields || [], defaultFields);
        let query = `SELECT ${fields.join(', ')} FROM Account`;
        const conditions: string[] = [];
        if (args.name_contains) conditions.push(`Name LIKE '%${escapeSOQLLike(args.name_contains)}%'`);
        if (args.industry) conditions.push(`Industry = '${escapeSOQL(args.industry)}'`);
        if (args.account_type) conditions.push(`Type = '${escapeSOQL(args.account_type)}'`);
        if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        query += ` LIMIT ${limit}`;
        const result = await conn.query(query);
        return JSON.stringify({ ok: true, records: sanitizeRecords(result.records, 'salesforce:get_accounts:records'), totalSize: result.totalSize, done: result.done });
      });
    }),
  );

  server.registerTool(
    'salesforce_create_account',
    {
      description: `Create a CRM account. Required: name. Optional: industry, type, phone, website, description, fields.`,
      inputSchema: z.object({
        name: z.string().min(1).describe('Account name (required)'),
        industry: z.string().optional().describe('Industry'),
        type: z.string().optional().describe('Account type'),
        phone: z.string().optional().describe('Phone number'),
        website: z.string().optional().describe('Website URL'),
        description: z.string().optional().describe('Account description'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields as key-value pairs'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const data: Record<string, unknown> = { Name: args.name };
        if (args.industry) data.Industry = args.industry;
        if (args.type) data.Type = args.type;
        if (args.phone) data.Phone = args.phone;
        if (args.website) data.Website = args.website;
        if (args.description) data.Description = args.description;
        if (args.fields) validateAndMergeCustomFields(data, args.fields);
        const result = await conn.sobject('Account').create(data);
        if (!result.success) {
          const { ConnectorError } = await import('../types.js');
          throw new ConnectorError('Failed to create account', 'CREATE_ERROR', formatVendorErrors(result.errors));
        }
        return JSON.stringify({ ok: true, status: 'success', object: 'Account', id: result.id, name: args.name });
      });
    }),
  );

  server.registerTool(
    'salesforce_update_account',
    {
      description: `Update a CRM account. Required: id. Updatable: name, industry, type, phone, website, description, fields.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Salesforce Account ID (required)'),
        name: z.string().optional().describe('Account name'),
        industry: z.string().optional().describe('Industry'),
        type: z.string().optional().describe('Account type'),
        phone: z.string().optional().describe('Phone number'),
        website: z.string().optional().describe('Website URL'),
        description: z.string().optional().describe('Description'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields as key-value pairs'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const updateData: Record<string, unknown> = { Id: args.id };
        if (args.name) updateData.Name = args.name;
        if (args.industry) updateData.Industry = args.industry;
        if (args.type) updateData.Type = args.type;
        if (args.phone) updateData.Phone = args.phone;
        if (args.website) updateData.Website = args.website;
        if (args.description) updateData.Description = args.description;
        if (args.fields) validateAndMergeCustomFields(updateData, args.fields);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await conn.sobject('Account').update(updateData as any) as unknown as SaveResult;
        checkSaveResult(result, 'Failed to update account');
        return JSON.stringify({ ok: true, status: 'success', object: 'Account', id: args.id });
      });
    }),
  );
}
