import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeSOQL, escapeSOQLLike, validateFields, validateAndMergeCustomFields, formatSOQLDate, checkSaveResult } from '../utils.js';
import { withConnection } from '../client.js';
import { ConnectorError, type SaveResult } from '../types.js';

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    'salesforce_get_tasks',
    {
      description: `Get tasks. Filters: subject_contains, status, priority, who_id, what_id, activity_date_from, activity_date_to. Max 200 (default: 50).`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
        subject_contains: z.string().optional().describe('Filter by subject'),
        status: z.string().optional().describe('Filter by status'),
        priority: z.string().optional().describe('Filter by priority'),
        who_id: z.string().optional().describe('Filter by WhoId (Contact or Lead ID)'),
        what_id: z.string().optional().describe('Filter by WhatId (Account or Opportunity ID)'),
        activity_date_from: z.string().optional().describe('Filter tasks on/after date (YYYY-MM-DD)'),
        activity_date_to: z.string().optional().describe('Filter tasks on/before date (YYYY-MM-DD)'),
        fields: z.array(z.string()).optional().describe('Custom fields'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const defaultFields = ['Id', 'Subject', 'Status', 'Priority', 'WhoId', 'WhatId', 'ActivityDate', 'Description', 'OwnerId', 'IsClosed'];
        const fields = validateFields(args.fields || [], defaultFields);
        let query = `SELECT ${fields.join(', ')} FROM Task`;
        const conditions: string[] = [];
        if (args.subject_contains) conditions.push(`Subject LIKE '%${escapeSOQLLike(args.subject_contains)}%'`);
        if (args.status) conditions.push(`Status = '${escapeSOQL(args.status)}'`);
        if (args.priority) conditions.push(`Priority = '${escapeSOQL(args.priority)}'`);
        if (args.who_id) conditions.push(`WhoId = '${escapeSOQL(args.who_id)}'`);
        if (args.what_id) conditions.push(`WhatId = '${escapeSOQL(args.what_id)}'`);
        if (args.activity_date_from) conditions.push(`ActivityDate >= ${formatSOQLDate(args.activity_date_from, 'activity_date_from')}`);
        if (args.activity_date_to) conditions.push(`ActivityDate <= ${formatSOQLDate(args.activity_date_to, 'activity_date_to')}`);
        if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        query += ` LIMIT ${limit}`;
        const result = await conn.query(query);
        return JSON.stringify({ ok: true, records: result.records, totalSize: result.totalSize });
      });
    }),
  );

  server.registerTool(
    'salesforce_create_task',
    {
      description: `Create a task. Required: subject. Optional: status, priority, who_id, what_id, activity_date, description, owner_id, fields.`,
      inputSchema: z.object({
        subject: z.string().min(1).describe('Task subject (required)'),
        status: z.string().optional().describe('Task status (default: Not Started)'),
        priority: z.string().optional().describe('Priority (High, Normal, Low)'),
        who_id: z.string().optional().describe('Contact or Lead ID'),
        what_id: z.string().optional().describe('Account or Opportunity ID'),
        activity_date: z.string().optional().describe('Due date (YYYY-MM-DD)'),
        description: z.string().optional().describe('Task description'),
        owner_id: z.string().optional().describe('Owner User ID'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (args.activity_date) formatSOQLDate(args.activity_date, 'activity_date');
      return withConnection(undefined, async (conn) => {
        const data: Record<string, unknown> = { Subject: args.subject };
        if (args.status) data.Status = args.status;
        if (args.priority) data.Priority = args.priority;
        if (args.who_id) data.WhoId = args.who_id;
        if (args.what_id) data.WhatId = args.what_id;
        if (args.activity_date) data.ActivityDate = args.activity_date;
        if (args.description) data.Description = args.description;
        if (args.owner_id) data.OwnerId = args.owner_id;
        if (args.fields) validateAndMergeCustomFields(data, args.fields);
        const result = await conn.sobject('Task').create(data);
        if (!result.success) throw new ConnectorError('Failed to create task', 'CREATE_ERROR', JSON.stringify(result.errors));
        return JSON.stringify({ ok: true, status: 'success', object: 'Task', id: result.id, subject: args.subject });
      });
    }),
  );

  server.registerTool(
    'salesforce_update_task',
    {
      description: `Update a task. Required: id. Updatable: subject, status, priority, who_id, what_id, activity_date, description, owner_id, fields.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Salesforce Task ID (required)'),
        subject: z.string().optional().describe('Task subject'),
        status: z.string().optional().describe('Task status'),
        priority: z.string().optional().describe('Priority'),
        who_id: z.string().optional().describe('Contact or Lead ID'),
        what_id: z.string().optional().describe('Account or Opportunity ID'),
        activity_date: z.string().optional().describe('Due date (YYYY-MM-DD)'),
        description: z.string().optional().describe('Description'),
        owner_id: z.string().optional().describe('Owner User ID'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (args.activity_date) formatSOQLDate(args.activity_date, 'activity_date');
      return withConnection(undefined, async (conn) => {
        const updateData: Record<string, unknown> = { Id: args.id };
        if (args.subject) updateData.Subject = args.subject;
        if (args.status) updateData.Status = args.status;
        if (args.priority) updateData.Priority = args.priority;
        if (args.who_id) updateData.WhoId = args.who_id;
        if (args.what_id) updateData.WhatId = args.what_id;
        if (args.activity_date) updateData.ActivityDate = args.activity_date;
        if (args.description) updateData.Description = args.description;
        if (args.owner_id) updateData.OwnerId = args.owner_id;
        if (args.fields) validateAndMergeCustomFields(updateData, args.fields);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await conn.sobject('Task').update(updateData as any) as unknown as SaveResult;
        checkSaveResult(result, 'Failed to update task');
        return JSON.stringify({ ok: true, status: 'success', object: 'Task', id: args.id });
      });
    }),
  );
}
