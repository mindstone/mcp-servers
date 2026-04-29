import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { talentlmsFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';

export function registerBranchTools(server: McpServer): void {
  server.registerTool(
    'list_talentlms_branches',
    {
      description:
        'List all branches in TalentLMS (multi-tenant).\n\n' +
        'Returns: id, name, description, created_on.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async () => {
      const branches = await talentlmsFetch<Array<Record<string, unknown>>>('/branches');
      return JSON.stringify({ ok: true, branches, count: branches.length });
    }),
  );
}
