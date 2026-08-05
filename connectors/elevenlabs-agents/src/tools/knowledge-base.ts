import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  requireApiKey,
  elevenLabsFetch,
  elevenLabsJson,
} from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { sanitizeAgentOrKbValue, sanitizeKbDoc, sanitizeList } from '../sanitize.js';
import { ElevenLabsError } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { readSandboxedFile, sandboxedFileToBlob } from './file-input.js';
import { validatePublicHttpsUrl } from '../url-safety.js';

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

const kbSharedFields = {
  name: z.string().min(1).optional().describe('Optional human-readable name for the document.'),
  parent_folder_id: z.string().min(1).optional()
    .describe('Optional folder ID to place the document under.'),
} satisfies Record<string, z.ZodTypeAny>;

const KB_SOURCE_FIELDS = ['text', 'file_path', 'url'] as const;
type KnowledgeBaseDocumentMode = 'text' | 'file' | 'url';

const addKnowledgeBaseDocumentSchema = z.object({
  text: z.string().min(1).optional().describe('Text content to add to the knowledge base.'),
  file_path: z.string().min(1).optional()
    .describe('Absolute path to a local file inside MCP_WORKSPACE_PATH (or os.tmpdir() when unset).'),
  url: z.string().url().optional()
    .describe('Public URL that ElevenLabs should fetch server-side. Must be https on a public host; loopback, private, link-local, and cloud-metadata addresses are rejected.'),
  enable_auto_sync: z.boolean().optional()
    .describe('When true, keep the URL document in sync. Default: false.'),
  auto_remove: z.boolean().optional()
    .describe('When true, auto-remove the URL document if it becomes unavailable.'),
  ...kbSharedFields,
});

function buildKnowledgeBaseBody(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined) {
      body[key] = value;
    }
  }
  return body;
}

function resolveKnowledgeBaseDocumentMode(args: Record<string, unknown>): KnowledgeBaseDocumentMode {
  const providedFields = KB_SOURCE_FIELDS.filter((field) => args[field] !== undefined);

  if (providedFields.length !== 1) {
    const received = providedFields.length > 0 ? providedFields.join(', ') : 'none';
    throw new ElevenLabsError(
      `Provide exactly one content source: text, file_path, or url. Received: ${received}.`,
      'INVALID_ARGUMENTS',
      'Send exactly one of text, file_path, or url, then retry.',
    );
  }

  const [modeField] = providedFields;
  switch (modeField) {
    case 'text':
      return 'text';
    case 'file_path':
      return 'file';
    case 'url':
      return 'url';
    default:
      throw new ElevenLabsError(
        `Unsupported content source field: ${String(modeField)}`,
        'INVALID_ARGUMENTS',
        'Send exactly one of text, file_path, or url, then retry.',
      );
  }
}

