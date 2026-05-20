import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey } from '../auth.js';
import { opusFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';

interface BrandTemplate {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Opus's documented OpenAPI spec for `GET /api/brand-templates` returns a
 * bare array. We normalise across three observed shapes:
 *   1. `[ ... ]` (current public docs)
 *   2. `{ data: [ ... ] }` (the common Opus enterprise-response wrapper)
 *   3. `{ brand_templates: [ ... ] }` (alternative shape some endpoints use)
 */
type BrandTemplatesResponse =
  | BrandTemplate[]
  | { brand_templates?: BrandTemplate[]; data?: BrandTemplate[]; [key: string]: unknown };

export function registerBrandTemplateTools(server: McpServer): void {
  server.registerTool(
    'opus_get_brand_templates',
    {
      description:
        'List the OpusClip brand templates available to your organisation. ' +
        'Brand templates control captions, fonts, colours, intro/outro cards, and other styling. ' +
        'Use a brand_template_id from this response with opus_create_project or opus_upload_video. ' +
        'NOTE: The Opus API requires the `q` parameter to equal "mine" — calling the endpoint without it returns an empty body. The schema below makes the only legal value compile-time enforced.',
      inputSchema: z.object({
        // D6 in the planning doc — make the empty-body footgun unrepresentable.
        q: z
          .literal('mine')
          .default('mine')
          .describe('Required by Opus. Must be the literal string "mine".'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const q = encodeURIComponent(args.q);
      const result = await opusFetch<BrandTemplatesResponse>(
        `/api/brand-templates?q=${q}`,
      );
      const templates: BrandTemplate[] = Array.isArray(result)
        ? result
        : (result.brand_templates ?? result.data ?? []);
      return JSON.stringify(
        {
          ok: true,
          count: templates.length,
          brand_templates: templates,
          raw: result,
        },
        null,
        2,
      );
    }),
  );
}
