import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retellFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { epochMsField, validateE164 } from './calls.js';
import { checkDynamicVariableReferences } from '../precall-checks.js';
import { sanitizeBatchCall } from '../sanitize.js';

const batchTaskSchema = z.object({
  to_number: z.string().describe('Recipient phone number in E.164 format (e.g. +14155559876).'),
  override_agent_id: z.string().optional().describe('Agent ID to use for this specific call (one-time override; does not rebind the number). If set, also pass override_agent_version for reliable routing.'),
  override_agent_version: z.union([z.number().int().min(0), z.string()]).optional()
    .describe('Agent version for this call: number (0, 1, 2...) or tag (e.g. "latest"). Use with override_agent_id.'),
  retell_llm_dynamic_variables: z.record(z.unknown()).optional().describe("Per-recipient dynamic variables injected into the prompt template (e.g. { customer_name: 'Jane' }). WARNING: only works if the LLM prompt already contains matching {{variable_name}} placeholders; unmatched variables are silently dropped. Check get_retell_llm first."),
  metadata: z.record(z.unknown()).optional().describe('Custom metadata for this call (CRM IDs, campaign IDs, row numbers). Returned on the call object afterwards.'),
});

const callTimeWindowSchema = z.object({
  windows: z.array(z.object({
    start: z.number().int().min(0).max(1439).describe('Window start in minutes since local midnight (e.g. 540 = 09:00).'),
    end: z.number().int().min(1).max(1440).describe('Window end in minutes since local midnight (e.g. 1020 = 17:00; 1440 = 24:00). Must be greater than start — cross-midnight windows are not allowed.'),
  })).min(1).describe('Allowed calling windows as half-open [start, end) intervals in local minutes.'),
  timezone: z.string().optional().describe('IANA timezone for the windows (e.g. "America/New_York"). Default: America/Los_Angeles.'),
  day: z.array(z.enum(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])).optional()
    .describe('Days the windows apply to. Omit or pass an empty array to allow every day.'),
});

