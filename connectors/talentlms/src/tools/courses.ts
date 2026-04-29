import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { talentlmsFetch, formEncode } from '../client.js';
import { withErrorHandling } from '../utils.js';

export function registerCourseTools(server: McpServer): void {
  server.registerTool(
    'list_talentlms_courses',
    {
      description:
        'List all courses in TalentLMS.\n\n' +
        'Returns: id, name, code, category_id, description, status, creation_date, price, creator_id.\n\n' +
        'RELATED TOOLS:\n' +
        '- get_talentlms_course: Get full course details\n' +
        '- get_talentlms_course_users: See enrolled users',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async () => {
      const courses = await talentlmsFetch<Array<Record<string, unknown>>>('/courses');
      const compact = courses.map(c => ({
        id: c.id, name: c.name, code: c.code, category_id: c.category_id,
        description: c.description, status: c.status, creation_date: c.creation_date,
        price: c.price, creator_id: c.creator_id,
      }));
      return JSON.stringify({ ok: true, courses: compact, count: compact.length });
    }),
  );

  server.registerTool(
    'get_talentlms_course',
    {
      description:
        'Get full course details by ID.\n\n' +
        'Returns: name, description, units (content structure), rules, prerequisites, certification, custom fields.\n\n' +
        'RELATED TOOLS:\n' +
        '- list_talentlms_courses: Find course IDs\n' +
        '- get_talentlms_course_users: See who is enrolled',
      inputSchema: z.object({
        course_id: z.string().min(1).describe('Course ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const course = await talentlmsFetch<Record<string, unknown>>(`/courses/id:${encodeURIComponent(args.course_id)}`);
      return JSON.stringify({ ok: true, course });
    }),
  );

  server.registerTool(
    'create_talentlms_course',
    {
      description:
        'Create a new course in TalentLMS.\n\n' +
        'RELATED TOOLS:\n' +
        '- enrol_talentlms_user: Add users to the new course',
      inputSchema: z.object({
        name: z.string().min(1).describe('Course name'),
        description: z.string().optional().describe('Course description'),
        code: z.string().optional().describe('Course code (optional)'),
        category_id: z.string().optional().describe('Category ID (optional)'),
        creator_id: z.string().optional().describe('Creator user ID (optional)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const body = formEncode({
        name: args.name,
        description: args.description,
        code: args.code,
        category_id: args.category_id,
        creator_id: args.creator_id,
      });
      const course = await talentlmsFetch<Record<string, unknown>>('/createcourse', {
        method: 'POST',
        body,
      });
      return JSON.stringify({ ok: true, message: 'Course created.', course });
    }),
  );

  server.registerTool(
    'get_talentlms_course_users',
    {
      description:
        'Get all users enrolled in a course, with their progress and completion status.\n\n' +
        'Returns: user id, name, role, completion_status, completion_percentage, total_time.\n\n' +
        'RELATED TOOLS:\n' +
        '- get_talentlms_user_courses: See all courses for a user (reverse lookup)\n' +
        '- enrol_talentlms_user: Add a user to this course',
      inputSchema: z.object({
        course_id: z.string().min(1).describe('Course ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const course = await talentlmsFetch<Record<string, unknown>>(`/courses/id:${encodeURIComponent(args.course_id)}`);
      const users = (course.users as Array<Record<string, unknown>>) || [];
      return JSON.stringify({ ok: true, users, count: users.length });
    }),
  );

  server.registerTool(
    'enrol_talentlms_user',
    {
      description:
        'Enrol a user into a course.\n\n' +
        'COMMON MISTAKES:\n' +
        '- User must exist first (use create_talentlms_user if needed)\n' +
        '- Cannot enrol the same user twice',
      inputSchema: z.object({
        user_id: z.string().min(1).describe('User ID'),
        course_id: z.string().min(1).describe('Course ID'),
        role: z.enum(['learner', 'instructor']).optional().describe('Enrolment role. Default: learner'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const body = formEncode({
        user_id: args.user_id,
        course_id: args.course_id,
        role: args.role,
      });
      await talentlmsFetch<Record<string, unknown>>('/addusertocourse', {
        method: 'POST',
        body,
      });
      return JSON.stringify({ ok: true, message: 'User enrolled in course.' });
    }),
  );

  server.registerTool(
    'unenrol_talentlms_user',
    {
      description:
        'Remove a user from a course.\n\n' +
        'RELATED TOOLS:\n' +
        '- get_talentlms_course_users: Check current enrolment',
      inputSchema: z.object({
        user_id: z.string().min(1).describe('User ID'),
        course_id: z.string().min(1).describe('Course ID'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      await talentlmsFetch<Record<string, unknown>>(
        `/removeuserfromcourse/course_id:${encodeURIComponent(args.course_id)},user_id:${encodeURIComponent(args.user_id)}`,
      );
      return JSON.stringify({ ok: true, message: 'User removed from course.' });
    }),
  );

  server.registerTool(
    'get_talentlms_course_sso_link',
    {
      description:
        'Generate an SSO link to launch a user directly into a course.\n\n' +
        'Returns a URL that logs the user in and redirects them to the course. Link is temporary.',
      inputSchema: z.object({
        user_id: z.string().min(1).describe('User ID'),
        course_id: z.string().min(1).describe('Course ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const result = await talentlmsFetch<Record<string, unknown>>(
        `/gotocourse/user_id:${encodeURIComponent(args.user_id)},course_id:${encodeURIComponent(args.course_id)}`,
      );
      return JSON.stringify({ ok: true, result });
    }),
  );
}
