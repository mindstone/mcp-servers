import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { humaansFetch, listResponseSchema } from '../client.js';
import { notConfiguredResult, withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { wrapUntrusted } from '../untrusted-content.js';

// Humaans has no /teams endpoint — team names exist only as an attribute on
// people — so the team list is derived by scanning the people directory.
// 10 pages x 250 people bounds the scan at 2500 people; beyond that the
// result is flagged partial rather than looping unboundedly.
const MAX_PAGES = 10;
const PAGE_SIZE = 250;

// Only each person's team names are read; other fields are ignored.
const teamScanSchema = listResponseSchema.extend({
  data: z.array(
    z.object({ teams: z.array(z.object({ name: z.unknown() })).nullish() }),
  ),
});

export function registerTeamTools(server: McpServer): void {
  server.registerTool(
    'list_humaans_teams',
    {
      description:
        `List team names in Humaans with member counts.

Humaans has no dedicated teams endpoint, so this derives the team list by
scanning the people directory. Use it to discover valid values for the
'team' filter on list_humaans_people.

Example: {}

RELATED TOOLS:
- list_humaans_people: Filter employees by team name`,
      inputSchema: z.object({
        status: z.enum(['active', 'offboarded', 'newHire', 'all']).optional()
          .describe('Which employees to count as team members. Default: active'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return notConfiguredResult();

      const counts = new Map<string, number>();
      let scanned = 0;
      let total = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams();
        params.set('$limit', String(PAGE_SIZE));
        params.set('$skip', String(scanned));
        if (args.status) params.set('status', args.status);

        const result = await humaansFetch(`/people?${params.toString()}`, teamScanSchema);

        total = result.total;
        for (const person of result.data) {
          for (const team of person.teams ?? []) {
            if (typeof team.name === 'string' && team.name.length > 0) {
              counts.set(team.name, (counts.get(team.name) ?? 0) + 1);
            }
          }
        }
        scanned += result.data.length;
        if (scanned >= total || result.data.length === 0) break;
      }
      const partial = scanned < total;

      const teams = [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, memberCount]) => ({
          name: wrapUntrusted(name, 'humaans:list_humaans_teams:name'),
          memberCount,
        }));

      return JSON.stringify({
        ok: true,
        teams,
        count: teams.length,
        peopleScanned: scanned,
        ...(partial
          ? {
              partial: true,
              note: `Only the first ${scanned} of ${total} people were scanned; team counts may be incomplete.`,
            }
          : {}),
      });
    }),
  );
}
