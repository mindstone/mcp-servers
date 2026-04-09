import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeServiceNowInstanceInput, setCredentials } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_servicenow',
    {
      description:
        'Configure ServiceNow credentials. Call this when the user provides their instance name, username, and password. ' +
        'The instance name is the subdomain part of the URL (e.g., "acme" for acme.service-now.com). ' +
        'You can also paste the full URL. The account needs read/write access to incident, change_request, kb_knowledge, and sys_user tables. ' +
        'For production use, consider creating a dedicated integration user with appropriate roles (itil, knowledge).',
      inputSchema: z.object({
        instance: z
          .string()
          .min(1)
          .describe('ServiceNow instance name (e.g., "acme") or full URL (e.g., "https://acme.service-now.com")'),
        username: z.string().min(1).describe('ServiceNow username'),
        password: z.string().min(1).describe('ServiceNow password'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      const normalized = normalizeServiceNowInstanceInput(args.instance);
      const trimmedUsername = args.username.trim();
      const trimmedPassword = args.password.trim();

      if (!normalized) {
        return JSON.stringify({
          ok: false,
          error:
            'Invalid instance. Enter just the instance name (e.g., "acme"), or paste your ServiceNow URL (e.g., https://acme.service-now.com).',
        });
      }

      if (!trimmedUsername || !trimmedPassword) {
        return JSON.stringify({
          ok: false,
          error: 'instance, username, and password are all required.',
        });
      }

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/servicenow/configure', {
            instance: normalized,
            username: trimmedUsername,
            password: trimmedPassword,
          });
          if (result.success) {
            setCredentials(normalized, trimmedUsername, trimmedPassword);
            const message = result.warning
              ? `ServiceNow configured successfully for ${normalized}.service-now.com. Note: ${result.warning}`
              : `ServiceNow configured successfully for ${normalized}.service-now.com! Try list_servicenow_incidents or search_servicenow_knowledge.`;
            return JSON.stringify({ ok: true, message });
          }
          // Bridge returned error — fall through to in-memory only
        } catch {
          // Bridge request failed — fall through to in-memory only
        }
      }

      // No bridge or bridge failed — configure in-memory only
      setCredentials(normalized, trimmedUsername, trimmedPassword);
      return JSON.stringify({
        ok: true,
        message: `ServiceNow configured successfully for ${normalized}.service-now.com! Try list_servicenow_incidents or search_servicenow_knowledge.`,
      });
    }),
  );
}
