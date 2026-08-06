import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeSOQL, escapeSOQLLike, validateFields, validateAndMergeCustomFields, checkSaveResult, formatVendorErrors, sanitizeRecords, sanitizeExternalData } from '../utils.js';
import { withConnection } from '../client.js';
import { ConnectorError, type SaveResult } from '../types.js';

export function registerLeadTools(server: McpServer): void {
  server.registerTool(
    'salesforce_get_leads',
    {
      description: `Get leads. Filters: name_contains, company_contains, email_contains, status. Max 200 (default: 50).`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
        name_contains: z.string().optional().describe('Filter by name'),
        company_contains: z.string().optional().describe('Filter by company'),
        email_contains: z.string().optional().describe('Filter by email'),
        status: z.string().optional().describe('Filter by status'),
        fields: z.array(z.string()).optional().describe('Custom fields'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const defaultFields = ['Id', 'FirstName', 'LastName', 'Company', 'Email', 'Phone', 'Status', 'Title'];
        const fields = validateFields(args.fields || [], defaultFields);
        let query = `SELECT ${fields.join(', ')} FROM Lead`;
        const conditions: string[] = [];
        if (args.name_contains) {
          const escaped = escapeSOQLLike(args.name_contains);
          conditions.push(`(FirstName LIKE '%${escaped}%' OR LastName LIKE '%${escaped}%')`);
        }
        if (args.company_contains) conditions.push(`Company LIKE '%${escapeSOQLLike(args.company_contains)}%'`);
        if (args.email_contains) conditions.push(`Email LIKE '%${escapeSOQLLike(args.email_contains)}%'`);
        if (args.status) conditions.push(`Status = '${escapeSOQL(args.status)}'`);
        if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        query += ` LIMIT ${limit}`;
        const result = await conn.query(query);
        return JSON.stringify({ ok: true, records: sanitizeRecords(result.records, 'salesforce:get_leads:records'), totalSize: result.totalSize });
      });
    }),
  );

  server.registerTool(
    'salesforce_create_lead',
    {
      description: `Create a lead. Required: last_name, company. Optional: first_name, email, phone, title, status, fields.`,
      inputSchema: z.object({
        first_name: z.string().optional().describe('First name'),
        last_name: z.string().min(1).describe('Last name (required)'),
        company: z.string().min(1).describe('Company name (required)'),
        email: z.string().optional().describe('Email address'),
        phone: z.string().optional().describe('Phone number'),
        title: z.string().optional().describe('Job title'),
        status: z.string().optional().describe('Lead status'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const data: Record<string, unknown> = { LastName: args.last_name, Company: args.company };
        if (args.first_name) data.FirstName = args.first_name;
        if (args.email) data.Email = args.email;
        if (args.phone) data.Phone = args.phone;
        if (args.title) data.Title = args.title;
        if (args.status) data.Status = args.status;
        if (args.fields) validateAndMergeCustomFields(data, args.fields);
        const result = await conn.sobject('Lead').create(data);
        if (!result.success) throw new ConnectorError('Failed to create lead', 'CREATE_ERROR', formatVendorErrors(result.errors));
        return JSON.stringify({ ok: true, status: 'success', object: 'Lead', id: result.id, name: `${args.first_name || ''} ${args.last_name}`.trim() });
      });
    }),
  );

  server.registerTool(
    'salesforce_convert_lead',
    {
      description: `Convert a lead into Account + Contact, and optionally an Opportunity. Required: lead_id. Optional: create_opportunity, opportunity_name.`,
      inputSchema: z.object({
        lead_id: z.string().min(1).describe('Lead ID to convert (required)'),
        create_opportunity: z.boolean().optional().describe('Create opportunity (default: true)'),
        opportunity_name: z.string().optional().describe('Name for new opportunity'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const leadConvert = {
          leadId: args.lead_id,
          convertedStatus: 'Closed - Converted',
          doNotCreateOpportunity: args.create_opportunity === false,
        };
        const result = await conn.soap.convertLead([leadConvert]);
        const convertResult = result[0];
        // SOAP convertLead reports record-level failures IN THE RESULT
        // (success:false + errors[]), not as a fault — checking success is the
        // only way to avoid reporting a conversion that never happened. The
        // error messages are org-authored validation-rule text, so they are
        // enveloped like every other vendor error (invariant #6).
        if (!convertResult.success) {
          throw new ConnectorError('Failed to convert lead', 'CONVERT_ERROR', formatVendorErrors(convertResult.errors));
        }
        return JSON.stringify({ ok: true, status: 'success', result: sanitizeExternalData(convertResult, 'salesforce:convert_lead:result') });
      });
    }),
  );

  server.registerTool(
    'salesforce_update_lead',
    {
      description: `Update a lead. Required: lead_id. Updatable: first_name, last_name, company, email, phone, title, status, fields.`,
      inputSchema: z.object({
        lead_id: z.string().min(1).describe('Salesforce Lead ID (required)'),
        first_name: z.string().optional().describe('First name'),
        last_name: z.string().optional().describe('Last name'),
        company: z.string().optional().describe('Company name'),
        email: z.string().optional().describe('Email address'),
        phone: z.string().optional().describe('Phone number'),
        title: z.string().optional().describe('Job title'),
        status: z.string().optional().describe('Lead status'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const updateData: Record<string, unknown> = { Id: args.lead_id };
        if (args.first_name) updateData.FirstName = args.first_name;
        if (args.last_name) updateData.LastName = args.last_name;
        if (args.company) updateData.Company = args.company;
        if (args.email) updateData.Email = args.email;
        if (args.phone) updateData.Phone = args.phone;
        if (args.title) updateData.Title = args.title;
        if (args.status) updateData.Status = args.status;
        if (args.fields) validateAndMergeCustomFields(updateData, args.fields);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await conn.sobject('Lead').update(updateData as any) as unknown as SaveResult;
        checkSaveResult(result, 'Failed to update lead');
        return JSON.stringify({ ok: true, status: 'success', object: 'Lead', id: args.lead_id });
      });
    }),
  );
}
