import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey, elevenLabsFetch, elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import {
  sanitizeAgent,
  sanitizeAgentSummary,
  sanitizeList,
  sanitizeSimulation,
} from '../sanitize.js';
import { ElevenLabsError } from '../types.js';
import { unwrapUntrusted, unwrapUntrustedJsonStrings } from '../untrusted-content.js';
import { validateNestedPublicHttpsUrls } from '../url-safety.js';
import { withErrorHandling } from '../utils.js';

type Obj = Record<string, unknown>;

const FIRST_CLASS_AUTHORING_FIELDS = [
  'name',
  'system_prompt',
  'first_message',
  'voice_id',
  'language',
  'llm_model',
  'temperature',
  'knowledge_base_document_ids',
] as const;

const advancedConfigSchema = z.record(z.unknown());
const firstClassAuthoringSchema = {
  name: z.string().min(1).optional()
    .describe('Optional human-readable agent name for workspace search and reviews.'),
  system_prompt: z.string().min(1).optional()
    .describe('Core system prompt / instructions for the agent.'),
  first_message: z.string().min(1).optional()
    .describe('Opening message the agent should speak first.'),
  voice_id: z.string().min(1).optional()
    .describe('Voice ID for the agent output audio.'),
  language: z.string().min(1).optional()
    .describe('Primary language for the agent (for example "en").'),
  llm_model: z.string().min(1).optional()
    .describe('Optional ElevenLabs LLM model identifier for the prompt config.'),
  temperature: z.number().finite().optional()
    .describe('Optional LLM temperature for the prompt config.'),
  knowledge_base_document_ids: z.array(z.string().min(1)).min(1).optional()
    .describe('Optional knowledge-base document IDs to attach in the prompt config.'),
  advanced_config: advancedConfigSchema.optional()
    .describe('Optional raw agent config fragments. Deep-merged LAST for full-platform reach. Every "url"-keyed string in the merged body must be a public https:// address (loopback, private, link-local, and cloud-metadata destinations are rejected).'),
} satisfies Record<string, z.ZodTypeAny>;

const createAgentSchema = z.object({
  name: z.string().min(1).describe('Agent name shown in the ElevenLabs workspace.'),
  system_prompt: z.string().min(1).describe('Core system prompt / instructions for the agent.'),
  first_message: z.string().min(1).describe('Opening message the agent should speak first.'),
  voice_id: z.string().min(1).describe('Voice ID for the agent output audio.'),
  language: firstClassAuthoringSchema.language,
  llm_model: firstClassAuthoringSchema.llm_model,
  temperature: firstClassAuthoringSchema.temperature,
  knowledge_base_document_ids: firstClassAuthoringSchema.knowledge_base_document_ids,
  advanced_config: firstClassAuthoringSchema.advanced_config,
});

const updateAgentSchema = z.object({
  agent_id: z.string().min(1).describe('Agent ID to update.'),
  ...firstClassAuthoringSchema,
});

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.agents)) return obj.agents;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

function extractNextCursor(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const obj = result as Record<string, unknown>;
  return typeof obj.next_cursor === 'string'
    ? obj.next_cursor
    : typeof obj.cursor === 'string'
      ? obj.cursor
      : typeof obj.next_page_token === 'string'
        ? obj.next_page_token
        : undefined;
}

/**
 * Round-trip contract for the authoring surface.
 *
 * `get_agent` / `list_agents` return every non-structural string enveloped
 * (deny-by-default, `sanitize.ts`), and these tools' own descriptions tell the model
 * to read the current config *before* patching it. So the values the model copies
 * back in — a `language`, an `llm_model`, a `system_prompt`, or a whole
 * `advanced_config` fragment lifted out of a `get_agent` response — arrive wrapped.
 * Strip exactly one envelope on the way in so what gets stored upstream is the
 * original text, not `<untrusted-content …>…</untrusted-content>`.
 *
 * This input-side half is deliberately chosen over widening the output allowlist:
 * hostile prose sitting in a config-shaped field still leaves `get_agent` enveloped,
 * so the deny-by-default output boundary is untouched. `unwrapUntrusted` is
 * one-layer and a no-op on any string that is not a whole envelope, so ordinary
 * hand-authored input passes through byte-identical.
 */
