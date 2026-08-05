import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeSOQL, escapeSOQLLike, validateFields, validateAndMergeCustomFields, checkSaveResult, sanitizeRecords } from '../utils.js';
import { withConnection } from '../client.js';
import { ConnectorError, type SaveResult } from '../types.js';

export function registerContactTools(server: McpServer): void {
  server.registerTool(
    'salesforce_get_contacts',
    {
      description: `Get contacts. Filters: name_contains, email_contains, related_account_id. Returns: Id, FirstName, LastName, Email, Phone, Title, AccountId. Max 200 (default: 50).`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
        name_contains: z.string().optional().describe('Filter by first or last name'),
        email_contains: z.string().optional().describe('Filter by email'),
        related_account_id: z.string().optional().describe('Filter by Account ID'),
        fields: z.array(z.string()).optional().describe('Custom fields (valid API names)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const defaultFields = ['Id', 'FirstName', 'LastName', 'Email', 'Phone', 'Title', 'AccountId'];
        const fields = validateFields(args.fields || [], defaultFields);
        let query = `SELECT ${fields.join(', ')} FROM Contact`;
        const conditions: string[] = [];
        if (args.name_contains) {
          const escaped = escapeSOQLLike(args.name_contains);
          conditions.push(`(FirstName LIKE '%${escaped}%' OR LastName LIKE '%${escaped}%')`);
        }
        if (args.email_contains) conditions.push(`Email LIKE '%${escapeSOQLLike(args.email_contains)}%'`);
        if (args.related_account_id) conditions.push(`AccountId = '${escapeSOQL(args.related_account_id)}'`);
        if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        query += ` LIMIT ${limit}`;
        const result = await conn.query(query);
        return JSON.stringify({ ok: true, records: sanitizeRecords(result.records, 'salesforce:get_contacts:records'), totalSize: result.totalSize });
      });
    }),
  );

  server.registerTool(
    'salesforce_create_contact',
    {
      description: `Create a contact. Required: last_name. Optional: first_name, email, phone, title, related_account_id, fields.`,
      inputSchema: z.object({
        first_name: z.string().optional().describe('First name'),
        last_name: z.string().min(1).describe('Last name (required)'),
        email: z.string().optional().describe('Email address'),
        phone: z.string().optional().describe('Phone number'),
        title: z.string().optional().describe('Job title'),
        related_account_id: z.string().optional().describe('Account ID to associate with'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields as key-value pairs'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const data: Record<string, unknown> = { LastName: args.last_name };
        if (args.first_name) data.FirstName = args.first_name;
        if (args.email) data.Email = args.email;
        if (args.phone) data.Phone = args.phone;
        if (args.title) data.Title = args.title;
        if (args.related_account_id) data.AccountId = args.related_account_id;
        if (args.fields) validateAndMergeCustomFields(data, args.fields);
        const result = await conn.sobject('Contact').create(data);
        if (!result.success) throw new ConnectorError('Failed to create contact', 'CREATE_ERROR', JSON.stringify(result.errors));
        return JSON.stringify({ ok: true, status: 'success', object: 'Contact', id: result.id, name: `${args.first_name || ''} ${args.last_name}`.trim() });
      });
    }),
  );

  server.registerTool(
    'salesforce_update_contact',
    {
      description: `Update a contact. Required: id. Updatable: first_name, last_name, email, phone, title, fields.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Salesforce Contact ID (required)'),
        first_name: z.string().optional().describe('First name'),
        last_name: z.string().optional().describe('Last name'),
        email: z.string().optional().describe('Email address'),
        phone: z.string().optional().describe('Phone number'),
        title: z.string().optional().describe('Job title'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields as key-value pairs'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const updateData: Record<string, unknown> = { Id: args.id };
        if (args.first_name) updateData.FirstName = args.first_name;
        if (args.last_name) updateData.LastName = args.last_name;
        if (args.email) updateData.Email = args.email;
        if (args.phone) updateData.Phone = args.phone;
        if (args.title) updateData.Title = args.title;
        if (args.fields) validateAndMergeCustomFields(updateData, args.fields);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await conn.sobject('Contact').update(updateData as any) as unknown as SaveResult;
        checkSaveResult(result, 'Failed to update contact');
        return JSON.stringify({ ok: true, status: 'success', object: 'Contact', id: args.id });
      });
    }),
  );
}
