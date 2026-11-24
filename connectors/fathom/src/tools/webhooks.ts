import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fathomFetch, fathomFetchNoContent } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { WebhookSchema } from '../types.js';
import { metadata } from '../pass-through.js';

function noApiKeyError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Fathom API key not configured',
    resolution: 'Use configure_fathom_api_key to set your API key first.',
  });
}

export function registerWebhookTools(server: McpServer): void {
  server.registerTool(
    'create_fathom_webhook',
    {
      description:
        `Create a Fathom webhook that POSTs new-meeting data to a URL you control.

This enables post-meeting automations (e.g. push action items or summaries into
another system) without polling. Fathom signs deliveries; the returned secret
verifies the webhook-signature header on incoming requests.

Parameters:
- destination_url: Publicly reachable HTTPS endpoint that will receive POSTs
- triggered_for: Which recordings fire the webhook (at least one):
  - my_recordings: your own recordings (and those you shared with individuals)
  - shared_external_recordings: recordings other users shared with you
  - my_shared_with_team_recordings: (Team plans) recordings you shared with teams
  - shared_team_recordings: (Team plans) recordings from teammates you can access
- include_transcript / include_summary / include_action_items / include_crm_matches:
  Payload content flags — at least one must be true

NOTE: There is no list-webhooks API. Save the returned id (needed for
delete_fathom_webhook) and secret (needed to verify signatures) — the secret
is only returned at creation time.`,
      inputSchema: z.object({
        destination_url: z
          .string()
          .url()
          .refine((u) => u.startsWith('https://'), { message: 'destination_url must use https://' })
          .describe('Publicly reachable HTTPS URL that receives webhook POSTs'),
        triggered_for: z
          .array(
            z.enum([
              'my_recordings',
              'shared_external_recordings',
              'my_shared_with_team_recordings',
              'shared_team_recordings',
            ]),
          )
          .min(1)
          .describe('Which recordings trigger the webhook (at least one)'),
        include_transcript: z.boolean().default(false).describe('Include the meeting transcript in the payload'),
        include_summary: z.boolean().default(false).describe('Include the AI summary in the payload'),
        include_action_items: z.boolean().default(false).describe('Include action items in the payload'),
        include_crm_matches: z.boolean().default(false).describe('Include CRM matches in the payload (requires a linked CRM)'),
      }),
      // Creates a live subscription that pushes meeting data to an external URL.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      if (
        !args.include_transcript &&
        !args.include_summary &&
        !args.include_action_items &&
        !args.include_crm_matches
      ) {
        return JSON.stringify({
          ok: false,
          error: 'At least one payload flag must be true',
          resolution:
            'Set include_transcript, include_summary, include_action_items, or include_crm_matches to true — Fathom rejects webhooks with an empty payload.',
        });
      }

      const webhook = await fathomFetch('/webhooks', WebhookSchema, {
        method: 'POST',
        body: JSON.stringify({
          destination_url: args.destination_url,
          triggered_for: args.triggered_for,
          include_transcript: args.include_transcript,
          include_summary: args.include_summary,
          include_action_items: args.include_action_items,
          include_crm_matches: args.include_crm_matches,
        }),
      });

      return JSON.stringify({
        ok: true,
        webhook: {
          id: metadata(webhook.id, 'id', 'fathom:webhook:id'),
          url: metadata(webhook.url, 'url', 'fathom:webhook:url'),
          created_at: metadata(webhook.created_at ?? null, 'time', 'fathom:webhook:created_at'),
          triggered_for: Array.isArray(webhook.triggered_for)
            ? webhook.triggered_for.map((value) => metadata(value, 'enum', 'fathom:webhook:triggered_for'))
            : (metadata(webhook.triggered_for, 'enum', 'fathom:webhook:triggered_for') ?? args.triggered_for),
        },
        // A well-shaped secret stays raw: it must be used verbatim.
        secret: metadata(webhook.secret, 'token', 'fathom:webhook:secret'),
        note: 'Store the secret securely — it verifies the webhook-signature header on deliveries and is only returned once. Keep the id for delete_fathom_webhook.',
      });
    }),
  );

  server.registerTool(
    'delete_fathom_webhook',
    {
      description:
        `Delete a Fathom webhook by its id, stopping meeting-data deliveries to its destination URL.

The id is returned by create_fathom_webhook (there is no list-webhooks API).
Rate limit: Counts as 1 API call (Fathom allows ~60/minute).`,
      inputSchema: z.object({
        webhook_id: z.string().min(1).describe('The webhook id returned by create_fathom_webhook'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      await fathomFetchNoContent(`/webhooks/${encodeURIComponent(args.webhook_id)}`, {
        method: 'DELETE',
      });

      return JSON.stringify({ ok: true, message: `Webhook ${args.webhook_id} deleted.` });
    }),
  );
}
