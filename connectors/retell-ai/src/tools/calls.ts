import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retellFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { ConnectorError } from '../types.js';
import { checkDynamicVariableReferences } from '../precall-checks.js';
import { sanitizeCall, sanitizeList } from '../sanitize.js';

/**
 * E.164 phone-number regex.
 *
 * - Leading `+`
 * - First digit MUST be 1-9 (no leading zero in the country code)
 * - Total of 2-15 digits after the `+` (E.164 max length is 15 digits inclusive
 *   of country code)
 *
 * Spaces, dashes, parentheses, and any other formatting characters are
 * rejected — callers must normalise before invoking this tool.
 */
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

/**
 * Coerce a parseable date string (ISO 8601, RFC 2822, or a digit-only epoch-ms
 * string) to epoch milliseconds. Non-strings and un-coercible strings pass
 * through unchanged — the refine in epochMsField rejects the latter.
 */
const coerceEpochMs = (val: unknown): unknown => {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (trimmed === '') return val;
  if (/^\d+$/.test(trimmed)) {
    // Digit-only strings are accepted ONLY in the unambiguous epoch-ms window
    // [1e12, 1e14) (≈ Sep 2001 → year 5138). Anything else — Unix SECONDS
    // ("1735689600" would silently be 1000x off), microseconds, tiny values —
    // is returned unchanged so the refine rejects it with an actionable
    // message. Never let digit-only strings fall through to Date.parse:
    // V8 parses "5" as year 2005 and "0" as 2000.
    const num = Number(trimmed);
    return num >= 1e12 && num < 1e14 ? num : val;
  }
  const ms = new Date(trimmed).getTime();
  return Number.isNaN(ms) ? val : ms;
};

/**
 * Epoch-milliseconds field that advertises BOTH number and string in the
 * exported JSON schema (anyOf integer|string), while coercing date strings to
 * epoch ms and rejecting un-coercible strings (including ambiguous digit-only
 * strings such as Unix seconds) at runtime.
 *
 * Why: strict MCP hosts validate a tool call against the exported schema
 * BEFORE the connector runs, and LLMs frequently send ISO date strings for
 * epoch-ms fields. A bare z.number() schema gets such calls rejected at the
 * host boundary, where the connector never gets a chance to coerce.
 * See CONTRIBUTING.md "Date & timestamp fields".
 */
const epochMsField = () =>
  z.preprocess(coerceEpochMs, z.union([z.number().int(), z.string()]))
    .refine((v): v is number => typeof v === 'number', {
      message: 'Expected epoch milliseconds (number), a 13-digit epoch-ms string, or a parseable date string (e.g. "2026-01-01").',
    });

// Exported for reuse by batch-calls.ts (same call-validation rules).
export { epochMsField };

export function validateE164(field: string, value: string): void {
  if (!E164_REGEX.test(value)) {
    throw new ConnectorError(
      `${field} must be in E.164 format (e.g. +14155551234)`,
      'INVALID_PHONE_NUMBER',
      'Provide a phone number with a leading "+", a country code starting with a digit 1-9, and 1-14 additional digits. No spaces, dashes, parentheses, or other formatting characters.',
    );
  }
}

