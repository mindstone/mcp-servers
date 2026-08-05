import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { talentlmsFetch, formEncode } from '../client.js';
import { withErrorHandling, paginationFields, paginatedPath } from '../utils.js';
import { wrapExternalTextFields } from '../envelope.js';
import { TalentLMSError } from '../types.js';

/** IANA timezone shape (e.g. "Europe/Athens", "UTC", "America/New_York"). */
const timezoneSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/, 'Invalid timezone. Use an IANA name such as "Europe/Athens".');

/** DD/MM/YYYY as documented by the TalentLMS edituser endpoint; empty string clears the date. */
const deactivationDateSchema = z
  .string()
  .regex(/^(\d{2}\/\d{2}\/\d{4})?$/, 'Invalid date. Use DD/MM/YYYY, or an empty string to clear.');

export function registerUserTools(server: McpServer): void {
  server.registerTool(
    'list_talentlms_users',
    {
      description:
        'List users in TalentLMS.\n\n' +
        'TalentLMS returns 20 users per page by default; pass page_size (max 1000) and page_number to page through larger tenants.\n\n' +
        'Returns: id, login, first_name, last_name, email, role, status, last_updated.\n\n' +
        'RELATED TOOLS:\n' +
        '- get_talentlms_user: Get full profile by ID\n' +
        '- get_talentlms_user_courses: See courses a user is enrolled in',
      inputSchema: z.object({ ...paginationFields }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const users = await talentlmsFetch<Array<Record<string, unknown>>>(paginatedPath('/users', args));
      const compact = wrapExternalTextFields(
        users.map(u => ({
          id: u.id, login: u.login, first_name: u.first_name, last_name: u.last_name,
          email: u.email, role: u.role, status: u.status, last_updated: u.last_updated,
        })),
        'talentlms:users',
      );
      return JSON.stringify({ ok: true, users: compact, count: compact.length });
    }),
  );

  server.registerTool(
    'get_talentlms_user',
    {
      description:
        'Get a user\'s full profile by ID or email.\n\n' +
        'Returns: full profile including role, status, custom fields, last login, created date.\n\n' +
        'RELATED TOOLS:\n' +
        '- list_talentlms_users: Find user IDs\n' +
        '- get_talentlms_user_courses: See their enrolled courses',
      inputSchema: z.object({
        user_id: z.string().optional().describe('User ID'),
        email: z.string().optional().describe('User email (alternative to user_id)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const userId = args.user_id;
      const email = args.email;
      if (!userId && !email) {
        return JSON.stringify({ ok: false, error: 'Provide either user_id or email.', resolution: 'Use list_talentlms_users to find user IDs.' });
      }
      const path = userId
        ? `/users/id:${encodeURIComponent(userId)}`
        : `/users/email:${encodeURIComponent(email!)}`;
      const user = await talentlmsFetch<Record<string, unknown>>(path);
      return JSON.stringify({ ok: true, user: wrapExternalTextFields(user, 'talentlms:user') });
    }),
  );

  server.registerTool(
    'create_talentlms_user',
    {
      description:
        'Create a new user in TalentLMS.\n\n' +
        'Only non-privileged user types (Learner, Trainer) can be created through this tool. ' +
        'Administrator or SuperAdmin accounts must be provisioned directly in the TalentLMS UI. ' +
        'This guard prevents prompt-injected tool input from silently escalating privileges.\n\n' +
        'COMMON MISTAKES:\n' +
        '- login must be unique across TalentLMS instance\n' +
        '- email must be unique unless allow_duplicate_emails is enabled',
      inputSchema: z.object({
        first_name: z.string().min(1).describe('First name'),
        last_name: z.string().min(1).describe('Last name'),
        email: z.string().email().describe('Email address'),
        login: z.string().min(1).describe('Login username'),
        password: z.string().min(1).optional().describe('Password (auto-generated if omitted)'),
        user_type: z
          .enum(['Learner', 'Trainer'])
          .optional()
          .describe('User type: Learner or Trainer. Default: Learner. Administrator/SuperAdmin are intentionally not creatable through this tool.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const body = formEncode({
        first_name: args.first_name,
        last_name: args.last_name,
        email: args.email,
        login: args.login,
        password: args.password,
        user_type: args.user_type,
      });
      const user = await talentlmsFetch<Record<string, unknown>>('/usersignup', {
        method: 'POST',
        body,
      });
      return JSON.stringify({ ok: true, message: 'User created.', user: wrapExternalTextFields(user, 'talentlms:user') });
    }),
  );

  server.registerTool(
    'update_talentlms_user',
    {
      description:
        'Update an existing user in TalentLMS (name, email, login, password, bio, timezone, deactivation date). ' +
        'Only the fields you provide are changed.\n\n' +
        'Only non-privileged user types (Learner, Trainer) can be set through this tool. ' +
        'Administrator or SuperAdmin roles must be assigned directly in the TalentLMS UI. ' +
        'This guard prevents prompt-injected tool input from silently escalating privileges.\n\n' +
        'RELATED TOOLS:\n' +
        '- list_talentlms_users: Find user IDs\n' +
        '- set_talentlms_user_status: Activate or deactivate instead',
      inputSchema: z.object({
        user_id: z.string().min(1).describe('User ID'),
        first_name: z.string().min(1).optional().describe('First name'),
        last_name: z.string().min(1).optional().describe('Last name'),
        email: z.string().email().optional().describe('Email address'),
        login: z.string().min(1).optional().describe('Login username'),
        password: z.string().min(1).optional().describe('New password'),
        bio: z.string().optional().describe('User biography'),
        timezone: timezoneSchema.optional().describe('Timezone (e.g. "Europe/Athens")'),
        user_type: z
          .enum(['Learner', 'Trainer'])
          .optional()
          .describe('User type: Learner or Trainer. Administrator/SuperAdmin are intentionally not settable through this tool.'),
        deactivation_date: deactivationDateSchema
          .optional()
          .describe('Date (DD/MM/YYYY) on which the user becomes automatically inactive; pass an empty string to clear. Can only be set on active users.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const { user_id, ...fields } = args;
      if (Object.values(fields).every(v => v === undefined)) {
        // Thrown (not returned ok:false) so the precondition sets MCP isError.
        throw new TalentLMSError(
          'Provide at least one field to update (e.g. first_name, email, timezone).',
          'NO_UPDATE_FIELDS',
          'Use get_talentlms_user to see the current profile first.',
        );
      }
      const body = formEncode({ user_id, ...fields });
      const user = await talentlmsFetch<Record<string, unknown>>('/edituser', {
        method: 'POST',
        body,
      });
      return JSON.stringify({ ok: true, message: 'User updated.', user: wrapExternalTextFields(user, 'talentlms:user') });
    }),
  );

  server.registerTool(
    'set_talentlms_user_status',
    {
      description:
        'Activate or deactivate a user in TalentLMS.\n\n' +
        'RELATED TOOLS:\n' +
        '- list_talentlms_users: Find user IDs',
      inputSchema: z.object({
        user_id: z.string().min(1).describe('User ID'),
        status: z.enum(['active', 'inactive']).describe('New status'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const path = `/usersetstatus/user_id:${encodeURIComponent(args.user_id)},status:${args.status}`;
      const result = await talentlmsFetch<Record<string, unknown>>(path);
      return JSON.stringify({ ok: true, message: `User status set to ${args.status}.`, result: wrapExternalTextFields(result, 'talentlms:user') });
    }),
  );

  server.registerTool(
    'get_talentlms_user_courses',
    {
      description:
        'Get all courses a user is enrolled in, with progress and completion status.\n\n' +
        'Returns: course id, name, role, completion status, progress percentage, total_time, last_accessed.\n\n' +
        'RELATED TOOLS:\n' +
        '- get_talentlms_course_users: See all users in a course (reverse lookup)',
      inputSchema: z.object({
        user_id: z.string().min(1).describe('User ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const user = await talentlmsFetch<Record<string, unknown>>(`/users/id:${encodeURIComponent(args.user_id)}`);
      const courses = wrapExternalTextFields(
        (user.courses as Array<Record<string, unknown>>) || [],
        'talentlms:user-courses',
      );
      return JSON.stringify({ ok: true, courses, count: courses.length });
    }),
  );
}
