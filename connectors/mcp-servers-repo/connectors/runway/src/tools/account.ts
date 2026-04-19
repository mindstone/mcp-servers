import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runwayFetch } from '../client.js';
import type { OrgResponse, UsageResponse } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerAccountTools(server: McpServer): void {
  // ── Balance ───────────────────────────────────────────────────────────
  server.registerTool(
    'get_runway_balance',
    {
      description: 'Check your Runway credit balance, usage tier limits, and today\'s usage by model. 1 credit = $0.01.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async () => {
      const org = await runwayFetch<OrgResponse>('/organization');
      const bal = org.creditBalance;
      const activeModels = Object.entries(org.usage.models).filter(([, v]) => v.dailyGenerations > 0);

      const summary = [
        `Credit Balance: ${bal} credits ($${(bal * 0.01).toFixed(2)})`,
        `Monthly Limit: ${org.tier.maxMonthlyCreditSpend} credits`,
        '',
        'Model Limits:',
        ...Object.entries(org.tier.models).map(([m, l]) =>
          `  ${m}: ${l.maxConcurrentGenerations} concurrent, ${l.maxDailyGenerations}/day`),
        ...(activeModels.length
          ? ['', "Today's Usage:", ...activeModels.map(([m, v]) => `  ${m}: ${v.dailyGenerations} generations`)]
          : []),
        ...(bal === 0 ? ['', 'WARNING: No credits. Add at https://dev.runwayml.com/ (Billing tab, min $10).'] : []),
      ];

      return JSON.stringify({
        ok: true, balance: bal, balance_usd: `$${(bal * 0.01).toFixed(2)}`,
        summary: summary.join('\n'),
      });
    }),
  );

  // ── Credit Usage Analytics ────────────────────────────────────────────
  server.registerTool(
    'query_credit_usage',
    {
      description: 'Query detailed credit usage broken down by model and day. Supports date ranges up to 90 days.',
      inputSchema: z.object({
        start_date: z.string().optional().describe('Start date (YYYY-MM-DD). Default: 30 days ago.'),
        before_date: z.string().optional().describe('End date, not inclusive (YYYY-MM-DD). Default: 30 days after start.'),
      }),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async (args) => {
      const body: Record<string, unknown> = {};
      if (args.start_date) body.startDate = args.start_date;
      if (args.before_date) body.beforeDate = args.before_date;

      const result = await runwayFetch<UsageResponse>('/organization/usage', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      let totalCredits = 0;
      const byModel: Record<string, number> = {};
      for (const day of result.results) {
        for (const entry of day.usedCredits) {
          totalCredits += entry.amount;
          byModel[entry.model] = (byModel[entry.model] || 0) + entry.amount;
        }
      }

      const lines = [
        `Total credits used: ${totalCredits} ($${(totalCredits * 0.01).toFixed(2)})`,
        `Period: ${result.results.length} days`,
        '',
        'By model:',
        ...Object.entries(byModel).sort(([, a], [, b]) => b - a)
          .map(([m, c]) => `  ${m}: ${c} credits ($${(c * 0.01).toFixed(2)})`),
      ];

      return JSON.stringify({
        ok: true, total_credits: totalCredits,
        days: result.results.length, by_model: byModel,
        summary: lines.join('\n'),
      });
    }),
  );
}
