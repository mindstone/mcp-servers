import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { browserbaseFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { sanitizeContext } from '../sanitize.js';

export function registerContextTools(server: McpServer): void {
  server.registerTool(
    'create_context',
    {
      description: `Create a persistent browser context — a reusable container for cookies, local storage, and other browser state that survives across sessions.

WHEN TO USE:
- Persist a logged-in website session so later sessions/agents start authenticated
- Share browser state between runs

WORKFLOW:
1. create_context → get the context id
2. create_session with browser_settings.context = { id, persist: true } and sign in once
3. Later sessions reference the same context id to resume the signed-in state

NOTE: There is no list_contexts endpoint — record the returned id.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key

RELATED TOOLS:
- get_context: Inspect a context (including its encryption metadata)
- delete_context: Permanently remove a context and its stored state
- create_session: Use the context via browser_settings.context

RETURNS: id, publicKey, cipherAlgorithm, initializationVectorSize. The encryption fields describe how Browserbase encrypts the stored context state.`,
      inputSchema: {
        project_id: z.string().optional()
          .describe('Project ID to create the context in. Omit to use the project implied by the API key.'),
        name: z.string().min(1).max(128).optional()
          .describe('Optional human-readable name (e.g. "Acme Corp portal login"). Unique within the project among active contexts, compared case-insensitively.'),
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
      const body: Record<string, unknown> = {};
      if (args.project_id) body.projectId = args.project_id;
      if (args.name) body.name = args.name;

      const result = await browserbaseFetch<Record<string, unknown>>(
        '/contexts',
        { method: 'POST', body },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeContext(result, 'browserbase:create_context') as Record<string, unknown>),
        message: `Context created (id: ${result.id}). Save this id — contexts cannot be listed later. Use it in create_session via browser_settings.context.`,
      });
    }),
  );

  server.registerTool(
    'get_context',
    {
      description: `Get details of a persistent browser context.

WHEN TO USE:
- Verify a context still exists before referencing it in create_session
- Check which project a context belongs to

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: context_id not found (or deleted) → create a new one with create_context; contexts cannot be listed

RELATED TOOLS:
- create_context: Create a context
- delete_context: Remove it

RETURNS: id, projectId, name (when set), createdAt, updatedAt.`,
      inputSchema: {
        context_id: z.string().min(1).describe('The context ID returned by create_context.'),
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
      const result = await browserbaseFetch<Record<string, unknown>>(
        `/contexts/${encodeURIComponent(args.context_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeContext(result, 'browserbase:get_context') as Record<string, unknown>),
      });
    }),
  );

  server.registerTool(
    'delete_context',
    {
      description: `Permanently delete a browser context and all of its stored state (cookies, storage).

CRITICAL: There is no undo — any login sessions persisted in the context are gone. Confirm the context_id with get_context first.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: context_id not found → it may already be deleted

RELATED TOOLS:
- get_context: Confirm the context before deleting
- create_context: Create a replacement

RETURNS: ok, message. Browserbase returns HTTP 204 on success.`,
      inputSchema: {
        context_id: z.string().min(1).describe('The context ID to permanently delete. Confirm with get_context first.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      await browserbaseFetch<Record<string, unknown>>(
        `/contexts/${encodeURIComponent(args.context_id)}`,
        { method: 'DELETE' },
      );
      return JSON.stringify({
        ok: true,
        message: `Context ${args.context_id} deleted permanently.`,
      });
    }),
  );
}
