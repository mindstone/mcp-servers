import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeSOQL, escapeSOQLLike, validateFields, validateAndMergeCustomFields, formatSOQLDateTime, formatVendorErrors, sanitizeRecords } from '../utils.js';
import { withConnection } from '../client.js';
import { ConnectorError } from '../types.js';

export function registerEventTools(server: McpServer): void {
  server.registerTool(
    'salesforce_get_events',
    {
      description: `Get calendar events. Filters: subject_contains, who_id, what_id, start_from, start_to. Dates accept YYYY-MM-DD (midnight UTC) or ISO 8601 datetimes. Returns: Id, Subject, StartDateTime, EndDateTime, Location, Description, WhoId, WhatId, OwnerId, IsAllDayEvent. Max 200 (default: 50).`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
        subject_contains: z.string().optional().describe('Filter by subject (case-insensitive)'),
        who_id: z.string().optional().describe('Filter by WhoId (Contact or Lead ID)'),
        what_id: z.string().optional().describe('Filter by WhatId (Account or Opportunity ID)'),
        start_from: z.string().optional().describe('Events starting on/after this date or datetime (YYYY-MM-DD or ISO 8601; see tool description for an example)'),
        start_to: z.string().optional().describe('Events starting on/before this date or datetime (YYYY-MM-DD or ISO 8601)'),
        fields: z.array(z.string()).optional().describe('Custom fields (must be valid API names)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const defaultFields = ['Id', 'Subject', 'StartDateTime', 'EndDateTime', 'Location', 'Description', 'WhoId', 'WhatId', 'OwnerId', 'IsAllDayEvent'];
        const fields = validateFields(args.fields || [], defaultFields);
        let query = `SELECT ${fields.join(', ')} FROM Event`;
        const conditions: string[] = [];
        if (args.subject_contains) conditions.push(`Subject LIKE '%${escapeSOQLLike(args.subject_contains)}%'`);
        if (args.who_id) conditions.push(`WhoId = '${escapeSOQL(args.who_id)}'`);
        if (args.what_id) conditions.push(`WhatId = '${escapeSOQL(args.what_id)}'`);
        if (args.start_from) conditions.push(`StartDateTime >= ${formatSOQLDateTime(args.start_from, 'start_from')}`);
        if (args.start_to) conditions.push(`StartDateTime <= ${formatSOQLDateTime(args.start_to, 'start_to')}`);
        if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
        query += ' ORDER BY StartDateTime ASC';
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        query += ` LIMIT ${limit}`;
        const result = await conn.query(query);
        return JSON.stringify({ ok: true, records: sanitizeRecords(result.records, 'salesforce:get_events:records'), totalSize: result.totalSize });
      });
    }),
  );

  server.registerTool(
    'salesforce_create_event',
    {
      description: `Create a calendar event. Required: subject, start_date_time, end_date_time. Optional: location, description, who_id, what_id, is_all_day_event, owner_id, fields. Datetimes must be ISO 8601 (e.g. "2026-01-09T14:30:00Z"); all-day events accept plain dates (YYYY-MM-DD).`,
      inputSchema: z.object({
        subject: z.string().min(1).describe('Event subject (required)'),
        start_date_time: z.string().min(1).describe('Start (required) — ISO 8601 datetime (see tool description for an example), or YYYY-MM-DD for all-day events'),
        end_date_time: z.string().min(1).describe('End (required) — ISO 8601 datetime, or YYYY-MM-DD for all-day events'),
        location: z.string().optional().describe('Event location'),
        description: z.string().optional().describe('Event description'),
        who_id: z.string().optional().describe('Contact or Lead ID to invite/relate'),
        what_id: z.string().optional().describe('Account or Opportunity ID to relate'),
        is_all_day_event: z.boolean().optional().describe('All-day event (default: false)'),
        owner_id: z.string().optional().describe('Owner User ID'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields as key-value pairs'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      // Validate formats up front for actionable errors; the validated values
      // go into the create body verbatim (JSON body — no SOQL injection surface).
      formatSOQLDateTime(args.start_date_time, 'start_date_time');
      formatSOQLDateTime(args.end_date_time, 'end_date_time');
      return withConnection(undefined, async (conn) => {
        const data: Record<string, unknown> = {
          Subject: args.subject,
          StartDateTime: args.start_date_time,
          EndDateTime: args.end_date_time,
        };
        if (args.location) data.Location = args.location;
        if (args.description) data.Description = args.description;
        if (args.who_id) data.WhoId = args.who_id;
        if (args.what_id) data.WhatId = args.what_id;
        if (args.is_all_day_event !== undefined) data.IsAllDayEvent = args.is_all_day_event;
        if (args.owner_id) data.OwnerId = args.owner_id;
        if (args.fields) validateAndMergeCustomFields(data, args.fields);
        const result = await conn.sobject('Event').create(data);
        if (!result.success) throw new ConnectorError('Failed to create event', 'CREATE_ERROR', formatVendorErrors(result.errors));
        return JSON.stringify({ ok: true, status: 'success', object: 'Event', id: result.id, subject: args.subject });
      });
    }),
  );
}
