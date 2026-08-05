import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { talentlmsFetch } from '../client.js';
import { withErrorHandling, paginationFields, paginatedPath } from '../utils.js';
import { wrapExternalTextFields } from '../envelope.js';

export function registerCategoryTools(server: McpServer): void {
  server.registerTool(
    'list_talentlms_categories',
    {
      description:
        'List course categories in TalentLMS.\n\n' +
        'TalentLMS returns 20 categories per page by default; pass page_size (max 1000) and page_number to page through larger catalogues.\n\n' +
        'Returns: id, name, price, parent_category_id.\n\n' +
        'RELATED TOOLS:\n' +
        '- list_talentlms_courses: Browse courses (each course carries a category_id)',
      inputSchema: z.object({ ...paginationFields }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const categories = await talentlmsFetch<Array<Record<string, unknown>>>(paginatedPath('/categories', args));
      return JSON.stringify({
        ok: true,
        categories: wrapExternalTextFields(categories, 'talentlms:categories'),
        count: categories.length,
      });
    }),
  );
}
