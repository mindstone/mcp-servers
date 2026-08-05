import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeSOSL, sanitizeRecords } from '../utils.js';
import { withConnection } from '../client.js';

// Allowlisted object names + fixed RETURNING field lists: the only caller
// input reaching the SOSL string is the (escaped) search term, so object and
// field names can never be an injection vector.
const SEARCHABLE_OBJECTS = {
  Account: 'Account(Id, Name, Industry, Type)',
  Contact: 'Contact(Id, FirstName, LastName, Email, Title, AccountId)',
  Lead: 'Lead(Id, FirstName, LastName, Company, Email, Status)',
  Opportunity: 'Opportunity(Id, Name, StageName, Amount, CloseDate, AccountId)',
  Case: 'Case(Id, CaseNumber, Subject, Status, Priority)',
  Task: 'Task(Id, Subject, Status, Priority, ActivityDate)',
  Event: 'Event(Id, Subject, StartDateTime, EndDateTime)',
} as const;

type SearchableObject = keyof typeof SEARCHABLE_OBJECTS;

const DEFAULT_OBJECTS: SearchableObject[] = ['Account', 'Contact', 'Lead', 'Opportunity'];

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    'salesforce_search',
    {
      description: `Cross-object full-text search (SOSL). Use for "find anything mentioning X" requests — searches names, emails, and other indexed text fields at once. Defaults to Account, Contact, Lead, Opportunity; pass objects to widen or narrow. Max 200 results.`,
      inputSchema: z.object({
        search_term: z.string().min(2).describe('Text to search for (min 2 characters); reserved SOSL characters are escaped automatically'),
        objects: z
          .array(z.enum(['Account', 'Contact', 'Lead', 'Opportunity', 'Case', 'Task', 'Event']))
          .optional()
          .describe('Objects to search (default: Account, Contact, Lead, Opportunity)'),
        limit: z.number().int().min(1).max(200).optional().describe('Max total results 1-200 (default: 200)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const objects = (args.objects && args.objects.length > 0 ? args.objects : DEFAULT_OBJECTS) as SearchableObject[];
        const returning = objects.map((o) => SEARCHABLE_OBJECTS[o]).join(', ');
        const limit = Math.min(Math.max(1, args.limit ?? 200), 200);
        const sosl = `FIND {${escapeSOSL(args.search_term)}} IN ALL FIELDS RETURNING ${returning} LIMIT ${limit}`;
        const result = await conn.search(sosl);
        const records = result.searchRecords ?? [];
        return JSON.stringify({
          ok: true,
          records: sanitizeRecords(records, 'salesforce:search:records'),
          count: records.length,
        });
      });
    }),
  );
}
