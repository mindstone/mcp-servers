import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { talentlmsFetch } from '../client.js';
import { withErrorHandling, paginationFields, paginatedPath } from '../utils.js';
import { wrapExternalTextFields } from '../envelope.js';

export function registerBranchTools(server: McpServer): void {
  server.registerTool(
    'list_talentlms_branches',
    {
      description:
        'List branches in TalentLMS (multi-tenant).\n\n' +
        'TalentLMS returns 20 branches per page by default; pass page_size (max 1000) and page_number to page through larger tenants.\n\n' +
        'Returns: id, name, description, created_on.',
      inputSchema: z.object({ ...paginationFields }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const branches = await talentlmsFetch<Array<Record<string, unknown>>>(paginatedPath('/branches', args));
      return JSON.stringify({ ok: true, branches: wrapExternalTextFields(branches, 'talentlms:branches'), count: branches.length });
    }),
  );
}
