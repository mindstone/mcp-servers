import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retellFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';

export function registerCallTools(server: McpServer): void {
  server.registerTool(
    'create_phone_call',
    {
      description: `Create an outbound phone call using a Retell AI voice agent.

WHEN TO USE:
- User asks you to make, place, or initiate a phone call
- After setting up the agent's prompt via update_retell_llm

WORKFLOW (typical sequence):
1. list_agents → find the right agent, note its agent_id
2. get_agent → check config, get its retell_llm_id
3. update_retell_llm → set the conversation prompt/instructions for this call
4. Wait 2-3 seconds (let config propagate)
5. create_phone_call → initiate the call
6. Poll get_call every 5-10s until status is "ended" or "error"

REQUIRED: from_number (agent's registered number, E.164) and to_number (recipient, E.164).
Use list_phone_numbers to find available from_numbers.

RETURNS: Call object with call_id, status, agent_id. Use call_id with get_call to track progress and get the transcript.

COST: Uses phone minutes from your Retell AI plan. Calls are billed per minute.`,
      inputSchema: {
        from_number: z.string().describe('Caller phone number in E.164 format (e.g. +14155551234). Must be registered in your Retell account. Use list_phone_numbers to find available numbers.'),
        to_number: z.string().describe('Recipient phone number in E.164 format (e.g. +14155551234).'),
        override_agent_id: z.string().optional().describe('Agent ID to use for this call. If omitted, uses the default agent assigned to from_number.'),
        metadata: z.record(z.unknown()).optional().describe('Custom metadata key-value pairs to attach to this call.'),
        retell_llm_dynamic_variables: z.record(z.unknown()).optional().describe("Dynamic variables to inject into the agent's prompt template."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const body: Record<string, unknown> = {
        from_number: args.from_number,
        to_number: args.to_number,
      };
      if (args.override_agent_id) body.override_agent_id = args.override_agent_id;
      if (args.metadata) body.metadata = args.metadata;
      if (args.retell_llm_dynamic_variables) body.retell_llm_dynamic_variables = args.retell_llm_dynamic_variables;

      const result = await retellFetch<Record<string, unknown>>(
        '/create-phone-call',
        { method: 'POST', body: JSON.stringify(body) },
      );

      return JSON.stringify({
        ok: true,
        ...result,
        message: `Phone call initiated (call_id: ${result.call_id}). Use get_call to monitor status and retrieve the transcript when the call ends.`,
      });
    }),
  );

  server.registerTool(
    'create_web_call',
    {
      description: `Create a browser-based voice call with a Retell AI agent. Returns a web_call_link the user can open to talk to the agent.

WHEN TO USE:
- User wants to test or demo a voice agent without using a real phone number
- User wants to have a voice conversation through their browser

RETURNS: Object with call_id, web_call_link, and access_token. The web_call_link opens a browser-based voice UI.

COST: Uses minutes from your Retell AI plan, same as phone calls.`,
      inputSchema: {
        agent_id: z.string().describe('Agent ID to handle the web call. Use list_agents to find available agents.'),
        metadata: z.record(z.unknown()).optional().describe('Custom metadata key-value pairs for this call.'),
        retell_llm_dynamic_variables: z.record(z.unknown()).optional().describe("Dynamic variables to inject into the agent's prompt template."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const body: Record<string, unknown> = {
        agent_id: args.agent_id,
      };
      if (args.metadata) body.metadata = args.metadata;
      if (args.retell_llm_dynamic_variables) body.retell_llm_dynamic_variables = args.retell_llm_dynamic_variables;

      const result = await retellFetch<Record<string, unknown>>(
        '/create-web-call',
        { method: 'POST', body: JSON.stringify(body) },
      );

      return JSON.stringify({
        ok: true,
        ...result,
        message: `Web call created (call_id: ${result.call_id}). Share the web_call_link with the user to start the call in their browser.`,
      });
    }),
  );

  server.registerTool(
    'get_call',
    {
      description: `Get details about a specific call — status, duration, transcript, recording URL, and more.

WHEN TO USE:
- After create_phone_call or create_web_call to monitor progress
- To retrieve the transcript after a call ends
- To check call status, duration, or disconnect reason

RETURNS: Full call object including status, transcript, recording_url, call_analysis, timestamps.`,
      inputSchema: {
        call_id: z.string().describe('The call ID returned by create_phone_call or create_web_call.'),
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
        `/get-call/${encodeURIComponent(args.call_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({ ok: true, ...result });
    }),
  );

  server.registerTool(
    'list_calls',
    {
      description: `List and filter calls. Useful for reviewing call history, finding recent calls, or filtering by agent.

FILTERING: All parameters are optional. Combine them to narrow results:
- agent_id: Only calls from a specific agent
- filter_criteria.after_start_timestamp / before_start_timestamp: Time range (Unix ms)
- sort_order: "ascending" or "descending" (default: descending = newest first)
- limit: Max results, 1-1000 (default: 50)

RETURNS: Array of call objects with call_id, status, agent_id, duration, and metadata.`,
      inputSchema: {
        agent_id: z.string().optional().describe('Filter calls by agent ID.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max results (1-1000). Default: 50.'),
        sort_order: z.enum(['ascending', 'descending']).optional().describe('Sort by start time. Default: descending (newest first).'),
        filter_criteria: z.object({
          after_start_timestamp: z.number().int().optional().describe('Only calls started after this Unix timestamp (milliseconds).'),
          before_start_timestamp: z.number().int().optional().describe('Only calls started before this Unix timestamp (milliseconds).'),
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
      if (args.filter_criteria) body.filter_criteria = args.filter_criteria;

      const result = await retellFetch<unknown[]>(
        '/list-calls',
        { method: 'POST', body: JSON.stringify(body) },
      );

      return JSON.stringify({
        ok: true,
        calls: result,
        count: Array.isArray(result) ? result.length : 0,
        message: `Found ${Array.isArray(result) ? result.length : 0} call(s).`,
      });
    }),
  );
}
