import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeSOQL, escapeSOQLLike, validateFields, formatSOQLDate, sanitizeRecords } from '../utils.js';
import { withConnection } from '../client.js';

export function registerCampaignTools(server: McpServer): void {
  server.registerTool(
    'salesforce_get_campaigns',
    {
      description: `Get marketing campaigns. Filters: name_contains, campaign_type, status, is_active, start_date_from, start_date_to. Returns: Id, Name, Type, Status, IsActive, StartDate, EndDate, Description. Max 200 (default: 50).`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
        name_contains: z.string().optional().describe('Filter by name (case-insensitive)'),
        campaign_type: z.string().optional().describe('Filter by type (Email, Webinar, Advertisement)'),
        status: z.string().optional().describe('Filter by status (Planned, In Progress, Completed)'),
        is_active: z.boolean().optional().describe('Filter by active status'),
        start_date_from: z.string().optional().describe('Campaigns starting on/after date (YYYY-MM-DD)'),
        start_date_to: z.string().optional().describe('Campaigns starting on/before date (YYYY-MM-DD)'),
        fields: z.array(z.string()).optional().describe('Custom fields (must be valid API names)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const defaultFields = ['Id', 'Name', 'Type', 'Status', 'IsActive', 'StartDate', 'EndDate', 'Description'];
        const fields = validateFields(args.fields || [], defaultFields);
        let query = `SELECT ${fields.join(', ')} FROM Campaign`;
        const conditions: string[] = [];
        if (args.name_contains) conditions.push(`Name LIKE '%${escapeSOQLLike(args.name_contains)}%'`);
        if (args.campaign_type) conditions.push(`Type = '${escapeSOQL(args.campaign_type)}'`);
        if (args.status) conditions.push(`Status = '${escapeSOQL(args.status)}'`);
        if (args.is_active !== undefined) conditions.push(`IsActive = ${args.is_active}`);
        if (args.start_date_from) conditions.push(`StartDate >= ${formatSOQLDate(args.start_date_from, 'start_date_from')}`);
        if (args.start_date_to) conditions.push(`StartDate <= ${formatSOQLDate(args.start_date_to, 'start_date_to')}`);
        if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        query += ` LIMIT ${limit}`;
        const result = await conn.query(query);
        return JSON.stringify({ ok: true, records: sanitizeRecords(result.records, 'salesforce:get_campaigns:records'), totalSize: result.totalSize });
      });
    }),
  );

  server.registerTool(
    'salesforce_get_campaign_members',
    {
      description: `Get campaign members (leads/contacts in a campaign). Filters: campaign_id, lead_id, contact_id, status. Returns: Id, CampaignId, LeadId, ContactId, Status, CreatedDate. Max 200 (default: 50).`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
        campaign_id: z.string().optional().describe('Filter by Campaign ID'),
        lead_id: z.string().optional().describe('Filter by Lead ID'),
        contact_id: z.string().optional().describe('Filter by Contact ID'),
        status: z.string().optional().describe('Filter by member status (Sent, Responded)'),
        fields: z.array(z.string()).optional().describe('Custom fields (must be valid API names)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const defaultFields = ['Id', 'CampaignId', 'LeadId', 'ContactId', 'Status', 'CreatedDate'];
        const fields = validateFields(args.fields || [], defaultFields);
        let query = `SELECT ${fields.join(', ')} FROM CampaignMember`;
        const conditions: string[] = [];
        if (args.campaign_id) conditions.push(`CampaignId = '${escapeSOQL(args.campaign_id)}'`);
        if (args.lead_id) conditions.push(`LeadId = '${escapeSOQL(args.lead_id)}'`);
        if (args.contact_id) conditions.push(`ContactId = '${escapeSOQL(args.contact_id)}'`);
        if (args.status) conditions.push(`Status = '${escapeSOQL(args.status)}'`);
        if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        query += ` LIMIT ${limit}`;
        const result = await conn.query(query);
        return JSON.stringify({ ok: true, records: sanitizeRecords(result.records, 'salesforce:get_campaign_members:records'), totalSize: result.totalSize });
      });
    }),
  );
}
