import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { wiseFetch } from '../client.js';
import type { WiseRate } from '../types.js';
import { withErrorHandling, requireCredentials, isCredentials, validateCurrency } from '../utils.js';

export function registerRateTools(server: McpServer): void {
  // ── get_wise_exchange_rate ──────────────────────────────────────

  server.registerTool(
    'get_wise_exchange_rate',
    {
      description:
        'Get the current (or historic) Wise mid-market exchange rate between two currencies. ' +
        'For fee-inclusive pricing of an actual transfer, use create_wise_quote instead.',
      inputSchema: z.object({
        source: z.string().describe('Source currency, 3-letter ISO 4217 code (e.g. "GBP")'),
        target: z.string().describe('Target currency, 3-letter ISO 4217 code (e.g. "EUR")'),
        time: z.string().optional()
          .describe('Historic point in time. ISO 8601 date-time (e.g. "2026-01-15T12:00:00Z") or plain date (e.g. "2026-01-15"). Omit for the live rate.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const credentials = requireCredentials();
      if (!isCredentials(credentials)) return credentials;

      const source = validateCurrency(args.source, 'source');
      const target = validateCurrency(args.target, 'target');

      let time: string | undefined;
      if (args.time !== undefined) {
        if (Number.isNaN(Date.parse(args.time))) {
          return JSON.stringify({
            ok: false,
            error: 'time must be a parseable date or date-time string.',
            resolution: 'Pass an ISO 8601 value such as "2026-01-15T12:00:00Z" or "2026-01-15".',
          });
        }
        time = new Date(args.time).toISOString();
      }

      const rates = await wiseFetch<WiseRate[]>(credentials.apiToken, '/v1/rates', {
        params: { source, target, time },
      });

      return JSON.stringify({ ok: true, rates, count: rates.length });
    }),
  );
}
