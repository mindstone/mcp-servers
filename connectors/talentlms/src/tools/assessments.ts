import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { talentlmsFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';

export function registerAssessmentTools(server: McpServer): void {
  server.registerTool(
    'get_talentlms_test_answers',
    {
      description:
        'Get a user\'s answers for a specific test/quiz.\n\n' +
        'Returns: questions, user answers, correct answers, score.\n\n' +
        'WORKFLOW:\n' +
        '1. Get course details with get_talentlms_course to find test/unit IDs\n' +
        '2. Call this tool with the test ID and user ID',
      inputSchema: z.object({
        test_id: z.string().min(1).describe('Test/quiz ID (from course units)'),
        user_id: z.string().min(1).describe('User ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const result = await talentlmsFetch<Record<string, unknown>>(
        `/gettestanswers/test_id:${encodeURIComponent(args.test_id)},user_id:${encodeURIComponent(args.user_id)}`,
      );
      return JSON.stringify({ ok: true, testAnswers: result });
    }),
  );

  server.registerTool(
    'get_talentlms_survey_answers',
    {
      description:
        'Get a user\'s responses to a survey.\n\n' +
        'Returns: questions, user responses.',
      inputSchema: z.object({
        survey_id: z.string().min(1).describe('Survey ID (from course units)'),
        user_id: z.string().min(1).describe('User ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const result = await talentlmsFetch<Record<string, unknown>>(
        `/getsurveyanswers/survey_id:${encodeURIComponent(args.survey_id)},user_id:${encodeURIComponent(args.user_id)}`,
      );
      return JSON.stringify({ ok: true, surveyAnswers: result });
    }),
  );

  server.registerTool(
    'get_talentlms_ilt_sessions',
    {
      description:
        'Get instructor-led training (ILT) sessions for a specific ILT unit.\n\n' +
        'Returns: session ID, course, instructor, date, time, location, enrolled users.\n\n' +
        'WORKFLOW:\n' +
        '1. Get course details with get_talentlms_course to find ILT unit IDs\n' +
        '2. Call this tool with the ILT unit ID',
      inputSchema: z.object({
        ilt_id: z.string().min(1).describe('ILT unit ID (from course units)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const sessions = await talentlmsFetch<Array<Record<string, unknown>>>(
        `/getiltsessions/ilt_id:${encodeURIComponent(args.ilt_id)}`,
      );
      return JSON.stringify({ ok: true, sessions, count: sessions.length });
    }),
  );
}
