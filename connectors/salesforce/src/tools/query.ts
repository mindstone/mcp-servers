import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, validateObjectName, validateFields, isValidQueryFieldName, isValidFieldName, escapeSOQL, ALLOWED_FILTER_OPERATORS, validateAndMergeCustomFields, checkSaveResult } from '../utils.js';
import { withConnection } from '../client.js';
import { ConnectorError, type SaveResult } from '../types.js';

export function registerQueryTools(server: McpServer): void {
  server.registerTool(
    'salesforce_query',
    {
      description: `Execute a raw SOQL query. For advanced queries only — prefer dedicated tools for standard operations. Max 200 records enforced.`,
      inputSchema: z.object({
        query: z.string().min(1).describe('SOQL query string'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        let query = args.query.trim();
        const MAX_LIMIT = 200;
        const limitMatch = query.match(/\bLIMIT\s+(\d+)\s*$/i);
        if (limitMatch) {
          const currentLimit = parseInt(limitMatch[1], 10);
          if (currentLimit > MAX_LIMIT) {
            query = query.replace(/\bLIMIT\s+\d+\s*$/i, `LIMIT ${MAX_LIMIT}`);
          }
        } else {
          query = `${query} LIMIT ${MAX_LIMIT}`;
        }
        const result = await conn.query(query);
        return JSON.stringify({ ok: true, records: result.records, totalSize: result.totalSize, done: result.done });
      });
    }),
  );

  server.registerTool(
    'salesforce_describe_object',
    {
      description: `Get object metadata and field definitions. Returns field names, types, and required flags. Common objects: Account, Contact, Opportunity, Lead, Case, Task.`,
      inputSchema: z.object({
        object_name: z.string().min(1).describe('Object API name (Account, Contact, Opportunity, Lead, CustomObject__c)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const metadata = await conn.sobject(args.object_name).describe();
        return JSON.stringify({
          ok: true,
          name: metadata.name,
          label: metadata.label,
          labelPlural: metadata.labelPlural,
          fields: metadata.fields.map((f) => ({
            name: f.name,
            label: f.label,
            type: f.type,
            required: !f.nillable && !f.defaultedOnCreate,
            updateable: f.updateable,
            createable: f.createable,
          })),
          recordTypeInfos: metadata.recordTypeInfos,
        });
      });
    }),
  );

  server.registerTool(
    'salesforce_list_objects',
    {
      description: `List available Salesforce sObjects. Default shows custom objects only. Set custom_only=false to include standard objects.`,
      inputSchema: z.object({
        custom_only: z.boolean().optional().describe('Show only custom objects (default: true)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const result = await conn.describeGlobal();
        let objects = result.sobjects.map((s) => ({
          name: s.name,
          label: s.label,
          queryable: s.queryable,
          createable: s.createable,
          updateable: s.updateable,
          custom: s.custom,
        }));
        const customOnly = args.custom_only !== false;
        if (customOnly) objects = objects.filter((o) => o.custom);
        return JSON.stringify({ ok: true, objects, count: objects.length });
      });
    }),
  );

  server.registerTool(
    'salesforce_create_record',
    {
      description: `Generic record creation for any Salesforce object. For standard objects, prefer dedicated tools.`,
      inputSchema: z.object({
        object_name: z.string().min(1).describe('sObject API name (e.g., Invoice__c, Case)'),
        fields: z.record(z.unknown()).describe('Field-value pairs to set on the new record'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      validateObjectName(args.object_name);
      return withConnection(undefined, async (conn) => {
        const data: Record<string, unknown> = {};
        validateAndMergeCustomFields(data, args.fields);
        const result = await conn.sobject(args.object_name).create(data);
        if (!result.success) throw new ConnectorError(`Failed to create ${args.object_name} record`, 'CREATE_ERROR', JSON.stringify(result.errors));
        return JSON.stringify({ ok: true, status: 'success', object: args.object_name, id: result.id });
      });
    }),
  );

  server.registerTool(
    'salesforce_update_record',
    {
      description: `Generic record update for any Salesforce object. For standard objects, prefer dedicated tools.`,
      inputSchema: z.object({
        object_name: z.string().min(1).describe('sObject API name'),
        id: z.string().min(1).describe('Salesforce record ID to update'),
        fields: z.record(z.unknown()).describe('Field-value pairs to update'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      validateObjectName(args.object_name);
      return withConnection(undefined, async (conn) => {
        const updateData: Record<string, unknown> = { Id: args.id };
        validateAndMergeCustomFields(updateData, args.fields);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await conn.sobject(args.object_name).update(updateData as any) as unknown as SaveResult;
        checkSaveResult(result, `Failed to update ${args.object_name} record`);
        return JSON.stringify({ ok: true, status: 'success', object: args.object_name, id: args.id });
      });
    }),
  );

  server.registerTool(
    'salesforce_get_records',
    {
      description: `Generic record query for any Salesforce object. For standard objects, prefer dedicated get tools.`,
      inputSchema: z.object({
        object_name: z.string().min(1).describe('sObject API name'),
        fields: z.array(z.string()).optional().describe('Fields to SELECT (defaults to Id)'),
        filters: z.array(z.object({
          field: z.string().describe('Field API name'),
          operator: z.enum(['=', '!=', '<', '>', '<=', '>=', 'LIKE']).describe('Comparison operator'),
          value: z.union([z.string(), z.number(), z.boolean()]).describe('Filter value'),
        })).optional().describe('WHERE conditions (AND-joined)'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      validateObjectName(args.object_name);
      return withConnection(undefined, async (conn) => {
        const fields = validateFields(args.fields || [], ['Id'], isValidQueryFieldName);
        let soql = `SELECT ${fields.join(', ')} FROM ${args.object_name}`;
        if (args.filters && args.filters.length > 0) {
          const conditions: string[] = [];
          for (const filter of args.filters) {
            if (!isValidFieldName(filter.field)) {
              throw new ConnectorError(`Invalid filter field name: "${filter.field}"`, 'INVALID_FIELD_NAMES', 'Field names must be valid API names');
            }
            if (!ALLOWED_FILTER_OPERATORS.has(filter.operator)) {
              throw new ConnectorError(`Invalid filter operator: "${filter.operator}"`, 'INVALID_OPERATOR', `Allowed: ${[...ALLOWED_FILTER_OPERATORS].join(', ')}`);
            }
            let formattedValue: string;
            if (typeof filter.value === 'string') {
              formattedValue = `'${escapeSOQL(filter.value)}'`;
            } else {
              formattedValue = `${filter.value}`;
            }
            conditions.push(`${filter.field} ${filter.operator} ${formattedValue}`);
          }
          soql += ` WHERE ${conditions.join(' AND ')}`;
        }
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        soql += ` LIMIT ${limit}`;
        const result = await conn.query(soql);
        return JSON.stringify({ ok: true, records: result.records, totalSize: result.totalSize, done: result.done });
      });
    }),
  );
}