function unwrapAuthoredInput(value: unknown): unknown {
  if (typeof value === 'string') return unwrapUntrusted(value);
  if (value === null || typeof value !== 'object') return value;
  // Objects/arrays (advanced_config, knowledge_base_document_ids) may have been copied
  // wholesale from an enveloped response — unwrap keys and values recursively.
  return unwrapUntrustedJsonStrings(value);
}

function unwrapAuthoredArgs(args: Record<string, unknown>): Obj {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, unwrapAuthoredInput(value)]),
  );
}

function hasAnyAuthoringChange(value: Record<string, unknown>): boolean {
  return FIRST_CLASS_AUTHORING_FIELDS.some((field) => value[field] !== undefined)
    || value.advanced_config !== undefined;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) {
    return patch;
  }

  const out: Obj = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

function setNestedField(target: Obj, path: readonly string[], value: unknown): void {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const existing = cursor[segment];
    if (!isObj(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Obj;
  }
  cursor[path[path.length - 1]!] = value;
}

function buildAuthoringPatch(args: Record<string, unknown>): Obj {
  const patch: Obj = {};

  if (typeof args.name === 'string') {
    patch.name = args.name;
  }
  if (typeof args.system_prompt === 'string') {
    setNestedField(
      patch,
      ['conversation_config', 'agent', 'prompt', 'prompt'],
      args.system_prompt,
    );
  }
  if (typeof args.first_message === 'string') {
    setNestedField(
      patch,
      ['conversation_config', 'agent', 'first_message'],
      args.first_message,
    );
  }
  if (typeof args.voice_id === 'string') {
    setNestedField(
      patch,
      ['conversation_config', 'tts', 'voice_id'],
      args.voice_id,
    );
  }
  if (typeof args.language === 'string') {
    setNestedField(
      patch,
      ['conversation_config', 'agent', 'language'],
      args.language,
    );
  }
  if (typeof args.llm_model === 'string') {
    setNestedField(
      patch,
      ['conversation_config', 'agent', 'prompt', 'llm_model'],
      args.llm_model,
    );
  }
  if (typeof args.temperature === 'number') {
    setNestedField(
      patch,
      ['conversation_config', 'agent', 'prompt', 'temperature'],
      args.temperature,
    );
  }
  if (Array.isArray(args.knowledge_base_document_ids)) {
    setNestedField(
      patch,
      ['conversation_config', 'agent', 'prompt', 'knowledge_base_document_ids'],
      args.knowledge_base_document_ids,
    );
  }

  return patch;
}

function buildAuthoringBody(args: Record<string, unknown>): Obj {
  const authored = unwrapAuthoredArgs(args);
  const patch = buildAuthoringPatch(authored);
  const body = isObj(authored.advanced_config)
    ? deepMerge(patch, authored.advanced_config) as Obj
    : patch;
  // Same SSRF boundary `add_agent_tool` applies to its passthrough: the merged
  // body is what goes on the wire, so every `url`-keyed string in it
  // (custom_llm.url, platform_settings webhook URLs, …) must pass the
  // public-https policy before any upstream call. Unlike the tool surface,
  // there is no first-class url argument here to protect — URLs only ever
  // arrive inside advanced_config, so this wire-shape revalidation is the
  // whole boundary, not defense in depth behind one.
  validateNestedPublicHttpsUrls(body, 'config');
  return body;
}

function extractAgentId(result: unknown): string | undefined {
  if (!isObj(result)) return undefined;
  if (typeof result.agent_id === 'string' && result.agent_id.length > 0) {
    return result.agent_id;
  }
  if (isObj(result.agent) && typeof result.agent.agent_id === 'string' && result.agent.agent_id.length > 0) {
    return result.agent.agent_id;
  }
  return undefined;
}

function extractAgentPayload(result: unknown): unknown {
  if (!isObj(result)) return result;
  if (isObj(result.agent)) return result.agent;
  return result;
}

function isAgentConfigResponse(result: unknown): boolean {
  const payload = extractAgentPayload(result);
  return isObj(payload) && (
    typeof payload.agent_id === 'string'
    || typeof payload.name === 'string'
    || isObj(payload.conversation_config)
  );
}

async function fetchAgent(apiKey: string, agentId: string, source: string): Promise<unknown> {
  const result = await elevenLabsJson<unknown>(
    apiKey,
    ENDPOINTS.agent(agentId),
    { method: 'GET' },
  );
  return sanitizeAgent(result, source);
}

async function resolveAgentResponse(
  apiKey: string,
  result: unknown,
  source: string,
): Promise<{ agent_id?: string; agent?: unknown }> {
  const agentId = extractAgentId(result);
  if (isAgentConfigResponse(result)) {
    return {
      ...(agentId ? { agent_id: agentId } : {}),
      agent: sanitizeAgent(extractAgentPayload(result), source),
    };
  }
  if (agentId) {
    try {
      return {
        agent_id: agentId,
        agent: await fetchAgent(apiKey, agentId, source),
      };
    } catch {
      return { agent_id: agentId };
    }
  }
  return {};
}

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    'list_agents',
    {
      description: `List voice agents in your ElevenLabs Conversational AI workspace.

WHEN TO USE:
- Discover available agent IDs before inspecting one in detail
- Inventory check before reviewing prompts or recent conversations

EXAMPLE: {"page_size": 10}

RELATED TOOLS:
- get_agent: inspect a returned agent_id in full
- list_conversations: review recent calls for a returned agent_id

RETURNS: agents, count, next_cursor.

FREE.`,
      inputSchema: z.object({
        page_size: z.number().int().min(1).max(100).optional()
          .describe('Maximum number of agents to return (for live checks, use 1).'),
        cursor: z.string().optional().describe('Pagination cursor from the previous response.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const params = new URLSearchParams();
      if (args.page_size !== undefined) params.set('page_size', String(args.page_size));
      if (args.cursor) params.set('cursor', args.cursor);
      const qs = params.toString();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        `${ENDPOINTS.AGENTS}${qs ? `?${qs}` : ''}`,
        { method: 'GET' },
      );
      const items = extractItems(result);
      return JSON.stringify({
        ok: true,
        agents: sanitizeList(items, sanitizeAgentSummary, 'elevenlabs-agents:list_agents'),
        count: items.length,
        next_cursor: extractNextCursor(result),
        message: `Found ${items.length} agent(s).`,
      });
    }),
  );

  server.registerTool(
    'get_agent',
    {
      description: `Get full configuration for one ElevenLabs agent, including prompts and nested conversation settings.

WHEN TO USE:
- Inspect the system prompt or first message before changing anything
- Confirm the exact agent configuration behind recent conversations

EXAMPLE: {"agent_id": "agent_123"}

RELATED TOOLS:
- list_agents: discover valid agent IDs
- list_conversations: inspect recent conversations for this agent

RETURNS: agent.

FREE.`,
      inputSchema: z.object({
        agent_id: z.string().min(1).describe('Agent ID to inspect. Use list_agents if you only know the name.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.agent(args.agent_id),
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        agent: sanitizeAgent(result, 'elevenlabs-agents:get_agent'),
      });
    }),
  );

  server.registerTool(
    'create_agent',
    {
      description: `Create one ElevenLabs agent from a user-friendly authoring surface.

WHEN TO USE:
- Draft a new agent from scratch with a name, prompt, first message, and voice
- Create a working baseline before adding niche platform-specific settings via advanced_config

EXAMPLE: {"name": "Support triage", "system_prompt": "Help customers quickly and clearly.", "first_message": "Thanks for calling Support. How can I help?", "voice_id": "voice_123"}

RELATED TOOLS:
- get_agent: inspect the created agent in full
- update_agent: make partial edits later; PATCH deep-merges nested config
- duplicate_agent: safer iteration path when changing a production agent

RETURNS: agent_id and, when the follow-up read succeeds, agent.

COST: Uses ElevenLabs agent resources; creation itself is not a read-only action.

COMMON MISTAKES:
- URL fields inside advanced_config (custom_llm.url, platform_settings webhook URLs) must be public https:// addresses; loopback, private, link-local, and cloud-metadata destinations are rejected before any upstream call.`,
      inputSchema: createAgentSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const body = buildAuthoringBody(args as Record<string, unknown>);
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.AGENTS_CREATE,
        { method: 'POST', body: JSON.stringify(body) },
      );
      const resolved = await resolveAgentResponse(apiKey, result, 'elevenlabs-agents:create_agent');
      return JSON.stringify({
        ok: true,
        ...resolved,
        message: resolved.agent_id
          ? `Created agent ${resolved.agent_id}.`
          : 'Created agent successfully.',
      });
    }),
  );

  server.registerTool(
    'update_agent',
    {
      description: `Partially update one ElevenLabs agent. First-class fields map into nested conversation_config, and advanced_config deep-merges LAST.

WHEN TO USE:
- Change the prompt, opening message, voice, or language without rebuilding the full agent config
- Apply a precise advanced_config patch after reading the current agent config first

EXAMPLE: {"agent_id": "agent_123", "first_message": "Hi there, how can I help today?"}

RELATED TOOLS:
- get_agent: inspect the current nested config before patching
- duplicate_agent: duplicate first if you want a safer iterate-on-prod path
- simulate_conversation: test the updated agent before outbound or batch calling

RETURNS: agent.

COST: Uses ElevenLabs agent resources; PATCH is not read-only.

COMMON MISTAKES:
- PATCH deep-merges partial config, but advanced_config wins last if it targets the same nested path.
- URL fields inside advanced_config (custom_llm.url, platform_settings webhook URLs) must be public https:// addresses; loopback, private, link-local, and cloud-metadata destinations are rejected before any upstream call.
- If you are experimenting on a production agent, prefer duplicate_agent first and update the duplicate.`,
      inputSchema: updateAgentSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (!hasAnyAuthoringChange(args as Record<string, unknown>)) {
        throw new ElevenLabsError(
          'Provide at least one field to update: name/system_prompt/first_message/voice_id/language/llm_model/temperature/knowledge_base_document_ids or advanced_config.',
          'INVALID_ARGUMENTS',
          'Include at least one editable field in addition to agent_id, then retry.',
        );
      }

      const apiKey = requireApiKey();
      const { agent_id, ...updateArgs } = args;
      const body = buildAuthoringBody(updateArgs as Record<string, unknown>);
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.agent(agent_id),
        { method: 'PATCH', body: JSON.stringify(body) },
      );
      const resolved = await resolveAgentResponse(apiKey, result, 'elevenlabs-agents:update_agent');
      const agent = resolved.agent ?? sanitizeAgent(result, 'elevenlabs-agents:update_agent');
      return JSON.stringify({
        ok: true,
        agent_id,
        agent,
        message: `Updated agent ${agent_id}.`,
      });
    }),
  );

  server.registerTool(
    'duplicate_agent',
    {
      description: `Duplicate one ElevenLabs agent, optionally with a new name.

WHEN TO USE:
- Make a safe copy before editing a production agent
- Fork an existing agent as the starting point for a variant

EXAMPLE: {"agent_id": "agent_123", "name": "Support triage v2"}

RELATED TOOLS:
- get_agent: inspect the duplicated config in full
- update_agent: make targeted edits on the duplicate
- delete_agent: remove the duplicate when a test branch is no longer needed

RETURNS: agent_id and, when the follow-up read succeeds, agent.

COST: Uses ElevenLabs agent resources; duplication is not read-only.`,
      inputSchema: z.object({
        agent_id: z.string().min(1).describe('Agent ID to duplicate.'),
        name: z.string().min(1).optional()
          .describe('Optional new name for the duplicate.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      // Same round-trip contract as buildAuthoringBody: `name` comes back enveloped
      // from get_agent/list_agents, so a copied name must not be stored as an envelope.
      const body = args.name ? { name: unwrapUntrusted(args.name) } : {};
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.agentDuplicate(args.agent_id),
        { method: 'POST', body: JSON.stringify(body) },
      );
      const resolved = await resolveAgentResponse(apiKey, result, 'elevenlabs-agents:duplicate_agent');
      return JSON.stringify({
        ok: true,
        ...resolved,
        message: resolved.agent_id
          ? `Duplicated agent ${args.agent_id} to ${resolved.agent_id}.`
          : `Duplicated agent ${args.agent_id}.`,
      });
    }),
  );

  server.registerTool(
    'delete_agent',
    {
      description: `Permanently delete one ElevenLabs agent.

WHEN TO USE:
- Remove a temporary or test agent such as a rebel-live-test-* artifact
- Clean up a duplicate or abandoned draft after confirming it is no longer needed

EXAMPLE: {"agent_id": "agent_123"}

RELATED TOOLS:
- duplicate_agent: safer way to branch before destructive edits
- get_agent: confirm the exact agent before deletion

RETURNS: ok confirmation. Conversation history is retained upstream even though the agent itself is removed.

COST: FREE — no generation credits, but this is irreversible.`,
      inputSchema: z.object({
        agent_id: z.string().min(1).describe('Agent ID to delete permanently.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      try {
        await elevenLabsFetch(apiKey, ENDPOINTS.agent(args.agent_id), { method: 'DELETE' });
      } catch (error) {
        if (error instanceof ElevenLabsError && error.code === 'HTTP_404') {
          throw new ElevenLabsError(
            `Agent not found: ${args.agent_id}`,
            'AGENT_NOT_FOUND',
            'Re-list agents and retry with the exact returned agent_id.',
          );
        }
        throw error;
      }

      return JSON.stringify({
        ok: true,
        agent_id: args.agent_id,
        message: `Deleted agent ${args.agent_id}.`,
      });
    }),
  );

  server.registerTool(
    'simulate_conversation',
    {
      description: `Run a simulated conversation between one agent and a simulated user. This burns LLM credits but does not place a real call.

WHEN TO USE:
- Test prompt, voice, and tool-routing changes before telephony work
- Validate a draft or duplicate agent with one short starter message

EXAMPLE: {"agent_id": "agent_123", "user_message": "I need help rescheduling my appointment."}

RELATED TOOLS:
- update_agent: change the prompt or first message before re-running the simulation
- duplicate_agent: fork a production agent before testing variants
- make_outbound_call: only after the simulation looks correct

RETURNS: simulated_conversation and analysis.

COST: Uses ElevenLabs LLM/simulation credits.`,
      inputSchema: z.object({
        agent_id: z.string().min(1).describe('Agent ID to simulate.'),
        user_message: z.string().min(1)
          .describe('Opening message for the simulated user. Keep it short for fast checks.'),
        language: z.string().min(1).optional()
          .describe('Optional language for the simulated user (for example "en").'),
        disable_first_message_interruptions: z.boolean().optional()
          .describe('Optional simulated-user flag mirroring the ElevenLabs API request shape.'),
        new_turns_limit: z.number().int().min(1).max(10_000).optional()
          .describe('Maximum number of new turns to generate. Default: ElevenLabs API default.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.agentSimulateConversation(args.agent_id),
        {
          method: 'POST',
          body: JSON.stringify({
            simulation_specification: {
              simulated_user_config: {
                // `language` is read back enveloped from get_agent; `user_message` may be
                // quoted from an enveloped transcript. Same round-trip contract.
                first_message: unwrapUntrusted(args.user_message),
                ...(args.language ? { language: unwrapUntrusted(args.language) } : {}),
                ...(args.disable_first_message_interruptions !== undefined
                  ? { disable_first_message_interruptions: args.disable_first_message_interruptions }
                  : {}),
              },
            },
            ...(args.new_turns_limit !== undefined ? { new_turns_limit: args.new_turns_limit } : {}),
          }),
        },
      );
      const sanitized = sanitizeSimulation(result, 'elevenlabs-agents:simulate_conversation') as Obj;
      return JSON.stringify({
        ok: true,
        simulated_conversation: sanitized.simulated_conversation ?? [],
        analysis: sanitized.analysis ?? {},
        message: `Simulated conversation for agent ${args.agent_id}.`,
      });
    }),
  );
}