export function registerBatchCallTools(server: McpServer): void {
  server.registerTool(
    'create_batch_call',
    {
      description: `Create a batch of outbound phone calls (a calling campaign) from one from_number to many recipients.

WHEN TO USE:
- User asks to call a list of people (appointment reminders, follow-ups, re-engagement)
- Scheduled outbound campaigns — trigger_timestamp defers the start, call_time_window restricts calling hours

CRITICAL: Every task in the batch is a real, billed phone call to a real person. The MCP host MUST surface the full recipient list to the user and get explicit confirmation before invoking this tool. A mistake here rings N phones, not one.

WORKFLOW:
1. get_concurrency → confirm the account has headroom for the batch size
2. list_phone_numbers/get_phone_number → confirm from_number has an outbound agent bound
3. update_retell_llm + publish_agent → set and publish the campaign prompt
4. create_batch_call → schedule or start the batch
5. list_calls (filter by agent) → monitor results as calls complete

EXAMPLE:
{ "from_number": "+14155551234", "name": "March reminder campaign", "tasks": [{ "to_number": "+14155559876", "retell_llm_dynamic_variables": { "customer_name": "Jane" } }] }

COMMON MISTAKES:
- Passing dynamic variables the prompt does not reference; they are silently dropped (check get_retell_llm first)
- Forgetting the per-call agent binding: from_number needs an outbound_agents binding (update_phone_number), or each task needs override_agent_id + override_agent_version
- Using seconds for trigger_timestamp; Retell expects milliseconds

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 402: payment required → add a payment method in the Retell dashboard
- 422: invalid task shape → verify every to_number is E.164 and the from_number is registered

RELATED TOOLS:
- get_concurrency: Check capacity before sizing the batch
- list_phone_numbers/update_phone_number: Verify or fix the outbound binding on from_number
- update_retell_llm/publish_agent: Prepare the campaign prompt
- list_calls/get_call: Track individual call outcomes

RETURNS: batch_call_id, name, from_number, scheduled_timestamp, total_task_count, call_time_window when set, and warnings when the pre-call prompt check finds unmatched dynamic variables or could not run. Use list_calls to track the individual calls afterwards.
COST: Each task uses phone minutes from your Retell AI plan.`,
      inputSchema: {
        from_number: z.string().describe('Caller phone number in E.164 format (e.g. +14155551234). Must be registered in Retell with an outbound agent binding. Use list_phone_numbers to find available numbers.'),
        tasks: z.array(batchTaskSchema).min(1).max(1000)
          .describe('Recipients to call — one task per outbound call. Each needs to_number (E.164) and may carry per-call dynamic variables, metadata, and agent overrides.'),
        name: z.string().optional().describe('Batch name for your own reference (e.g. "March reminder campaign").'),
        trigger_timestamp: epochMsField().optional()
          .describe('When to start the batch. Unix timestamp in milliseconds (number, e.g. 1735689600000) or a parseable date string (e.g. "2026-01-01"). Omit to start immediately.'),
        reserved_concurrency: z.number().int().min(0).optional()
          .describe('Concurrency slots to keep free for non-batch calls (e.g. inbound). Check get_concurrency before setting this.'),
        call_time_window: callTimeWindowSchema.optional()
          .describe('Restrict calling to specific hours/days in a timezone (e.g. business hours only). Calls outside the window wait for the next window.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      // Validate every phone number BEFORE requireApiKey / outbound request so a
      // malformed number can never reach Retell's billing surface.
      validateE164('from_number', args.from_number);
      args.tasks.forEach((task, i) => validateE164(`tasks[${i}].to_number`, task.to_number));
      requireApiKey();

      const body: Record<string, unknown> = {
        from_number: args.from_number,
        tasks: args.tasks,
      };
      if (args.name) body.name = args.name;
      if (args.trigger_timestamp !== undefined) body.trigger_timestamp = args.trigger_timestamp;
      if (args.reserved_concurrency !== undefined) body.reserved_concurrency = args.reserved_concurrency;
      if (args.call_time_window) body.call_time_window = args.call_time_window;

      // Group tasks by the exact agent version that will run their prompt:
      // tasks without an override use from_number's default outbound agent;
      // each distinct (override_agent_id, override_agent_version) pair gets
      // its own prompt check — the same agent ID at two different published
      // versions can have different prompts, so they must not be merged.
      // Variable KEYS are merged per group (the check inspects keys, not
      // values).
      const varsByAgentVersion = new Map<string, {
        overrideAgentId?: string;
        overrideAgentVersion?: string | number;
        dynamicVariables: Record<string, unknown>;
      }>();
      for (const task of args.tasks) {
        if (!task.retell_llm_dynamic_variables) continue;
        // Structured tuple key: plain concatenation is not injective
        // ("agent_1"+23 vs "agent_12"+3 collide), which would let a task be
        // validated against the wrong agent's prompt.
        const groupKey = JSON.stringify([
          task.override_agent_id ?? null,
          task.override_agent_version ?? null,
        ]);
        const entry = varsByAgentVersion.get(groupKey) ?? {
          overrideAgentId: task.override_agent_id || undefined,
          overrideAgentVersion: task.override_agent_version,
          dynamicVariables: {},
        };
        Object.assign(entry.dynamicVariables, task.retell_llm_dynamic_variables);
        varsByAgentVersion.set(groupKey, entry);
      }

      // Run every distinct agent-version's prompt check BEFORE the create
      // call — the campaign must not be created while validation is still in
      // flight. A failed check never blocks the batch (the tool is destructive
      // by explicit user request) but always surfaces an explicit warning.
      const checkResults = await Promise.all(
        [...varsByAgentVersion.values()].map((entry) =>
          checkDynamicVariableReferences({
            fromNumber: args.from_number,
            dynamicVariables: entry.dynamicVariables,
            overrideAgentId: entry.overrideAgentId,
            overrideAgentVersion: entry.overrideAgentVersion,
          }),
        ),
      );
      const dynamicVarWarnings = checkResults.flatMap((warnings) => warnings ?? []);

      const result = await retellFetch<Record<string, unknown>>(
        '/create-batch-call',
        { method: 'POST', body: JSON.stringify(body) },
      );

      const response: Record<string, unknown> = {
        ok: true,
        ...(sanitizeBatchCall(result, 'retell:create_batch_call') as Record<string, unknown>),
        message: `Batch call created (batch_call_id: ${result.batch_call_id}, ${result.total_task_count ?? args.tasks.length} call(s)). Use list_calls to monitor individual call outcomes.`,
      };

      if (dynamicVarWarnings && dynamicVarWarnings.length > 0) {
        response.warnings = dynamicVarWarnings;
      }

      return JSON.stringify(response);
    }),
  );
}
