import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { browserbaseFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { buildUploadFormData } from './file-upload.js';
import { sanitizeExtension } from '../sanitize.js';

const FILE_PATH_HINT =
  'Local path to the zipped Chrome extension (.zip). The path must resolve inside MCP_WORKSPACE_PATH (or the system temp directory when unset) — paths outside the workspace sandbox are rejected before any disk read.';

export function registerExtensionTools(server: McpServer): void {
  server.registerTool(
    'upload_extension',
    {
      description: `Upload a zipped Chrome extension so sessions can load it (ad blockers, automation helpers, etc.).

WHEN TO USE:
- Sessions need a browser extension loaded — pass the returned extension id as extension_id to create_session

WORKFLOW:
1. Zip the extension directory (manifest.json at the zip root)
2. upload_extension → get the extension id
3. create_session with extension_id (or browser_settings.extension_id)

SECURITY: file_path is sandboxed — the path must resolve inside MCP_WORKSPACE_PATH (or the system temp directory when unset); anything outside is rejected before any disk read.

NOTE: There is no list_extensions endpoint — record the returned id.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 400: invalid upload → the file must be a valid zipped extension
- FILE_OUTSIDE_WORKSPACE: move the zip into the workspace directory first

RELATED TOOLS:
- get_extension: Verify an upload
- delete_extension: Remove it
- create_session: Load the extension in a session

RETURNS: id, fileName, projectId, createdAt, updatedAt.`,
      inputSchema: {
        file_path: z.string().min(1).describe(FILE_PATH_HINT),
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
      const form = await buildUploadFormData(args.file_path);
      const result = await browserbaseFetch<Record<string, unknown>>(
        '/extensions',
        { method: 'POST', body: form },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeExtension(result, 'browserbase:upload_extension') as Record<string, unknown>),
        message: `Extension uploaded (id: ${result.id}). Save this id — extensions cannot be listed later. Load it in a session via create_session extension_id.`,
      });
    }),
  );

  server.registerTool(
    'get_extension',
    {
      description: `Get details of an uploaded extension.

WHEN TO USE:
- Verify an extension still exists before referencing it in create_session

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: extension_id not found → it may have been deleted; there is no list endpoint, so re-upload with upload_extension if lost

RELATED TOOLS:
- upload_extension: Upload a new extension
- delete_extension: Remove it

RETURNS: id, fileName, projectId, createdAt, updatedAt.`,
      inputSchema: {
        extension_id: z.string().min(1).describe('The extension ID returned by upload_extension.'),
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
        `/extensions/${encodeURIComponent(args.extension_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeExtension(result, 'browserbase:get_extension') as Record<string, unknown>),
      });
    }),
  );

  server.registerTool(
    'delete_extension',
    {
      description: `Permanently delete an uploaded extension.

CRITICAL: There is no undo. Sessions created afterwards can no longer load it (existing sessions are unaffected).

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: extension_id not found → it may already be deleted

RELATED TOOLS:
- get_extension: Confirm the extension before deleting
- upload_extension: Re-upload a replacement

RETURNS: ok, message. Browserbase returns HTTP 204 on success.`,
      inputSchema: {
        extension_id: z.string().min(1).describe('The extension ID to permanently delete. Confirm with get_extension first.'),
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
        `/extensions/${encodeURIComponent(args.extension_id)}`,
        { method: 'DELETE' },
      );
      return JSON.stringify({
        ok: true,
        message: `Extension ${args.extension_id} deleted permanently.`,
      });
    }),
  );
}