/** GET /knowledge-base/{id}/content returns raw document text (not JSON). */
async function fetchKbDocContent(apiKey: string, documentationId: string): Promise<string | undefined> {
  try {
    const response = await elevenLabsFetch(
      apiKey,
      ENDPOINTS.knowledgeBaseDocContent(documentationId),
      { method: 'GET' },
    );
    const text = await response.text();
    return text.trim().length > 0 ? text : undefined;
  } catch {
    // Non-200 or transport failure: metadata-only result, no throw.
    return undefined;
  }
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
      description: `Get one knowledge-base document: metadata from GET /knowledge-base/{id}, plus body text from GET /knowledge-base/{id}/content when available.

WHEN TO USE:
- Inspect a specific document before later add/delete work
- Review metadata (type, URL sync flags) and the text agents can retrieve

EXAMPLE: {"documentation_id": "doc_123"}

RELATED TOOLS:
- list_knowledge_base_docs: discover valid documentation_id values
- get_agent: inspect which agents reference this knowledge base

RETURNS: document metadata. Body text is fetched from the separate /content endpoint, enveloped, and capped to about 50KB with truncation metadata. URL documents may also include enveloped extracted_inner_html on the metadata response.

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
      const metadata = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.knowledgeBaseDoc(args.documentation_id),
        { method: 'GET' },
      );
      const contentText = await fetchKbDocContent(apiKey, args.documentation_id);
      const merged = isObj(metadata)
        ? {
            ...metadata,
            ...(contentText !== undefined ? { content: contentText } : {}),
          }
        : metadata;
      return JSON.stringify({
        ok: true,
        document: sanitizeKbDoc(merged, 'elevenlabs-agents:get_knowledge_base_doc'),
      });
    }),
  );

  server.registerTool(
    'add_knowledge_base_document',
    {
      description: `Add one knowledge-base document in text, file, or URL mode.

WHEN TO USE:
- Add a short text snippet directly
- Upload a local file from MCP_WORKSPACE_PATH
- Register a stable public URL that ElevenLabs fetches server-side

EXAMPLE: {"text": "Refunds are processed within 3 business days.", "name": "Refund policy"}
EXAMPLE: {"file_path": "/tmp/rebel-live-test-kb.txt", "name": "Release checklist"}
EXAMPLE: {"url": "https://example.com", "enable_auto_sync": false}

RELATED TOOLS:
- get_knowledge_base_doc: inspect the created document
- delete_knowledge_base_document: remove the document when it is no longer needed
- update_agent: attach returned knowledge-base IDs through first-class fields or advanced_config

RETURNS: document.

COST: FREE for the write itself; URL fetches and downstream agent usage may consume workspace resources.

COMMON MISTAKES:
- file mode only accepts local paths inside MCP_WORKSPACE_PATH (or os.tmpdir() when unset).
- Provide exactly one content source field: text, file_path, or url.
- url mode expects a stable public https URL that ElevenLabs can reach server-side (loopback, private, link-local, and cloud-metadata addresses are rejected).`,
      inputSchema: addKnowledgeBaseDocumentSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const mode = resolveKnowledgeBaseDocumentMode(args as Record<string, unknown>);
      let result: unknown;

      if (mode === 'text') {
        result = await elevenLabsJson<unknown>(
          apiKey,
          ENDPOINTS.KNOWLEDGE_BASE_TEXT,
          {
            method: 'POST',
            body: JSON.stringify(buildKnowledgeBaseBody(args, ['text', 'name', 'parent_folder_id'])),
          },
        );
      } else if (mode === 'file') {
        if (typeof args.file_path !== 'string') {
          throw new ElevenLabsError(
            'file_path is required when uploading a knowledge-base file.',
            'INVALID_ARGUMENTS',
            'Provide file_path and retry the upload.',
          );
        }
        const fileInput = readSandboxedFile(args.file_path);
        const formData = new FormData();
        formData.append('file', sandboxedFileToBlob(fileInput), fileInput.fileName);
        if (args.name) {
          formData.append('name', args.name);
        }
        if (args.parent_folder_id) {
          formData.append('parent_folder_id', args.parent_folder_id);
        }

        result = await elevenLabsJson<unknown>(
          apiKey,
          ENDPOINTS.KNOWLEDGE_BASE_FILE,
          {
            method: 'POST',
            body: formData,
          },
        );
      } else {
        if (typeof args.url !== 'string') {
          throw new ElevenLabsError(
            'url is required when adding a knowledge-base document in url mode.',
            'INVALID_ARGUMENTS',
            'Provide url and retry.',
          );
        }
        // ElevenLabs fetches this URL server-side, so the same public-https
        // policy as webhook tools applies (see src/url-safety.ts).
        validatePublicHttpsUrl('url', args.url);
        result = await elevenLabsJson<unknown>(
          apiKey,
          ENDPOINTS.KNOWLEDGE_BASE_URL,
          {
            method: 'POST',
            body: JSON.stringify(
              buildKnowledgeBaseBody(
                args,
                ['url', 'name', 'parent_folder_id', 'enable_auto_sync', 'auto_remove'],
              ),
            ),
          },
        );
      }

      return JSON.stringify({
        ok: true,
        document: sanitizeKbDoc(result, 'elevenlabs-agents:add_knowledge_base_document'),
        message: `Added knowledge-base document via ${mode} mode.`,
      });
    }),
  );

  server.registerTool(
    'delete_knowledge_base_document',
    {
      description: `Delete one knowledge-base document or folder from ElevenLabs.

WHEN TO USE:
- Remove a temporary rebel-live-test-* document after validation
- Clean up a stale or incorrect document before re-adding it

EXAMPLE: {"documentation_id": "doc_123", "force": true}

RELATED TOOLS:
- get_knowledge_base_doc: confirm the exact document before deleting it
- add_knowledge_base_document: re-create the document after fixing source content

RETURNS: ok confirmation.

COST: FREE — no generation credits, but this is destructive.`,
      inputSchema: z.object({
        documentation_id: z.string().min(1).describe('Knowledge-base document ID to delete.'),
        force: z.boolean().optional()
          .describe('When true, delete even if the document is attached to agents.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const params = new URLSearchParams();
      if (args.force !== undefined) {
        params.set('force', String(args.force));
      }
      const endpoint = params.size > 0
        ? `${ENDPOINTS.knowledgeBaseDoc(args.documentation_id)}?${params.toString()}`
        : ENDPOINTS.knowledgeBaseDoc(args.documentation_id);

      try {
        await elevenLabsFetch(apiKey, endpoint, { method: 'DELETE' });
      } catch (error) {
        if (error instanceof ElevenLabsError && error.code === 'HTTP_404') {
          throw new ElevenLabsError(
            `Knowledge-base document not found: ${args.documentation_id}`,
            'KNOWLEDGE_BASE_DOCUMENT_NOT_FOUND',
            'Re-list knowledge-base documents and retry with the exact returned documentation_id.',
          );
        }
        throw error;
      }

      return JSON.stringify({
        ok: true,
        documentation_id: args.documentation_id,
        force: args.force ?? false,
        message: `Deleted knowledge-base document ${args.documentation_id}.`,
      });
    }),
  );

  server.registerTool(
    'get_knowledge_base_rag_index_status',
    {
      description: `Get the RAG index status for one knowledge-base document, so you can tell when uploaded content is retrievable by agents.

WHEN TO USE:
- After add_knowledge_base_document, to confirm indexing has finished before testing retrieval
- To diagnose why an agent is not using a document's content

EXAMPLE: {"documentation_id": "doc_123"}

RELATED TOOLS:
- add_knowledge_base_document: upload the document first
- rebuild_knowledge_base_rag_index: trigger indexing when the status is missing or failed
- get_knowledge_base_doc: inspect the document itself

RETURNS: indexes (per embedding model: status, progress_percentage, used bytes).

FREE.`,
      inputSchema: z.object({
        documentation_id: z.string().min(1).describe('Knowledge-base document ID whose RAG indexes should be inspected.'),
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
        ENDPOINTS.knowledgeBaseRagIndex(args.documentation_id),
        { method: 'GET' },
      );
      const indexes = isObj(result) && Array.isArray(result.indexes) ? result.indexes : [];
      return JSON.stringify({
        ok: true,
        documentation_id: args.documentation_id,
        indexes: sanitizeList(indexes, sanitizeAgentOrKbValue, 'elevenlabs-agents:get_knowledge_base_rag_index_status'),
        message: indexes.length > 0
          ? `Found ${indexes.length} RAG index(es) for document ${args.documentation_id}.`
          : `No RAG index found for document ${args.documentation_id}; call rebuild_knowledge_base_rag_index to start one.`,
      });
    }),
  );

  server.registerTool(
    'rebuild_knowledge_base_rag_index',
    {
      description: `Trigger RAG indexing for one knowledge-base document (or read back its current index status when already indexed).

WHEN TO USE:
- Right after add_knowledge_base_document, so retrieval is ready before an agent is tested
- When get_knowledge_base_rag_index_status shows a missing or failed index

EXAMPLE: {"documentation_id": "doc_123"}

RELATED TOOLS:
- get_knowledge_base_rag_index_status: poll the status afterwards
- add_knowledge_base_document: create the document first

RETURNS: rag_index (id, model, status, progress_percentage, used bytes).

COST: FREE — indexing consumes workspace compute, and calling this on an already-indexed document just returns the current status.`,
      inputSchema: z.object({
        documentation_id: z.string().min(1).describe('Knowledge-base document ID to (re)index.'),
        model: z.enum(['e5_mistral_7b_instruct', 'multilingual_e5_large_instruct']).optional()
          .describe('Embedding model to index with. Default: "e5_mistral_7b_instruct".'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.knowledgeBaseRagIndex(args.documentation_id),
        {
          method: 'POST',
          body: JSON.stringify({ model: args.model ?? 'e5_mistral_7b_instruct' }),
        },
      );
      return JSON.stringify({
        ok: true,
        documentation_id: args.documentation_id,
        rag_index: sanitizeAgentOrKbValue(result, 'elevenlabs-agents:rebuild_knowledge_base_rag_index'),
        message: `RAG indexing requested for document ${args.documentation_id}.`,
      });
    }),
  );
}
