import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fathomFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { wrapUntrusted } from '../untrusted-content.js';
import type { TeamsResponse, TeamMembersResponse } from '../types.js';

function noApiKeyError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Fathom API key not configured',
    resolution: 'Use configure_fathom_api_key to set your API key first.',
  });
}

export function registerTeamTools(server: McpServer): void {
  server.registerTool(
    'list_fathom_teams',
    {
      description:
        `List all teams accessible to the user in Fathom.

Returns teams with:
- name: Team name (use for filtering meetings or listing members)
- created_at: When the team was created (if available)

Use this to find team names for filtering meetings with list_fathom_meetings or listing team members with list_fathom_team_members.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async () => {
      if (!isConfigured()) return noApiKeyError();

      const allTeams: Array<{ name: string; created_at?: string | null }> = [];
      let cursor: string | undefined;

      do {
        const path = cursor ? `/teams?cursor=${encodeURIComponent(cursor)}` : '/teams';
        const response = await fathomFetch<TeamsResponse>(path);

        const items = response.items || [];
        for (const item of items) {
          // Team names are org-authored text — envelope before returning.
          if (typeof item === 'string') {
            allTeams.push({ name: wrapUntrusted(item, 'fathom:team:name') ?? item });
          } else {
            allTeams.push({
              ...item,
              name: wrapUntrusted(item.name, 'fathom:team:name') ?? item.name,
            });
          }
        }

        cursor = response.next_cursor || undefined;
      } while (cursor);

      return JSON.stringify({ ok: true, teams: allTeams, count: allTeams.length });
    }),
  );

  server.registerTool(
    'list_fathom_team_members',
    {
      description:
        `List members of a specific team in Fathom.

Returns team members with:
- User ID and email
- Name and role
- Join date

Use list_fathom_teams first to get available team names.`,
      inputSchema: z.object({
        team: z.string().min(1).describe('Team name to list members for (from list_fathom_teams)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const members: Array<Record<string, unknown>> = [];
      let cursor: string | undefined;

      do {
        const teamParam = encodeURIComponent(args.team);
        const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const path = `/team_members?team=${teamParam}${cursorParam}`;
        const response = await fathomFetch<TeamMembersResponse>(path);

        for (const item of response.items || []) {
          members.push({
            ...item,
            name: wrapUntrusted(item.name, 'fathom:team:member_name'),
          });
        }
        cursor = response.next_cursor || undefined;
      } while (cursor);

      return JSON.stringify({ ok: true, teamMembers: members, count: members.length });
    }),
  );
}
