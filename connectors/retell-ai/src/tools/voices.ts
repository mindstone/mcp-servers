import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retellFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { sanitizeVoice, sanitizePhoneNumber, sanitizeList } from '../sanitize.js';

const phoneAgentBindingSchema = z.object({
  agent_id: z.string().describe('Agent ID to bind.'),
  agent_version: z.union([z.number().int().min(0), z.string()]).optional()
    .describe('Optional agent version: number (0, 1, 2...) or tag (e.g. "latest"). Include it to avoid version-binding mistakes.'),
  weight: z.number().min(0).max(1).describe('Traffic weight for this binding (0-1). Weights in the list must sum to 1.'),
});

export function registerVoiceTools(server: McpServer): void {
  server.registerTool(
    'list_voices',
    {
      description: `Browse all available TTS voices in Retell.

WHEN TO USE:
- Find voice IDs when creating or updating an agent
- Compare providers/voice names before selecting a voice
- Verify a voice_id still exists after a 404 from create_agent/update_agent

COMMON MISTAKES:
- Passing the display name instead of the exact voice_id
- Reusing an old voice_id without checking it still exists

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key

RELATED TOOLS:
- create_agent: Use a returned voice_id for a new agent
- update_agent: Change an existing agent's voice_id

RETURNS: voices, count. Each voice includes voice_id, voice_name/name, provider, accent/language/gender, and preview metadata when available.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      requireApiKey();
      const result = await retellFetch<unknown[]>(
        '/list-voices',
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        voices: sanitizeList(result, sanitizeVoice, 'retell:list_voices'),
        count: Array.isArray(result) ? result.length : 0,
        message: `Found ${Array.isArray(result) ? result.length : 0} voice(s). Use voice_id when creating or updating agents.`,
      });
    }),
  );

  server.registerTool(
    'list_phone_numbers',
    {
      description: `List all phone numbers in your Retell account with their agent bindings.

WHEN TO USE:
- Before create_phone_call, to find available from_numbers
- To check which agents are bound to which numbers
- To verify outbound agent configuration

TIP: The phone_number field (E.164 format) is what you pass as from_number in create_phone_call.
The outbound_agents array shows which agent(s) are bound for outbound calls from this number.
Check each outbound agent's agent_version before calling; version mismatches are a common 404 cause.

COMMON MISTAKES:
- Using a number that exists but has no outbound_agents binding
- Ignoring agent_version on the binding and then overriding only agent_id during create_phone_call

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 422: invalid pagination params → keep limit between 1 and 1000

RELATED TOOLS:
- get_phone_number: Inspect one number's bindings
- update_phone_number: Bind or rebind agents
- create_phone_call: Use returned phone_number as from_number
- get_agent_versions: Verify bound versions

RETURNS: phone_numbers, count, pagination_key, has_more. Each number includes phone_number, inbound_agents, outbound_agents, nickname/config when available.`,
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Max results to return (default: 50, max: 1000).'),
        pagination_key: z.string().optional().describe('Pagination key from the previous response for the next page.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.pagination_key) params.set('pagination_key', args.pagination_key);
      const qs = params.toString();
      const result = await retellFetch<unknown>(
        `/v2/list-phone-numbers${qs ? `?${qs}` : ''}`,
        { method: 'GET' },
      );

      const resultObj = (result && typeof result === 'object' && !Array.isArray(result))
        ? result as Record<string, unknown>
        : null;
      const items = resultObj && Array.isArray(resultObj.items)
        ? (resultObj.items as unknown[])
        : (Array.isArray(result) ? result as unknown[] : []);

      return JSON.stringify({
        ok: true,
        phone_numbers: sanitizeList(items, sanitizePhoneNumber, 'retell:list_phone_numbers'),
        count: items.length,
        pagination_key: resultObj?.pagination_key,
        has_more: resultObj?.has_more,
        message: `Found ${items.length} phone number(s). Use phone_number (E.164 format) as from_number in create_phone_call.`,
      });
    }),
  );

  server.registerTool(
    'get_phone_number',
    {
      description: `Get details of a specific phone number including its agent bindings.

WHEN TO USE:
- To check which agents are bound (inbound and outbound) to a specific number
- To diagnose why create_phone_call returns 404 (missing outbound agent binding)
- To confirm the bound agent_version before overriding call routing

COMMON MISTAKES:
- Checking only that the number exists; outbound calls require outbound_agents
- Missing that the bound agent_version differs from the version you intend to use

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: phone number not found → list_phone_numbers and use the exact E.164 value

RELATED TOOLS:
- list_phone_numbers: Discover available numbers
- update_phone_number: Add/fix inbound or outbound bindings
- get_agent_versions: Verify bound agent versions
- create_phone_call: Use this phone_number as from_number

RETURNS: phone_number, nickname, inbound_agents, outbound_agents, phone number config fields.`,
      inputSchema: {
        phone_number: z.string().describe('Phone number in E.164 format exactly as returned by list_phone_numbers (e.g. +14155551234).'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await retellFetch<Record<string, unknown>>(
        `/get-phone-number/${encodeURIComponent(args.phone_number)}`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizePhoneNumber(result, 'retell:get_phone_number') as Record<string, unknown>),
      });
    }),
  );

  server.registerTool(
    'update_phone_number',
    {
      description: `Update agent bindings and settings for a phone number.

WHEN TO USE:
- To bind an agent to a phone number for outbound/inbound calls
- To fix "404 Not Found" errors on create_phone_call (the number needs an outbound agent)
- To change which agent handles calls on a number

CRITICAL: After Retell's March 2026 update, phone numbers use weighted agent lists.
Each binding needs agent_id, weight (must sum to 1), and optionally agent_version.

EXAMPLE — bind agent to outbound calls:
{ "phone_number": "+14155551234", "outbound_agents": [{ "agent_id": "agent_xxx", "agent_version": 1, "weight": 1 }] }

COMMON MISTAKES:
- Omitting agent_version and accidentally binding the wrong/latest version
- Setting weights that do not sum to 1
- Updating inbound_agents when the failure is outbound calling

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: phone_number or agent_id not found → list_phone_numbers/list_agents
- 422: invalid binding → include agent_id + weight, ensure weights sum to 1, verify agent_version

RELATED TOOLS:
- get_phone_number/list_phone_numbers: Inspect current bindings first
- get_agent_versions: Choose a valid agent_version
- publish_agent: Make the desired version live before binding
- create_phone_call: Test outbound routing after updating

RETURNS: phone_number, nickname, inbound_agents, outbound_agents, updated config fields.`,
      inputSchema: {
        phone_number: z.string().describe('Phone number in E.164 format exactly as returned by list_phone_numbers.'),
        nickname: z.string().optional().describe('Human-readable label for this number.'),
        inbound_agents: z.array(phoneAgentBindingSchema).optional()
          .describe('Agents for inbound calls. Each item needs agent_id and weight; include agent_version when targeting a specific version. Weights must sum to 1.'),
        outbound_agents: z.array(phoneAgentBindingSchema).optional()
          .describe('Agents for outbound calls. Each item needs agent_id and weight; include agent_version to avoid version-binding mistakes. Weights must sum to 1.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const phoneNumber = args.phone_number;
      const body: Record<string, unknown> = {};
      if (args.nickname !== undefined) body.nickname = args.nickname;
      if (args.inbound_agents !== undefined) body.inbound_agents = args.inbound_agents;
      if (args.outbound_agents !== undefined) body.outbound_agents = args.outbound_agents;

      const result = await retellFetch<Record<string, unknown>>(
        `/update-phone-number/${encodeURIComponent(phoneNumber)}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );

      return JSON.stringify({
        ok: true,
        ...(sanitizePhoneNumber(result, 'retell:update_phone_number') as Record<string, unknown>),
        message: `Phone number ${phoneNumber} updated successfully.`,
      });
    }),
  );
}
