import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { talentlmsFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { wrapExternalTextFields } from '../envelope.js';

export function registerReportingTools(server: McpServer): void {
  server.registerTool(
    'get_talentlms_site_info',
    {
      description:
        'Get TalentLMS site-level statistics and configuration.\n\n' +
        'Returns: total users, total courses, signup method, site name, timezone, domain, and more.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async () => {
      const info = await talentlmsFetch<Record<string, unknown>>('/siteinfo');
      return JSON.stringify({ ok: true, siteInfo: wrapExternalTextFields(info, 'talentlms:siteinfo') });
    }),
  );

  server.registerTool(
    'get_talentlms_timeline',
    {
      description:
        'Get activity timeline for users or courses.\n\n' +
        'Returns recent activity events: enrolments, completions, logins, course accesses.',
      inputSchema: z.object({
        type: z.enum(['users', 'courses']).describe('Timeline type'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const timeline = await talentlmsFetch<Array<Record<string, unknown>>>(`/gettimeline/type:${args.type}`);
      return JSON.stringify({ ok: true, timeline: wrapExternalTextFields(timeline, 'talentlms:timeline'), count: timeline.length });
    }),
  );

  server.registerTool(
    'get_talentlms_user_progress',
    {
      description:
        'Get detailed progress for a user in a specific course.\n\n' +
        'Returns: unit-by-unit progress, completion status, score, time spent per unit.\n\n' +
        'WORKFLOW:\n' +
        '1. Find user ID with list_talentlms_users\n' +
        '2. Find course ID with list_talentlms_courses or get_talentlms_user_courses\n' +
        '3. Call this tool for detailed breakdown',
      inputSchema: z.object({
        user_id: z.string().min(1).describe('User ID'),
        course_id: z.string().min(1).describe('Course ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const result = await talentlmsFetch<Record<string, unknown>>(
        `/getuserstatusincourse/course_id:${encodeURIComponent(args.course_id)},user_id:${encodeURIComponent(args.user_id)}`,
      );
      return JSON.stringify({ ok: true, progress: wrapExternalTextFields(result, 'talentlms:user-progress') });
    }),
  );

}
