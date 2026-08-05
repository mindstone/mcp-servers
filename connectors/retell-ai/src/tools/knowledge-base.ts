import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retellFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { ConnectorError } from '../types.js';
import { resolveUploadPath } from './path-safety.js';
import { sanitizeKnowledgeBase, sanitizeList } from '../sanitize.js';

/** Retell limits knowledge-base uploads to 25 files, 50MB each. */
const MAX_KB_FILES = 25;
const MAX_KB_FILE_BYTES = 50 * 1024 * 1024;

const knowledgeBaseTextSchema = z.object({
  title: z.string().min(1).describe('Title of the text source (e.g. "Refund policy").'),
  text: z.string().min(1).describe('Full text content the agent should ground its answers on.'),
});

const knowledgeBaseSourcesSchema = {
  knowledge_base_texts: z.array(knowledgeBaseTextSchema).max(25).optional()
    .describe('Inline text sources to add (title + full text).'),
  knowledge_base_urls: z.array(z.string().url()).max(25).optional()
    .describe('Public URLs to scrape into the knowledge base (e.g. "https://example.com/faq").'),
  file_paths: z.array(z.string()).max(MAX_KB_FILES).optional()
    .describe(`Local files to upload (PDF, TXT, MD, etc.). Every path must resolve inside MCP_WORKSPACE_PATH (or the system temp directory when unset) — paths outside the workspace sandbox are rejected before any disk read. Max ${MAX_KB_FILES} files, 50MB each.`),
};

/**
 * Resolve and read sandbox-approved upload files, returning FormData-ready
 * parts. Throws a structured ConnectorError on the first sandbox violation —
 * fail-closed: no file outside the workspace is ever read from disk.
 */
function readUploadFiles(filePaths: string[]): Array<{ name: string; data: Buffer }> {
  const files: Array<{ name: string; data: Buffer }> = [];
  for (const inputPath of filePaths) {
    const resolved = resolveUploadPath(inputPath);
    if (!resolved.ok) {
      throw new ConnectorError(
        resolved.error,
        'FILE_OUTSIDE_WORKSPACE',
        'Place the file inside MCP_WORKSPACE_PATH (or the system temp directory) and retry with a path inside that sandbox.',
      );
    }
    const stat = fs.statSync(resolved.path);
    if (!stat.isFile()) {
      throw new ConnectorError(
        `file_path is not a regular file: ${inputPath}`,
        'INVALID_FILE',
        'Pass a path to a regular file inside the workspace sandbox.',
      );
    }
    if (stat.size > MAX_KB_FILE_BYTES) {
      throw new ConnectorError(
        `file_path exceeds Retell's 50MB knowledge-base file limit (${Math.round(stat.size / 1024 / 1024)}MB): ${inputPath}`,
        'FILE_TOO_LARGE',
        'Split the document or remove unneeded sections, then retry with a file under 50MB.',
      );
    }
    files.push({ name: path.basename(resolved.path), data: fs.readFileSync(resolved.path) });
  }
  return files;
}

function appendSourcesToForm(
  form: FormData,
  args: { knowledge_base_texts?: unknown; knowledge_base_urls?: unknown; file_paths?: string[] },
): void {
  // Mirror the Retell SDK's multipart encoding: non-file arrays are appended
  // as a single JSON-string field; files are appended one part per file.
  if (args.knowledge_base_texts) form.append('knowledge_base_texts', JSON.stringify(args.knowledge_base_texts));
  if (args.knowledge_base_urls) form.append('knowledge_base_urls', JSON.stringify(args.knowledge_base_urls));
  if (args.file_paths && args.file_paths.length > 0) {
    for (const file of readUploadFiles(args.file_paths)) {
      form.append('knowledge_base_files', new Blob([new Uint8Array(file.data)]), file.name);
    }
  }
}

