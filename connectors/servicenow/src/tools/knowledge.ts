import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { servicenowFetch, buildQueryParams } from '../client.js';
import { withErrorHandling } from '../utils.js';

export function registerKnowledgeTools(server: McpServer): void {
  // ── search_servicenow_knowledge ───────────────────────────────

  server.registerTool(
    'search_servicenow_knowledge',
    {
      description:
        'Search knowledge base articles in ServiceNow. ' +
        'Returns: number, short_description, sys_created_on, author, kb_knowledge_base, workflow_state. ' +
        'Simple text queries are automatically converted to LIKE queries. ' +
        'For advanced filtering, use ServiceNow encoded query syntax directly.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Search keywords or ServiceNow encoded query'),
        limit: z
          .number()
          .optional()
          .default(20)
          .describe('Max results to return (default: 20)'),
        offset: z
          .number()
          .optional()
          .default(0)
          .describe('Offset for pagination (default: 0)'),
      }),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async (args) => {
      let query = args.query;

      // If the query doesn't look like an encoded query, treat it as a keyword search
      if (query && !query.includes('=') && !query.includes('^')) {
        query = `short_descriptionLIKE${query}^ORtextLIKE${query}`;
      }

      const params = buildQueryParams({
        sysparm_limit: args.limit ?? 20,
        sysparm_offset: args.offset ?? 0,
        sysparm_display_value: 'true',
        sysparm_fields:
          'number,short_description,sys_created_on,author,kb_knowledge_base,workflow_state',
        sysparm_query: query,
      });
      const articles = await servicenowFetch<Array<Record<string, unknown>>>(
        `/kb_knowledge${params}`,
      );
      return JSON.stringify({ ok: true, articles, count: articles.length });
    }),
  );

  // ── get_servicenow_knowledge_article ──────────────────────────

  server.registerTool(
    'get_servicenow_knowledge_article',
    {
      description:
        'Get a full knowledge base article by sys_id or number (e.g., KB0010001). ' +
        'Returns the full article record including the article body text.',
      inputSchema: z.object({
        identifier: z
          .string()
          .min(1)
          .describe('KB article number (e.g., KB0010001) or sys_id'),
      }),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async (args) => {
      if (args.identifier.toUpperCase().startsWith('KB')) {
        const params = buildQueryParams({
          sysparm_query: `number=${args.identifier}`,
          sysparm_limit: 1,
          sysparm_display_value: 'true',
        });
        const results = await servicenowFetch<Array<Record<string, unknown>>>(
          `/kb_knowledge${params}`,
        );
        if (results.length === 0) {
          return JSON.stringify({
            ok: false,
            error: `Knowledge article ${args.identifier} not found.`,
          });
        }
        return JSON.stringify({ ok: true, article: results[0] });
      }
      const article = await servicenowFetch<Record<string, unknown>>(
        `/kb_knowledge/${encodeURIComponent(args.identifier)}?sysparm_display_value=true`,
      );
      return JSON.stringify({ ok: true, article });
    }),
  );
}
