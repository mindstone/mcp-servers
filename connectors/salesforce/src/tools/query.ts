import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, validateObjectName, validateFields, isValidQueryFieldName, isValidFieldName, escapeSOQL, ALLOWED_FILTER_OPERATORS, validateAndMergeCustomFields, checkSaveResult, formatVendorErrors, sanitizeRecords, requireArg } from '../utils.js';
import { withConnection } from '../client.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { ConnectorError, type SaveResult } from '../types.js';

// Strip SQL-style line ("// ...") and block ("/* ... ") comments from a
// SOQL query. SOQL itself does not officially support either form, but
// we defensively strip both because callers (or attackers crafting
// tool-arguments) commonly use them to evade naive trailing-LIMIT
// regexes.
//
// The walker is QUOTE-AWARE: characters inside a SOQL single-quoted string
// literal are preserved verbatim. SOQL string literals support two escape
// forms for an embedded apostrophe: doubled-quote `''` and backslash-quote
// `\'`. We honour both, plus generic backslash-escapes (`\\`, `\n`, etc.)
// which simply consume the next character. Without quote-awareness, a
// query like `WHERE Website = 'https://example.com/path'` would be
// corrupted to `WHERE Website = 'https:` (unterminated literal), since
// the naive global regex would treat the `//` inside the quoted span as
// a line comment.
//
// The walker also reports whether the input ended INSIDE an unterminated
// string literal, which the caller needs to decide whether a trailing `;` is
// a statement terminator or data the user typed.
function stripSoqlComments(query: string): { text: string; endedInLiteral: boolean } {
  let out = '';
  let i = 0;
  let endedInLiteral = false;
  const n = query.length;
  while (i < n) {
    const ch = query[i];

    // Inside a single-quoted SOQL string literal: copy verbatim until the
    // matching close-quote, honouring backslash escapes and the doubled-
    // apostrophe escape ('').
    if (ch === "'") {
      out += ch;
      i++;
      let closed = false;
      while (i < n) {
        const c = query[i];
        if (c === '\\' && i + 1 < n) {
          // Generic backslash escape: keep both characters verbatim.
          out += c + query[i + 1];
          i += 2;
          continue;
        }
        if (c === "'") {
          // Doubled-apostrophe = literal apostrophe inside the literal.
          if (i + 1 < n && query[i + 1] === "'") {
            out += "''";
            i += 2;
            continue;
          }
          // Closing quote.
          out += "'";
          i++;
          closed = true;
          break;
        }
        out += c;
        i++;
      }
      if (!closed) endedInLiteral = true;
      continue;
    }

    // Outside any quoted literal: strip block + line comments.
    if (ch === '/' && i + 1 < n) {
      const next = query[i + 1];
      if (next === '*') {
        // Block comment: consume up to the closing */ (or EOF).
        i += 2;
        while (i < n && !(query[i] === '*' && i + 1 < n && query[i + 1] === '/')) {
          i++;
        }
        if (i < n) i += 2; // skip the closing */
        out += ' ';
        continue;
      }
      if (next === '/') {
        // Line comment: consume up to (but not including) the newline.
        i += 2;
        while (i < n && query[i] !== '\n') i++;
        out += ' ';
        continue;
      }
    }

    out += ch;
    i++;
  }
  return { text: out, endedInLiteral };
}

/**
 * Enforce a hard cap on the LIMIT clause of a caller-supplied SOQL query.
 *
 * The cap is applied AFTER stripping line and block comments and trailing
 * whitespace, so trailing-comment/whitespace bypass attempts (LIMIT 5000
 * followed by trailing whitespace, line comments, or block comments) are
 * neutralised. OFFSET clauses are preserved on the output side, and a
 * caller-supplied OFFSET-without-LIMIT triggers an inserted cap.
 *
 * The result is a single, syntactically valid SOQL statement with exactly
 * one `LIMIT <n>` clause where `n <= maxLimit`, and at most one trailing
 * `OFFSET <n>` clause.
 */
export function applyQueryLimitCap(rawQuery: string, maxLimit: number): string {
  const { text, endedInLiteral } = stripSoqlComments(rawQuery);
  const cleaned = text.trim();
  // Callers routinely paste a SQL-style statement terminator. SOQL has none,
  // and a trailing `;` would otherwise defeat the LIMIT/OFFSET matchers below
  // and reach Salesforce as a syntax error. A `;` inside a string literal is
  // data, so only strip when the query did not end inside an unterminated one
  // (a closed literal can never be the trailing run the pattern matches).
  let base = endedInLiteral ? cleaned : cleaned.replace(/[;\s]*;[;\s]*$/, '').trimEnd();
  let offsetClause = '';
  const offsetMatch = base.match(/^([\s\S]*?)\s+OFFSET\s+(\d+)\s*$/i);
  if (offsetMatch) {
    base = offsetMatch[1];
    offsetClause = ` OFFSET ${offsetMatch[2]}`;
  }
  const limitMatch = base.match(/^([\s\S]*?)\s+LIMIT\s+(\d+)\s*$/i);
  let head: string;
  let limit: number;
  if (limitMatch) {
    head = limitMatch[1].trimEnd();
    const current = parseInt(limitMatch[2], 10);
    limit = Math.min(current, maxLimit);
  } else {
    head = base.trimEnd();
    limit = maxLimit;
  }
  return `${head} LIMIT ${limit}${offsetClause}`;
}

