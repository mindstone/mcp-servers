import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mixmaxFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';

function noApiTokenError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Mixmax API token not configured',
    resolution: 'To use Mixmax, you need to configure an API token first.',
    next_step: {
      action: 'The user adds the Mixmax API token in Settings → Connectors in the app. Do not ask for it in chat.',
      get_token_from: 'Mixmax Settings > Integrations > API Key section (requires Growth or Enterprise annual plan)',
    },
  });
}

export function registerUserTools(server: McpServer): void {
  server.registerTool(
    'get_mixmax_user',
    {
      description:
        `Get the current Mixmax user's profile and account info.

Returns:
- name, email: User identity
- plan: Current Mixmax plan (Growth, Enterprise, etc.)
- integrations: Connected services (Gmail, Salesforce, etc.)

USE CASES:
- Verify which account is connected
- Check plan level (relevant if a feature requires Enterprise)
- See what integrations the user has active`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async () => {
      if (!isConfigured()) return noApiTokenError();

      const data = await mixmaxFetch<Record<string, unknown>>('/users/me');

      return JSON.stringify({ ok: true, user: data });
    }),
  );
}
