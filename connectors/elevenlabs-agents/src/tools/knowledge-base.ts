import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey, elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { sanitizeKbDoc, sanitizeList } from '../sanitize.js';
import { withErrorHandling } from '../utils.js';

function extractItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.documents)) return obj.documents;
  if (Array.isArray(obj.knowledge_base_documents)) return obj.knowledge_base_documents;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

function extractNextCursor(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const obj = result as Record<string, unknown>;
  return typeof obj.next_cursor === 'string'
    ? obj.next_cursor
    : typeof obj.cursor === 'string'
      ? obj.cursor
      : typeof obj.last_doc === 'string'
        ? obj.last_doc
        : undefined;
}

export function registerKnowledgeBaseTools(server: McpServer): void {
  server.registerTool(
    'list_knowledge_base_docs',
    {
      description: `List knowledge-base documents in your ElevenLabs Conversational AI workspace.

WHEN TO USE:
- Discover document IDs before fetching one document in full
- Inventory the current knowledge base attached to your voice-agent workspace

EXAMPLE: {"page_size": 10}

RELATED TOOLS:
- get_knowledge_base_doc: fetch one returned documentation_id in detail
- list_agents: inspect which agents might rely on these documents

RETURNS: documents, count, next_cursor.

FREE.`,
      inputSchema: z.object({
        page_size: z.number().int().min(1).max(100).optional()
          .describe('Maximum number of documents to return (for live checks, use 1).'),
        cursor: z.string().optional().describe('Pagination cursor from the previous response.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const params = new URLSearchParams();
      if (args.page_size !== undefined) params.set('page_size', String(args.page_size));
      if (args.cursor) params.set('cursor', args.cursor);
      const qs = params.toString();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        `${ENDPOINTS.KNOWLEDGE_BASE}${qs ? `?${qs}` : ''}`,
        { method: 'GET' },
      );
      const items = extractItems(result);
      return JSON.stringify({
        ok: true,
        documents: sanitizeList(items, sanitizeKbDoc, 'elevenlabs-agents:list_knowledge_base_docs'),
        count: items.length,
        next_cursor: extractNextCursor(result),
        message: `Found ${items.length} knowledge-base document(s).`,
      });
    }),
  );

  server.registerTool(
    'get_knowledge_base_doc',
    {
      description: `Get one knowledge-base document, including text content when the API returns it.

WHEN TO USE:
- Inspect a specific document before later add/delete work
- Review the exact source text available to agents

EXAMPLE: {"documentation_id": "doc_123"}

RELATED TOOLS:
- list_knowledge_base_docs: discover valid documentation_id values
- get_agent: inspect which agents reference this knowledge base

RETURNS: document. Large content is capped to about 50KB with truncation metadata.

FREE.`,
      inputSchema: z.object({
        documentation_id: z.string().min(1).describe('Knowledge-base document ID to inspect.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.knowledgeBaseDoc(args.documentation_id),
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        document: sanitizeKbDoc(result, 'elevenlabs-agents:get_knowledge_base_doc'),
      });
    }),
  );
}
