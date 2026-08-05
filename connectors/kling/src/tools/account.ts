import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { klingFetch } from '../client.js';
import { KLING_API_BASE, type AccountCostsResponse } from '../types.js';
import { epochMsField, withErrorHandling } from '../utils.js';

export function registerAccountTools(server: McpServer): void {
  // ─── get_kling_balance ──────────────────────────────────────────
  server.registerTool(
    'get_kling_balance',
    {
      description:
        'Check the resource packages (credit packs) on your Kling API account and their remaining quantities. ' +
        'Use before kicking off expensive generations to confirm capacity. ' +
        'Note: Kling reports remaining quantities with a delay of up to 12 hours.',
      inputSchema: z.object({
        start_time: epochMsField().describe(
          'Query window start — Unix timestamp in milliseconds (number, e.g. 1735689600000) or a parseable date string (e.g. "2026-01-01").',
        ),
        end_time: epochMsField().describe(
          'Query window end — Unix timestamp in milliseconds (number, e.g. 1767225599000) or a parseable date string (e.g. "2026-02-01").',
        ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      // The account costs endpoint is documented at the domain root
      // (/account/costs), not under /v1 — hence the absolute URL.
      const origin = new URL(KLING_API_BASE).origin;
      const data = await klingFetch<AccountCostsResponse>(
        `${origin}/account/costs?start_time=${args.start_time}&end_time=${args.end_time}`,
      );

      const packs = (data.resource_pack_subscribe_infos ?? []).map((pack) => {
        const entry: Record<string, unknown> = {
          name: pack.resource_pack_name,
          type: pack.resource_pack_type,
          total_quantity: pack.total_quantity,
          remaining_quantity: pack.remaining_quantity,
          status: pack.status,
        };
        if (pack.invalid_time) entry.expires_at = pack.invalid_time;
        return entry;
      });

      return JSON.stringify({
        ok: true,
        resource_packs: packs,
        note: 'Remaining quantities are reported by Kling with a delay of up to 12 hours.',
      });
    }),
  );
}