export function registerKnowledgeBaseTools(server: McpServer): void {
  server.registerTool(
    'list_knowledge_bases',
    {
      description: `List all knowledge bases in your Retell account.

WHEN TO USE:
- Find knowledge_base_id values before attaching them to an agent or LLM
- Check processing status of a recently created knowledge base (in_progress → complete)
- Inventory check before creating a duplicate

COMMON MISTAKES:
- Creating a new knowledge base when a suitable one already exists; list first
- Attaching a knowledge base whose status is still "in_progress" — wait for "complete"

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key

RELATED TOOLS:
- get_knowledge_base: Inspect one knowledge base's sources and status
- create_knowledge_base: Create when nothing suitable exists
- add_knowledge_base_sources: Add documents to an existing knowledge base

RETURNS: knowledge_bases, count. Each includes knowledge_base_id, knowledge_base_name, status, sources (when processed), and chunking config.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      requireApiKey();
      const result = await retellFetch<unknown[]>(
        '/list-knowledge-bases',
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        knowledge_bases: sanitizeList(result, sanitizeKnowledgeBase, 'retell:list_knowledge_bases'),
        count: Array.isArray(result) ? result.length : 0,
        message: `Found ${Array.isArray(result) ? result.length : 0} knowledge base(s).`,
      });
    }),
  );

  server.registerTool(
    'get_knowledge_base',
    {
      description: `Get details of a specific knowledge base, including its sources and processing status.

WHEN TO USE:
- Check whether a knowledge base has finished processing (status "complete")
- List the documents/URLs/texts a knowledge base contains
- Verify a source was added before attaching the knowledge base to an agent

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: knowledge_base_id not found → list_knowledge_bases and retry with a returned ID

RELATED TOOLS:
- list_knowledge_bases: Discover knowledge_base_id values
- add_knowledge_base_sources: Add more documents/URLs/texts

RETURNS: knowledge_base_id, knowledge_base_name, status, knowledge_base_sources (type, filename/title/url, source_id), chunking config, auto-refresh settings.`,
      inputSchema: {
        knowledge_base_id: z.string().describe('The knowledge base ID to look up. Use list_knowledge_bases if you only know the name.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await retellFetch<Record<string, unknown>>(
        `/get-knowledge-base/${encodeURIComponent(args.knowledge_base_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeKnowledgeBase(result, 'retell:get_knowledge_base') as Record<string, unknown>),
      });
    }),
  );

  server.registerTool(
    'create_knowledge_base',
    {
      description: `Create a knowledge base (documents/URLs/texts) that agents can ground their answers on via RAG.

WHEN TO USE:
- Ground a voice agent on company docs, FAQs, or policies
- Collect source material before wiring knowledge_base_ids into a Retell LLM or agent

WORKFLOW:
1. create_knowledge_base → with texts, URLs, and/or local files
2. Poll get_knowledge_base until status is "complete"
3. Attach the knowledge_base_id to the agent's Retell LLM (knowledge_base_ids) — attach via update_retell_llm general_tools/config or the Retell dashboard

SOURCES (at least one recommended; a name-only knowledge base is allowed):
- knowledge_base_texts: inline title+text pairs
- knowledge_base_urls: public URLs Retell scrapes (set enable_auto_refresh to re-scrape every 12 hours)
- file_paths: local files uploaded from the workspace sandbox (MCP_WORKSPACE_PATH, or the system temp directory when unset). Max 25 files, 50MB each.

COMMON MISTAKES:
- Passing a file path outside MCP_WORKSPACE_PATH; it is rejected by the workspace sandbox before any disk read
- Expecting immediate availability; processing takes time — poll get_knowledge_base for status "complete"

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 422: invalid source shape → check texts have title+text and URLs are valid http(s) URLs

RELATED TOOLS:
- list_knowledge_bases/get_knowledge_base: Verify and inspect
- add_knowledge_base_sources: Add more sources later

RETURNS: knowledge_base_id, knowledge_base_name, status (starts "in_progress").`,
      inputSchema: {
        knowledge_base_name: z.string().min(1).max(40).describe('Name for the knowledge base (max 40 characters, e.g. "Support FAQ").'),
        enable_auto_refresh: z.boolean().optional().describe('Re-scrape the knowledge_base_urls every 12 hours. Default: false.'),
        ...knowledgeBaseSourcesSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const form = new FormData();
      form.append('knowledge_base_name', args.knowledge_base_name);
      if (args.enable_auto_refresh !== undefined) form.append('enable_auto_refresh', String(args.enable_auto_refresh));
      appendSourcesToForm(form, args);

      const result = await retellFetch<Record<string, unknown>>(
        '/create-knowledge-base',
        { method: 'POST', body: form },
      );

      return JSON.stringify({
        ok: true,
        ...(sanitizeKnowledgeBase(result, 'retell:create_knowledge_base') as Record<string, unknown>),
        message: `Knowledge base created (knowledge_base_id: ${result.knowledge_base_id}). Processing takes a moment — poll get_knowledge_base until status is "complete" before attaching it to an agent.`,
      });
    }),
  );

  server.registerTool(
    'add_knowledge_base_sources',
    {
      description: `Add new sources (texts, URLs, or local files) to an existing knowledge base.

WHEN TO USE:
- Extend a knowledge base with new documents without recreating it
- Add a freshly written FAQ/policy file to the agent's grounding material

NOTE: At least one of knowledge_base_texts, knowledge_base_urls, or file_paths is required. After adding, the knowledge base re-processes (status "refreshing_in_progress") — poll get_knowledge_base until "complete".

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: knowledge_base_id not found → list_knowledge_bases and retry
- 422: invalid source shape → check texts have title+text and URLs are valid

RELATED TOOLS:
- get_knowledge_base: Confirm the sources landed and processing finished
- create_knowledge_base: Create a separate knowledge base instead

RETURNS: knowledge_base_id, knowledge_base_name, status, updated sources.`,
      inputSchema: {
        knowledge_base_id: z.string().describe('The knowledge base to add sources to. Use list_knowledge_bases if unknown.'),
        ...knowledgeBaseSourcesSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (!args.knowledge_base_texts?.length && !args.knowledge_base_urls?.length && !args.file_paths?.length) {
        throw new ConnectorError(
          'At least one source is required: knowledge_base_texts, knowledge_base_urls, or file_paths.',
          'NO_SOURCES',
          'Pass at least one text ({title, text}), URL, or workspace-sandboxed file path to add.',
        );
      }
      requireApiKey();
      const form = new FormData();
      appendSourcesToForm(form, args);

      const result = await retellFetch<Record<string, unknown>>(
        `/add-knowledge-base-sources/${encodeURIComponent(args.knowledge_base_id)}`,
        { method: 'POST', body: form },
      );

      return JSON.stringify({
        ok: true,
        ...(sanitizeKnowledgeBase(result, 'retell:add_knowledge_base_sources') as Record<string, unknown>),
        message: `Sources added to knowledge base ${args.knowledge_base_id}. Poll get_knowledge_base until status is "complete".`,
      });
    }),
  );
}
