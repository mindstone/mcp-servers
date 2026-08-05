import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeSOQL, escapeSOQLLike, validateFields, validateAndMergeCustomFields, checkSaveResult, sanitizeRecords } from '../utils.js';
import { withConnection } from '../client.js';
import { ConnectorError, type SaveResult } from '../types.js';

export function registerCaseTools(server: McpServer): void {
  server.registerTool(
    'salesforce_get_cases',
    {
      description: `Get support cases. Filters: subject_contains, status, priority, related_account_id, related_contact_id, is_closed. Returns: Id, CaseNumber, Subject, Status, Priority, Origin, Description, AccountId, ContactId, OwnerId, CreatedDate, ClosedDate. Max 200 (default: 50).`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
        subject_contains: z.string().optional().describe('Filter by subject (case-insensitive)'),
        status: z.string().optional().describe('Filter by status (New, Working, Escalated, Closed)'),
        priority: z.string().optional().describe('Filter by priority (High, Medium, Low)'),
        related_account_id: z.string().optional().describe('Filter by Account ID'),
        related_contact_id: z.string().optional().describe('Filter by Contact ID'),
        is_closed: z.boolean().optional().describe('Filter by closed status'),
        fields: z.array(z.string()).optional().describe('Custom fields (must be valid API names)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const defaultFields = ['Id', 'CaseNumber', 'Subject', 'Status', 'Priority', 'Origin', 'Description', 'AccountId', 'ContactId', 'OwnerId', 'CreatedDate', 'ClosedDate'];
        const fields = validateFields(args.fields || [], defaultFields);
        let query = `SELECT ${fields.join(', ')} FROM Case`;
        const conditions: string[] = [];
        if (args.subject_contains) conditions.push(`Subject LIKE '%${escapeSOQLLike(args.subject_contains)}%'`);
        if (args.status) conditions.push(`Status = '${escapeSOQL(args.status)}'`);
        if (args.priority) conditions.push(`Priority = '${escapeSOQL(args.priority)}'`);
        if (args.related_account_id) conditions.push(`AccountId = '${escapeSOQL(args.related_account_id)}'`);
        if (args.related_contact_id) conditions.push(`ContactId = '${escapeSOQL(args.related_contact_id)}'`);
        if (args.is_closed !== undefined) conditions.push(`IsClosed = ${args.is_closed}`);
        if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        query += ` LIMIT ${limit}`;
        const result = await conn.query(query);
        return JSON.stringify({ ok: true, records: sanitizeRecords(result.records, 'salesforce:get_cases:records'), totalSize: result.totalSize });
      });
    }),
  );

  server.registerTool(
    'salesforce_create_case',
    {
      description: `Create a support case. Required: subject. Optional: status, priority, origin, description, related_account_id, related_contact_id, fields.`,
      inputSchema: z.object({
        subject: z.string().min(1).describe('Case subject (required)'),
        status: z.string().optional().describe('Case status (default: New)'),
        priority: z.string().optional().describe('Priority (High, Medium, Low)'),
        origin: z.string().optional().describe('Case origin (Phone, Email, Web)'),
        description: z.string().optional().describe('Case description'),
        related_account_id: z.string().optional().describe('Account ID to associate with'),
        related_contact_id: z.string().optional().describe('Contact ID to associate with'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields as key-value pairs'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const data: Record<string, unknown> = { Subject: args.subject };
        if (args.status) data.Status = args.status;
        if (args.priority) data.Priority = args.priority;
        if (args.origin) data.Origin = args.origin;
        if (args.description) data.Description = args.description;
        if (args.related_account_id) data.AccountId = args.related_account_id;
        if (args.related_contact_id) data.ContactId = args.related_contact_id;
        if (args.fields) validateAndMergeCustomFields(data, args.fields);
        const result = await conn.sobject('Case').create(data);
        if (!result.success) throw new ConnectorError('Failed to create case', 'CREATE_ERROR', JSON.stringify(result.errors));
        return JSON.stringify({ ok: true, status: 'success', object: 'Case', id: result.id, subject: args.subject });
      });
    }),
  );

  server.registerTool(
    'salesforce_update_case',
    {
      description: `Update a support case. Required: id. Updatable: subject, status, priority, origin, description, related_account_id, related_contact_id, fields.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Salesforce Case ID (required)'),
        subject: z.string().optional().describe('Case subject'),
        status: z.string().optional().describe('Case status (e.g., Working, Escalated, Closed)'),
        priority: z.string().optional().describe('Priority (High, Medium, Low)'),
        origin: z.string().optional().describe('Case origin'),
        description: z.string().optional().describe('Description'),
        related_account_id: z.string().optional().describe('Account ID to associate with'),
        related_contact_id: z.string().optional().describe('Contact ID to associate with'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields as key-value pairs'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const updateData: Record<string, unknown> = { Id: args.id };
        if (args.subject) updateData.Subject = args.subject;
        if (args.status) updateData.Status = args.status;
        if (args.priority) updateData.Priority = args.priority;
        if (args.origin) updateData.Origin = args.origin;
        if (args.description) updateData.Description = args.description;
        if (args.related_account_id) updateData.AccountId = args.related_account_id;
        if (args.related_contact_id) updateData.ContactId = args.related_contact_id;
        if (args.fields) validateAndMergeCustomFields(updateData, args.fields);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await conn.sobject('Case').update(updateData as any) as unknown as SaveResult;
        checkSaveResult(result, 'Failed to update case');
        return JSON.stringify({ ok: true, status: 'success', object: 'Case', id: args.id });
      });
    }),
  );
}
