import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mixmaxFetch } from '../client.js';
import { withErrorHandling, parseApiResponse } from '../utils.js';
import { isConfigured } from '../auth.js';
import { reportResponseSchema } from '../types.js';
import { sanitizeReportBuckets } from '../sanitize.js';

function noApiTokenError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Mixmax API token not configured',
    resolution: 'To use Mixmax, you need to configure an API token first.',
    next_step: {
      action: 'The user adds the Mixmax API token in Settings → Connectors in the app. Do not ask for it in chat.',
      get_token_from: 'Mixmax Settings > Integrations > API Key section (requires Growth or Enterprise annual plan)',
    },
  });
}

export function registerReportTools(server: McpServer): void {
  server.registerTool(
    'get_mixmax_report',
    {
      description:
        `Query Mixmax analytics: sequence performance, message engagement, or meeting stats.

TYPES:
- "sequences": per-sequence performance — sent, delivered, opened, clicked, replied, bounced, percentages, recipientsAdded. Use for "how is the nurture campaign doing?"
- "messages": message engagement buckets (subject, recipients, opens/clicks/replies)
- "meetings": meeting aggregates

QUERY SYNTAX: Mixmax search-query string, e.g. "sent:last30days from:everyone". Omit to use the default range.

EXAMPLES:
- Sequence performance over the last 30 days: { "type": "sequences", "query": "sent:last30days" }
- Message engagement grouped by template: { "type": "messages", "groupBy": "template" }

Returns buckets (one per group), aggregate totals, and pagination info in extra (hasNext, total) — page with offset/limit.`,
      inputSchema: z.object({
        type: z.enum(['messages', 'meetings', 'sequences']).describe('What to report on'),
        query: z.string().optional().describe('Mixmax query string, e.g. "sent:last30days from:everyone" (optional)'),
        groupBy: z.string().optional().describe('How to group results — messages: delegator, customerDomain, message, recipient, emailsByDomain, sender, senderGroup, time, template; meetings: groupmember, teammate, group (optional)'),
        fields: z.string().optional().describe('Comma-delimited list of fields to fetch, e.g. "delivered,opened" (optional)'),
        limit: z.number().min(1).max(10000).default(50).describe('Maximum buckets to return (default: 50)'),
        offset: z.number().min(0).default(0).describe('Offset for paging (default: 0)'),
        sortBy: z.string().optional().describe('Field to sort by (optional)'),
        sortDesc: z.boolean().default(true).describe('Sort descending (default: true)'),
        timezone: z.string().optional().describe('IANA timezone for date-range queries, e.g. "America/New_York" (default: UTC)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiTokenError();

      const payload: Record<string, unknown> = {
        type: args.type,
        limit: args.limit,
        offset: args.offset,
        sortDesc: args.sortDesc,
      };
      if (args.query) payload.query = args.query;
      if (args.groupBy) payload.groupBy = args.groupBy;
      if (args.fields) payload.fields = args.fields;
      if (args.sortBy) payload.sortBy = args.sortBy;
      if (args.timezone) payload.timezone = args.timezone;

      const data = parseApiResponse(
        reportResponseSchema,
        await mixmaxFetch<unknown>('/reports/data/table', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
        'report',
      );

      return JSON.stringify({
        ok: true,
        type: args.type,
        buckets: sanitizeReportBuckets(data.buckets),
        count: data.buckets.length,
        ...(data.totals ? { totals: data.totals } : {}),
        ...(data.extra ? { extra: data.extra } : {}),
      });
    }),
  );
}