export function registerQueryTools(server: McpServer): void {
  server.registerTool(
    'salesforce_query',
    {
      description: `Execute a raw SOQL query. For advanced queries only — prefer dedicated tools for standard operations. Max 200 records enforced.`,
      inputSchema: z.object({
        query: z.string().min(1).optional().describe('SOQL query string'),
        soql: z.string().min(1).optional().describe('Alias of query.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const rawQuery = requireArg({ query: args.query, soql: args.soql });
      return withConnection(undefined, async (conn) => {
        const MAX_LIMIT = 200;
        const query = applyQueryLimitCap(rawQuery, MAX_LIMIT);
        const result = await conn.query(query);
        return JSON.stringify({ ok: true, records: sanitizeRecords(result.records, 'salesforce:query:records'), totalSize: result.totalSize, done: result.done });
      });
    }),
  );

  server.registerTool(
    'salesforce_describe_object',
    {
      description: `Get object metadata and field definitions. Returns field names, types, and required flags. Common objects: Account, Contact, Opportunity, Lead, Case, Task.`,
      inputSchema: z.object({
        object_name: z.string().min(1).optional().describe('Object API name (Account, Contact, Opportunity, Lead, CustomObject__c)'),
        object: z.string().min(1).optional().describe('Alias of object_name.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const objectName = requireArg({ object_name: args.object_name, object: args.object });
      validateObjectName(objectName);
      return withConnection(undefined, async (conn) => {
        const metadata = await conn.sobject(objectName).describe();
        // Labels and record-type names are org-authored text — envelope them;
        // field API names stay raw (they are identifiers, reused in queries).
        return JSON.stringify({
          ok: true,
          name: metadata.name,
          label: wrapUntrusted(metadata.label, 'salesforce:describe_object:label'),
          labelPlural: wrapUntrusted(metadata.labelPlural, 'salesforce:describe_object:labelPlural'),
          fields: metadata.fields.map((f) => ({
            name: f.name,
            label: wrapUntrusted(f.label, 'salesforce:describe_object:field_label'),
            type: f.type,
            required: !f.nillable && !f.defaultedOnCreate,
            updateable: f.updateable,
            createable: f.createable,
          })),
          recordTypeInfos: sanitizeRecords(metadata.recordTypeInfos, 'salesforce:describe_object:recordTypeInfos'),
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
          label: wrapUntrusted(s.label, 'salesforce:list_objects:label'),
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
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      validateObjectName(args.object_name);
      return withConnection(undefined, async (conn) => {
        const data: Record<string, unknown> = {};
        validateAndMergeCustomFields(data, args.fields);
        const result = await conn.sobject(args.object_name).create(data);
        if (!result.success) throw new ConnectorError(`Failed to create ${args.object_name} record`, 'CREATE_ERROR', formatVendorErrors(result.errors));
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
        id: z.string().min(1).optional().describe('Salesforce record ID to update'),
        record_id: z.string().min(1).optional().describe('Alias of id.'),
        fields: z.record(z.unknown()).describe('Field-value pairs to update'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      validateObjectName(args.object_name);
      const recordId = requireArg({ id: args.id, record_id: args.record_id });
      return withConnection(undefined, async (conn) => {
        const updateData: Record<string, unknown> = { Id: recordId };
        validateAndMergeCustomFields(updateData, args.fields);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await conn.sobject(args.object_name).update(updateData as any) as unknown as SaveResult;
        checkSaveResult(result, `Failed to update ${args.object_name} record`);
        return JSON.stringify({ ok: true, status: 'success', object: args.object_name, id: recordId });
      });
    }),
  );

  server.registerTool(
    'salesforce_get_records',
    {
      description: `Generic record query for any Salesforce object. For standard objects, prefer dedicated get tools.`,
      inputSchema: z.object({
        object_name: z.string().min(1).optional().describe('sObject API name'),
        sobject: z.string().min(1).optional().describe('Alias of object_name.'),
        fields: z.union([z.array(z.string()), z.string()]).optional().describe('Fields to SELECT (defaults to Id); array or comma-separated string'),
        record_id: z.string().min(1).optional().describe('Fetch one record by ID (adds an Id = ... condition)'),
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
      const objectName = requireArg({ object_name: args.object_name, sobject: args.sobject });
      validateObjectName(objectName);
      return withConnection(undefined, async (conn) => {
        // Callers pass either a list or the comma-separated string they would
        // type into a SELECT; both land in the same field-name validator.
        const requestedFields = typeof args.fields === 'string'
          ? args.fields.split(',').map((f) => f.trim()).filter((f) => f.length > 0)
          : args.fields;
        const fields = validateFields(requestedFields || [], ['Id'], isValidQueryFieldName);
        let soql = `SELECT ${fields.join(', ')} FROM ${objectName}`;
        const conditions: string[] = [];
        if (args.record_id) conditions.push(`Id = '${escapeSOQL(args.record_id)}'`);
        if (args.filters && args.filters.length > 0) {
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
        }
        if (conditions.length > 0) soql += ` WHERE ${conditions.join(' AND ')}`;
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        soql += ` LIMIT ${limit}`;
        const result = await conn.query(soql);
        return JSON.stringify({ ok: true, records: sanitizeRecords(result.records, 'salesforce:get_records:records'), totalSize: result.totalSize, done: result.done });
      });
    }),
  );
}
