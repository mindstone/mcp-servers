import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mixmaxFetch } from '../client.js';
import { withErrorHandling, parseApiResponse } from '../utils.js';
import { isConfigured } from '../auth.js';
import { meetingTypesResponseSchema } from '../types.js';
import { sanitizeMeetingTypes } from '../sanitize.js';

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

export function registerMeetingTools(server: McpServer): void {
  server.registerTool(
    'list_mixmax_meeting_types',
    {
      description:
        `List Mixmax meeting/scheduling link types configured by the user.

Returns for each meeting type:
- name: Meeting type label (e.g. "30 min intro call")
- durationMin: Length in minutes
- link: The booking URL slug that can be shared with contacts
- day0–day6: Per-weekday availability windows (enabled flag plus HH:mm:ss timeslots)
- daysFromNow: How far ahead this meeting type can be booked

USE CASES:
- "Share my scheduling link" — find the meeting type, give the user the booking URL to share
- "What meeting types do I have?" — list them with durations and availability windows
- "Send Alice my 30-min call link" — find the right type, then use the URL in send_mixmax_email`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async () => {
      if (!isConfigured()) return noApiTokenError();

      const parsed = parseApiResponse(
        meetingTypesResponseSchema,
        await mixmaxFetch<unknown>('/meetingtypes'),
        'meeting types list',
      );
      const meetingTypes = Array.isArray(parsed) ? parsed : parsed.results;

      return JSON.stringify({
        ok: true,
        meetingTypes: sanitizeMeetingTypes(meetingTypes),
        count: meetingTypes.length,
      });
    }),
  );
}
