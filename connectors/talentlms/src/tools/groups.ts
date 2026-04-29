import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { talentlmsFetch, formEncode } from '../client.js';
import { withErrorHandling } from '../utils.js';

export function registerGroupTools(server: McpServer): void {
  server.registerTool(
    'list_talentlms_groups',
    {
      description:
        'List all groups in TalentLMS.\n\n' +
        'Returns: id, name, description, creator_id, created_on, key (enrollment key).\n\n' +
        'RELATED TOOLS:\n' +
        '- get_talentlms_group: Get group details including members and courses',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async () => {
      const groups = await talentlmsFetch<Array<Record<string, unknown>>>('/groups');
      return JSON.stringify({ ok: true, groups, count: groups.length });
    }),
  );

  server.registerTool(
    'get_talentlms_group',
    {
      description:
        'Get group details including members and assigned courses.\n\n' +
        'Returns: group info, list of users in the group, list of courses assigned to the group.',
      inputSchema: z.object({
        group_id: z.string().min(1).describe('Group ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const group = await talentlmsFetch<Record<string, unknown>>(`/groups/id:${encodeURIComponent(args.group_id)}`);
      return JSON.stringify({ ok: true, group });
    }),
  );

  server.registerTool(
    'create_talentlms_group',
    {
      description: 'Create a new group in TalentLMS.',
      inputSchema: z.object({
        name: z.string().min(1).describe('Group name'),
        description: z.string().optional().describe('Group description'),
        key: z.string().optional().describe('Enrollment key (optional)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const body = formEncode({
        name: args.name,
        description: args.description,
        key: args.key,
      });
      const group = await talentlmsFetch<Record<string, unknown>>('/creategroup', {
        method: 'POST',
        body,
      });
      return JSON.stringify({ ok: true, message: 'Group created.', group });
    }),
  );

  server.registerTool(
    'add_course_to_talentlms_group',
    {
      description: 'Assign a course to a group. All group members will be enrolled.',
      inputSchema: z.object({
        group_id: z.string().min(1).describe('Group ID'),
        course_id: z.string().min(1).describe('Course ID'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      await talentlmsFetch<Record<string, unknown>>(
        `/addcoursetogroup/group_id:${encodeURIComponent(args.group_id)},course_id:${encodeURIComponent(args.course_id)}`,
      );
      return JSON.stringify({ ok: true, message: 'Course added to group.' });
    }),
  );
}
