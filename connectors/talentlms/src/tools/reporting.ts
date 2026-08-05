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

  server.registerTool(
    'get_talentlms_leaderboard',
    {
      description:
        'Get the gamification leaderboard: users ranked by TalentLMS points (highest first).\n\n' +
        'The TalentLMS v1 API has no dedicated leaderboard endpoint, so this tool derives the ranking ' +
        'from the documented points and level fields of the user list. It reads up to 1000 users.\n\n' +
        'Returns: id, login, first_name, last_name, points, level — sorted by points descending.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of entries to return (default: 20, max: 100).'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const limit = args.limit ?? 20;
      const users = await talentlmsFetch<Array<Record<string, unknown>>>('/users/page_size:1000');
      const ranked = users
        .map(u => ({
          id: u.id, login: u.login, first_name: u.first_name, last_name: u.last_name,
          points: u.points, level: u.level,
        }))
        .sort((a, b) => Number(b.points ?? 0) - Number(a.points ?? 0))
        .slice(0, limit);
      return JSON.stringify({
        ok: true,
        leaderboard: wrapExternalTextFields(ranked, 'talentlms:leaderboard'),
        count: ranked.length,
      });
    }),
  );

  server.registerTool(
    'get_talentlms_user_certifications',
    {
      description:
        'Get the certifications issued to a user, with issue and expiration dates.\n\n' +
        'Useful for compliance questions like "whose certification expires soon?" — check expiration_date ' +
        '("Never" means the certification does not expire).\n\n' +
        'RELATED TOOLS:\n' +
        '- list_talentlms_users: Find user IDs',
      inputSchema: z.object({
        user_id: z.string().min(1).describe('User ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const user = await talentlmsFetch<Record<string, unknown>>(`/users/id:${encodeURIComponent(args.user_id)}`);
      const certifications = wrapExternalTextFields(
        (user.certifications as Array<Record<string, unknown>>) || [],
        'talentlms:user-certifications',
      );
      return JSON.stringify({ ok: true, certifications, count: certifications.length });
    }),
  );
}
