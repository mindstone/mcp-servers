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
      action: 'Ask the user for their Mixmax API token, then call configure_mixmax_api_key',
      tool_to_call: 'configure_mixmax_api_key',
      tool_parameters: { api_key: '<user_provided_token>' },
      get_token_from: 'Mixmax Settings > Integrations > API Key section (requires Growth or Enterprise annual plan)',
    },
  });
}

export function registerMeetingTools(server: McpServer): void {
  server.registerTool(
    'list_mixmax_meeting_types',
    {
      description:
        `List Mixmax meeting/scheduling link types configured by the user.

Returns for each meeting type:
- name: Meeting type label (e.g. "30 min intro call", "60 min deep dive")
- duration: Length in minutes
- location: Where the meeting happens (Zoom, Google Meet, phone, etc.)
- slug / link: The booking URL that can be shared with contacts

USE CASES:
- "Share my scheduling link" — find the meeting type, give the user the booking URL to share
- "What meeting types do I have?" — list them with durations and locations
- "Send Alice my 30-min call link" — find the right type, then use the URL in send_mixmax_email`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async () => {
      if (!isConfigured()) return noApiTokenError();

      const data = await mixmaxFetch<{ results?: unknown[] }>(
        '/meetingtypes',
      );

      return JSON.stringify({
        ok: true,
        meetingTypes: data.results || data,
        count: Array.isArray(data.results) ? data.results.length : undefined,
      });
    }),
  );
}