export function registerCallTools(server: McpServer): void {
  server.registerTool(
    'create_phone_call',
    {
      description: `Create an outbound phone call using a Retell AI voice agent.

WHEN TO USE: User asks you to make, place, or initiate a phone call.

WORKFLOW (typical sequence):
1. list_agents → find the right agent, note its agent_id
2. get_agent → check config, get its retell_llm_id
3. update_retell_llm → set the conversation prompt/instructions
4. Wait 2-3 seconds (let config propagate)
5. create_phone_call → initiate the call
6. Poll get_call every 5-10s until status is "ended"

EXAMPLE:
{ "from_number": "+14155551234", "to_number": "+14155559876", "override_agent_id": "agent_xxx", "override_agent_version": 2 }

COMMON MISTAKES:
- Skipping update_retell_llm first: the agent will use the previous call's prompt
- Passing override_agent_id without override_agent_version: Retell may route to the wrong or unpublished version
- Assuming the phone number is already bound: check list_phone_numbers/get_phone_number
- Updating the agent or LLM but not publishing the version before calling

ERROR RECOVERY:
- 401: API key is missing or invalid → the user adds it in Settings → Connectors in the app; do not ask for it in chat
- 404: resource/version/binding not found → check phone number outbound_agents, get_agent_versions, then publish_agent or pass override_agent_version
- 422: bad parameter shape/value → verify E.164 phone numbers and valid agent/version IDs

CRITICAL: If the call returns 404, the most common causes are:
- The phone number has no outbound agent bound → use update_phone_number to bind one
- The agent version is unpublished → use publish_agent first, or pass override_agent_version
- Always pass override_agent_id AND override_agent_version for reliable routing

RELATED TOOLS:
- update_retell_llm: Set the prompt before placing the call
- get_phone_number/list_phone_numbers: Verify outbound bindings and from_number
- publish_agent/get_agent_versions: Confirm the version is live
- get_call: Monitor status and retrieve transcript/recording

RETURNS: call_id, status, agent_id, from_number, to_number, start_timestamp, metadata. Use call_id with get_call to track progress.
COST: Uses phone minutes from your Retell AI plan.`,
      inputSchema: {
        from_number: z.string().describe('Caller phone number in E.164 format (e.g. +14155551234). Must be registered in Retell and have an outbound agent binding. Use list_phone_numbers to find available numbers.'),
        to_number: z.string().describe('Recipient phone number in E.164 format (e.g. +14155559876).'),
        override_agent_id: z.string().optional().describe('Agent ID to use for this call. If set, also pass override_agent_version for reliable routing. If omitted, uses the default agent assigned to from_number.'),
        override_agent_version: z.union([z.number().int().min(0), z.string()]).optional()
          .describe('Agent version: number (0, 1, 2...) or tag ("latest", "prod"). Use with override_agent_id for reliable routing to a published version.'),
        metadata: z.record(z.unknown()).optional().describe('Custom metadata key-value pairs to attach to this call (for CRM IDs, campaign IDs, user context).'),
        retell_llm_dynamic_variables: z.record(z.unknown()).optional().describe("Dynamic variables to inject into the prompt template (e.g. { customer_name: 'Jane', account_tier: 'pro' }). WARNING: These ONLY work if the LLM prompt already contains matching {{variable_name}} placeholders. If the prompt doesn't reference them, they are silently dropped. Use get_retell_llm to check which variables the prompt supports before relying on this. If you need to inject new context, use update_retell_llm instead."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      // Validate phone numbers BEFORE requireApiKey / outbound request so a
      // malformed number can never reach Retell's billing surface.
      validateE164('from_number', args.from_number);
      validateE164('to_number', args.to_number);
      requireApiKey();
      const body: Record<string, unknown> = {
        from_number: args.from_number,
        to_number: args.to_number,
      };
      if (args.override_agent_id) body.override_agent_id = args.override_agent_id;
      if (args.override_agent_version !== undefined) body.override_agent_version = args.override_agent_version;
      if (args.metadata) body.metadata = args.metadata;
      if (args.retell_llm_dynamic_variables) body.retell_llm_dynamic_variables = args.retell_llm_dynamic_variables;

      const [result, dynamicVarWarnings] = await Promise.all([
        retellFetch<Record<string, unknown>>(
          '/v2/create-phone-call',
          { method: 'POST', body: JSON.stringify(body) },
        ),
        args.retell_llm_dynamic_variables
          ? checkDynamicVariableReferences({
              fromNumber: args.from_number,
              dynamicVariables: args.retell_llm_dynamic_variables as Record<string, unknown>,
              overrideAgentId: args.override_agent_id,
            })
          : Promise.resolve(null),
      ]);

      const response: Record<string, unknown> = {
        ok: true,
        ...(sanitizeCall(result, 'retell:create_phone_call') as Record<string, unknown>),
        message: `Phone call initiated (call_id: ${result.call_id}). Use get_call to monitor status and retrieve the transcript when the call ends.`,
      };

      if (dynamicVarWarnings && dynamicVarWarnings.length > 0) {
        response.warnings = dynamicVarWarnings;
      }

      return JSON.stringify(response);
    }),
  );

  server.registerTool(
    'create_web_call',
    {
      description: `Create a browser-based voice call session. Returns a web_call_link the user can open to talk to a Retell agent.

WHEN TO USE:
- User wants a voice call in their browser instead of their phone
- Phone call route is blocked (e.g. phone number binding issue)
- Testing or demoing an agent without using phone minutes

EXAMPLE:
{ "agent_id": "agent_xxx", "agent_version": "latest", "retell_llm_dynamic_variables": { "customer_name": "Jane" } }

COMMON MISTAKES:
- Forgetting agent_version when testing a specific published version
- Sharing an old web_call_link instead of creating a fresh session

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: agent/version not found → list_agents, get_agent_versions, then publish_agent if needed
- 422: bad dynamic variable shape → send a plain JSON object

RELATED TOOLS:
- list_agents/get_agent: Find the agent_id and response engine
- update_retell_llm: Set the prompt before creating the test session
- get_call: Retrieve transcript, analysis, and recording after the session

RETURNS: call_id, web_call_link, status, agent_id, access_token. Share web_call_link with the user.`,
      inputSchema: {
        agent_id: z.string().describe('Agent ID to handle the web call. Use list_agents/get_agent to verify it first.'),
        agent_version: z.union([z.number().int().min(0), z.string()]).optional()
          .describe('Agent version to use: number (0, 1, 2...) or tag (e.g. "latest", "prod"). Pass this when validating a specific published version.'),
        metadata: z.record(z.unknown()).optional().describe('Custom metadata for this call (CRM IDs, test labels, scenario names).'),
        retell_llm_dynamic_variables: z.record(z.unknown()).optional().describe("Dynamic prompt variables used by the Retell LLM prompt template. WARNING: Only works if the LLM prompt contains matching {{variable_name}} placeholders. Unmatched variables are silently dropped. Check get_retell_llm first."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const body: Record<string, unknown> = {
        agent_id: args.agent_id,
      };
      if (args.agent_version !== undefined) body.agent_version = args.agent_version;
      if (args.metadata) body.metadata = args.metadata;
      if (args.retell_llm_dynamic_variables) body.retell_llm_dynamic_variables = args.retell_llm_dynamic_variables;

      const [result, dynamicVarWarnings] = await Promise.all([
        retellFetch<Record<string, unknown>>(
          '/v2/create-web-call',
          { method: 'POST', body: JSON.stringify(body) },
        ),
        args.retell_llm_dynamic_variables
          ? checkDynamicVariableReferences({
              fromNumber: '',
              dynamicVariables: args.retell_llm_dynamic_variables as Record<string, unknown>,
              overrideAgentId: args.agent_id,
            })
          : Promise.resolve(null),
      ]);

      const response: Record<string, unknown> = {
        ok: true,
        ...(sanitizeCall(result, 'retell:create_web_call') as Record<string, unknown>),
        message: `Web call created (call_id: ${result.call_id}). Share the web_call_link with the user to start the call in their browser.`,
      };

      if (dynamicVarWarnings && dynamicVarWarnings.length > 0) {
        response.warnings = dynamicVarWarnings;
      }

      return JSON.stringify(response);
    }),
  );

  server.registerTool(
    'get_call',
    {
      description: `Get details of a specific call including status, transcript, recording URL, and duration.

WHEN TO USE:
- After create_phone_call or create_web_call to monitor progress
- To retrieve the full transcript after a call ends
- To check call status: "registered" (queued), "ongoing" (live), "ended" (complete), "error" (failed)

WORKFLOW: Poll every 5-10 seconds after creating a call until status is "ended" or "error".

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: call_id not found → check the ID returned by create_phone_call/create_web_call or use list_calls

RELATED TOOLS:
- create_phone_call/create_web_call: Source of call_id
- list_calls: Find recent call IDs if call_id is unknown
- stop_call: End an ongoing call

RETURNS: call_id, status, transcript, transcript_object, recording_url, call_analysis, duration_ms, disconnection_reason.`,
      inputSchema: {
        call_id: z.string().describe('The call ID returned by create_phone_call/create_web_call or found via list_calls.'),
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
        `/v2/get-call/${encodeURIComponent(args.call_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeCall(result, 'retell:get_call') as Record<string, unknown>),
      });
    }),
  );

  server.registerTool(
    'list_calls',
    {
      description: `List calls with filtering and pagination. Returns recent calls by default (newest first).

WHEN TO USE:
- Browse call history
- Find calls by agent, date range, or status
- Verify recent call activity

FILTERING:
- agent_id accepts an array of one or more agent IDs
- filter_criteria timestamps accept Unix milliseconds (number) or a parseable date string (e.g. "2026-01-01"); date strings are converted to milliseconds before the API call
- Example: { "limit": 20, "agent_id": ["agent_xxx"], "filter_criteria": { "after_start_timestamp": 1735689600000 } }

COMMON MISTAKES:
- Passing one agent_id as a string instead of an array
- Using seconds for numeric timestamps; Retell expects milliseconds

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 422: invalid filter shape → check agent_id is an array and numeric timestamps are milliseconds

RELATED TOOLS:
- get_call: Get transcript/recording/analysis for a returned call_id
- list_agents: Find agent IDs for filtering
- stop_call: End an ongoing call

RETURNS: calls, count, pagination_key, has_more. Each call includes call_id, status, agent_id, timestamps, and call metadata.`,
      inputSchema: {
        agent_id: z.array(z.string()).optional().describe('Filter calls by one or more agent IDs. Must be an array, even for one agent: ["agent_xxx"].'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max results (1-1000). Default: 50.'),
        sort_order: z.enum(['ascending', 'descending']).optional().describe('Sort by start time. Default: descending (newest first).'),
        pagination_key: z.string().optional().describe('Pagination key from previous response for the next page.'),
        filter_criteria: z.object({
          after_start_timestamp: epochMsField().optional().describe('Only calls started after this time. Unix timestamp in milliseconds (number, e.g. 1735689600000) or a parseable date string (e.g. "2026-01-01").'),
          before_start_timestamp: epochMsField().optional().describe('Only calls started before this time. Unix timestamp in milliseconds (number, e.g. 1738368000000) or a parseable date string (e.g. "2026-02-01").'),
        }).optional().describe('Time-based filters for narrowing call results.'),
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
      const body: Record<string, unknown> = {};
      if (args.agent_id) body.agent_id = args.agent_id;
      if (args.limit) body.limit = args.limit;
      if (args.sort_order) body.sort_order = args.sort_order;
      if (args.pagination_key) body.pagination_key = args.pagination_key;
      if (args.filter_criteria) body.filter_criteria = args.filter_criteria;

      const result = await retellFetch<unknown>(
        '/v3/list-calls',
        { method: 'POST', body: JSON.stringify(body) },
      );

      const resultObj = (result && typeof result === 'object' && !Array.isArray(result))
        ? result as Record<string, unknown>
        : null;
      const items = resultObj && Array.isArray(resultObj.items)
        ? (resultObj.items as unknown[])
        : (Array.isArray(result) ? result as unknown[] : []);

      return JSON.stringify({
        ok: true,
        calls: sanitizeList(items, sanitizeCall, 'retell:list_calls'),
        count: items.length,
        pagination_key: resultObj?.pagination_key,
        has_more: resultObj?.has_more,
        message: `Found ${items.length} call(s).`,
      });
    }),
  );

  server.registerTool(
    'get_concurrency',
    {
      description: `Get your account's current call concurrency and limits.

WHEN TO USE:
- Before create_batch_call or a burst of create_phone_call calls, to check capacity headroom
- To decide reserved_concurrency for a batch call (leave room for inbound traffic)
- To diagnose 429/rate-limit or call-queuing issues

HOW TO READ: concurrency_limit is the max simultaneous calls (base + purchased). current_concurrency is how many calls are live right now. Headroom = concurrency_limit - current_concurrency. If concurrency_burst_enabled, the account may exceed the normal limit up to concurrency_burst_limit with a surcharge.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key

RELATED TOOLS:
- create_batch_call: Check headroom before sizing a campaign
- list_calls: See which calls are currently occupying capacity

RETURNS: current_concurrency, concurrency_limit, base_concurrency, purchased_concurrency, concurrency_purchase_limit, remaining_purchase_limit, reserved_inbound_concurrency, concurrency_burst_enabled, concurrency_burst_limit.`,
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
      const result = await retellFetch<Record<string, unknown>>(
        '/get-concurrency',
        { method: 'GET' },
      );
      const current = typeof result.current_concurrency === 'number' ? result.current_concurrency : undefined;
      const limit = typeof result.concurrency_limit === 'number' ? result.concurrency_limit : undefined;
      return JSON.stringify({
        ok: true,
        ...result,
        available_concurrency: current !== undefined && limit !== undefined ? limit - current : undefined,
        message: current !== undefined && limit !== undefined
          ? `${current} of ${limit} concurrency slots in use (${limit - current} available).`
          : 'Concurrency info retrieved.',
      });
    }),
  );

  server.registerTool(
    'stop_call',
    {
      description: `Stop an ongoing call immediately.

WHEN TO USE:
- User wants to end a call in progress
- Call is stuck or behaving unexpectedly
- Emergency stop

COMMON MISTAKES:
- Calling this on an already ended call; use get_call first if unsure

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: call_id not found or no longer active → verify with list_calls/get_call

RELATED TOOLS:
- get_call: Check whether status is "ongoing" before stopping
- list_calls: Find the active call_id

RETURNS: ok, message. Retell returns HTTP 204 on success.`,
      inputSchema: {
        call_id: z.string().describe('The call ID of the ongoing call to stop. Confirm status with get_call when possible.'),
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
      const callId = args.call_id;
      await retellFetch<Record<string, unknown>>(
        `/v2/stop-call/${encodeURIComponent(callId)}`,
        { method: 'POST' },
      );
      return JSON.stringify({
        ok: true,
        message: `Call ${callId} stopped successfully.`,
      });
    }),
  );
}
