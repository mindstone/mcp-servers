import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { browserbaseFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { buildUploadFormData } from './file-upload.js';

const FILE_PATH_HINT =
  'Local path to the CA certificate file (PEM/DER). The path must resolve inside MCP_WORKSPACE_PATH (or the system temp directory when unset) — paths outside the workspace sandbox are rejected before any disk read.';

export function registerCertificateTools(server: McpServer): void {
  server.registerTool(
    'upload_certificate',
    {
      description: `Upload a CA certificate so sessions using TLS-inspecting (external) proxies can trust it.

WHEN TO USE:
- You route sessions through your own intercepting proxy and the browser must trust its CA — reference the returned certificate id via create_session proxy_settings.ca_certificates

SECURITY: file_path is sandboxed — the path must resolve inside MCP_WORKSPACE_PATH (or the system temp directory when unset); anything outside is rejected before any disk read.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 400: invalid upload → the file must be a valid certificate
- FILE_OUTSIDE_WORKSPACE: move the file into the workspace directory first

RELATED TOOLS:
- list_certificates / get_certificate: Verify uploads
- delete_certificate: Remove a certificate
- create_session: Reference certificate IDs in proxy_settings

RETURNS: id, projectId, createdAt, updatedAt.`,
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
        '/certificates',
        { method: 'POST', body: form },
      );
      return JSON.stringify({
        ok: true,
        ...result,
        message: `Certificate uploaded (id: ${result.id}). Reference it in create_session via proxy_settings.ca_certificates.`,
      });
    }),
  );

  server.registerTool(
    'list_certificates',
    {
      description: `List CA certificates uploaded to the account.

WHEN TO USE:
- Find certificate IDs to reference in create_session proxy_settings.ca_certificates

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key

RELATED TOOLS:
- upload_certificate: Add a certificate
- get_certificate / delete_certificate: Manage one

RETURNS: certificates, count. Each includes id, projectId, createdAt, updatedAt.`,
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
      const result = await browserbaseFetch<unknown[]>('/certificates', { method: 'GET' });
      const certificates = Array.isArray(result) ? result : [];
      return JSON.stringify({
        ok: true,
        certificates,
        count: certificates.length,
        message: `Found ${certificates.length} certificate(s).`,
      });
    }),
  );

  server.registerTool(
    'get_certificate',
    {
      description: `Get details of an uploaded CA certificate.

WHEN TO USE:
- Verify a certificate still exists before referencing it in create_session proxy_settings

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: certificate_id not found → list_certificates for valid IDs

RELATED TOOLS:
- list_certificates: Discover certificate IDs
- delete_certificate: Remove it

RETURNS: id, projectId, createdAt, updatedAt.`,
      inputSchema: {
        certificate_id: z.string().min(1).describe('The certificate ID (from list_certificates or upload_certificate).'),
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
        `/certificates/${encodeURIComponent(args.certificate_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({ ok: true, ...result });
    }),
  );

  server.registerTool(
    'delete_certificate',
    {
      description: `Permanently delete an uploaded CA certificate.

CRITICAL: There is no undo. New sessions referencing this certificate in proxy_settings.ca_certificates will fail — check nothing still depends on it first.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: certificate_id not found → it may already be deleted

RELATED TOOLS:
- list_certificates / get_certificate: Confirm before deleting
- upload_certificate: Re-upload a replacement

RETURNS: ok, message. Browserbase returns HTTP 204 on success.`,
      inputSchema: {
        certificate_id: z.string().min(1).describe('The certificate ID to permanently delete. Confirm with get_certificate first.'),
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
        `/certificates/${encodeURIComponent(args.certificate_id)}`,
        { method: 'DELETE' },
      );
      return JSON.stringify({
        ok: true,
        message: `Certificate ${args.certificate_id} deleted permanently.`,
      });
    }),
  );
}
