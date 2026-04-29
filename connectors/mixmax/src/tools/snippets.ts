import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mixmaxFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import type { SnippetsResponse } from '../types.js';

function noApiTokenError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Mixmax API token not configured',
    resolution: 'To use Mixmax, you need to configure an API token first.',
    next_step: {
      action: 'Ask the user for their Mixmax API token, then call configure_mixmax_api_key',
      tool_to_call: 'configure_mixmax_api_key',
      tool_parameters: { api_key: '<user_provided_token>' },
      get_token_from: 'Mixmax Settings > Integrations > API Key section (requires Growth or Enterprise annual plan)',
    },
  });
}

export function registerSnippetTools(server: McpServer): void {
  server.registerTool(
    'list_mixmax_snippets',
    {
      description:
        `List Mixmax email templates (called "snippets" in Mixmax).

Returns for each snippet:
- _id: Use with send_mixmax_snippet to send it
- name: Template name
- subject: Email subject line the template uses
- body: HTML body content (check for template variables like {{first_name}})
- isShared: Whether it's shared with the team or personal

WORKFLOW FOR SENDING A TEMPLATE:
1. list_mixmax_snippets to browse available templates
2. Review the body for template variables (e.g. {{first_name}}, {{company}})
3. send_mixmax_snippet with the _id, recipients, and matching variables

PAGINATION: Cursor-based. If hasNext is true, pass the "next" value as the next parameter.`,
      inputSchema: z.object({
        limit: z.number().min(1).max(100).default(25).describe('Maximum results to return (default: 25)'),
        next: z.string().optional().describe('Cursor for next page (from previous response)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiTokenError();

      let path = `/snippets?limit=${args.limit}`;
      if (args.next) path += `&next=${encodeURIComponent(args.next)}`;

      const data = await mixmaxFetch<SnippetsResponse>(path);

      return JSON.stringify({
        ok: true,
        snippets: data.results || [],
        count: (data.results || []).length,
        hasNext: data.hasNext ?? false,
        ...(data.next ? { next: data.next } : {}),
      });
    }),
  );

  server.registerTool(
    'send_mixmax_snippet',
    {
      description:
        `Send a Mixmax template (snippet) to one or more recipients.

IMPORTANT: Confirm with the user before sending — this sends a real email using the template content.

WORKFLOW:
1. list_mixmax_snippets to find the template and its _id
2. Check the snippet body for template variables (e.g. {{first_name}}, {{company}})
3. Confirm recipients and variable values with user
4. Call this tool with matching variables

NOTE: Variables are applied to ALL recipients equally. If you need different variables per recipient, send one at a time.`,
      inputSchema: z.object({
        snippetId: z.string().min(1).describe('The _id of the snippet/template (from list_mixmax_snippets)'),
        to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
        variables: z.record(z.unknown()).optional().describe('Template variables matching {{placeholders}} in the snippet body'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiTokenError();

      const payload: Record<string, unknown> = {
        to: args.to.map((email) => ({ email })),
      };
      if (args.variables) payload.variables = args.variables;

      const data = await mixmaxFetch<Record<string, unknown>>(
        `/snippets/${encodeURIComponent(args.snippetId)}/send`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      );

      return JSON.stringify({
        ok: true,
        message: `Snippet sent to ${args.to.join(', ')}.`,
        result: data,
      });
    }),
  );
}
