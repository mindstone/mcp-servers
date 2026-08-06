import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey, elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { sanitizeBatchCall, sanitizeList } from '../sanitize.js';
import { epochSecondsField, validateE164 } from '../schema-helpers.js';
import { ElevenLabsError } from '../types.js';
import { withErrorHandling } from '../utils.js';

function extractItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.batch_calls)) return obj.batch_calls;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

function unwrapBatchCallPayload(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const obj = result as Record<string, unknown>;
  if (obj.batch_call && typeof obj.batch_call === 'object' && obj.batch_call !== null) {
    return obj.batch_call;
  }
  return result;
}

function batchIdFromSanitized(batchCall: unknown): string | undefined {
  if (!batchCall || typeof batchCall !== 'object') return undefined;
  const batchId = (batchCall as Record<string, unknown>).batch_id;
  return typeof batchId === 'string' ? batchId : undefined;
}

function extractNextCursor(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const obj = result as Record<string, unknown>;
  return typeof obj.next_cursor === 'string'
    ? obj.next_cursor
    : typeof obj.cursor === 'string'
      ? obj.cursor
      : typeof obj.last_doc === 'string'
        ? obj.last_doc
        : undefined;
}

const recipientSchema = z.object({
  phone_number: z.string().min(1).describe('Recipient phone number in E.164 format.'),
  dynamic_variables: z.record(z.unknown()).optional()
    .describe('Optional per-recipient dynamic variables for conversation initiation.'),
});

function assertFutureScheduledTime(scheduledTimeUnix: number | undefined): void {
  if (scheduledTimeUnix === undefined) return;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (scheduledTimeUnix <= nowSeconds) {
    throw new ElevenLabsError(
      'scheduled_time_unix must be in the future.',
      'INVALID_SCHEDULED_TIME',
      'Omit scheduled_time_unix to start immediately, or pass a future time.',
    );
  }
}

export function registerBatchCallTools(server: McpServer): void {
  server.registerTool(
    'submit_batch_call',
    {
      description: `Submit a batch of outbound calls, optionally scheduled for a future time.

WHEN TO USE:
- Queue the same workflow for many recipients at once
- Schedule a call batch that should run later even if you close the app

EXAMPLE: {"call_name": "Q3 renewals", "agent_id": "agent_123", "agent_phone_number_id": "pn_123", "recipients": [{"phone_number": "+14155559876", "dynamic_variables": {"customer_name": "Jane"}}], "scheduled_time_unix": "2026-08-01T16:00:00Z"}

RELATED TOOLS:
- list_batch_calls: review recently submitted batches
- get_batch_call: inspect per-recipient statuses after submission
- cancel_batch_call: stop a queued or scheduled batch before it runs

RETURNS: batch_call. Scheduled batches run on ElevenLabs' servers even if you close the app.

COST: Uses ElevenLabs telephony/call minutes when recipients are dialed.`,
      inputSchema: z.object({
        call_name: z.string().min(1).describe('Human-readable name for this batch call job.'),
        agent_id: z.string().min(1).describe('Agent ID that will place these calls.'),
        agent_phone_number_id: z.string().min(1).optional()
          .describe('Optional outbound phone number ID to use for the batch.'),
        recipients: z.array(recipientSchema).min(1)
          .describe('One or more recipients. Each recipient becomes one outbound call.'),
        scheduled_time_unix: epochSecondsField('scheduled_time_unix').optional()
          .describe('Optional future start time in epoch seconds (number) or ISO date string. Omit to start immediately.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      args.recipients.forEach((recipient, index) => {
        validateE164(`recipients[${index}].phone_number`, recipient.phone_number);
      });
      assertFutureScheduledTime(args.scheduled_time_unix);
      const apiKey = requireApiKey();

      const body: Record<string, unknown> = {
        call_name: args.call_name,
        agent_id: args.agent_id,
        recipients: args.recipients.map((recipient) => ({
          phone_number: recipient.phone_number,
          ...(recipient.dynamic_variables
            ? {
              conversation_initiation_client_data: {
                dynamic_variables: recipient.dynamic_variables,
              },
            }
            : {}),
        })),
      };
      if (args.agent_phone_number_id !== undefined) {
        body.agent_phone_number_id = args.agent_phone_number_id;
      }
      if (args.scheduled_time_unix !== undefined) {
        body.scheduled_time_unix = args.scheduled_time_unix;
      }

      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.BATCH_CALLS_SUBMIT,
        { method: 'POST', body: JSON.stringify(body) },
      );

      const batchCall = sanitizeBatchCall(
        unwrapBatchCallPayload(result),
        'elevenlabs-agents:submit_batch_call',
      );
      const batchId = batchIdFromSanitized(batchCall);

      return JSON.stringify({
        ok: true,
        batch_id: batchId,
        batch_call: batchCall,
        message: `Batch call ${args.call_name} submitted successfully.`,
      });
    }),
  );

  server.registerTool(
    'list_batch_calls',
    {
      description: `List batch-call jobs in your ElevenLabs workspace.

WHEN TO USE:
- Review recent scheduled or completed batch jobs
- Find a batch_id before fetching one job in detail

EXAMPLE: {"limit": 10}

RELATED TOOLS:
- get_batch_call: inspect one batch job in detail
- cancel_batch_call: stop a queued or scheduled job
- retry_batch_call: re-run a failed or partial batch

RETURNS: batch_calls, count, next_cursor.

FREE.`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional()
          .describe('Maximum number of batch jobs to return.'),
        last_doc: z.string().optional().describe('Pagination cursor from the previous response.'),
        agent_id: z.string().optional().describe('Optional agent filter.'),
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
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.last_doc) params.set('last_doc', args.last_doc);
      if (args.agent_id) params.set('agent_id', args.agent_id);
      const qs = params.toString();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        `${ENDPOINTS.BATCH_CALLS_WORKSPACE}${qs ? `?${qs}` : ''}`,
        { method: 'GET' },
      );
      const items = extractItems(result);
      return JSON.stringify({
        ok: true,
        batch_calls: sanitizeList(items, sanitizeBatchCall, 'elevenlabs-agents:list_batch_calls'),
        count: items.length,
        next_cursor: extractNextCursor(result),
        message: `Found ${items.length} batch call job(s).`,
      });
    }),
  );

  server.registerTool(
    'get_batch_call',
    {
      description: `Get one batch-call job, including per-recipient statuses and dynamic variables.

WHEN TO USE:
- Check which recipients succeeded, failed, or are still queued
- Confirm the stored scheduled time before deciding to cancel or retry

EXAMPLE: {"batch_id": "batch_123"}

RELATED TOOLS:
- list_batch_calls: discover valid batch IDs
- cancel_batch_call: stop this job if it is still queued or scheduled
- retry_batch_call: submit a new run after failures

RETURNS: batch_call.

FREE.`,
      inputSchema: z.object({
        batch_id: z.string().min(1).describe('Batch job ID to inspect.'),
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
        ENDPOINTS.batchCall(args.batch_id),
        { method: 'GET' },
      );
      const batchCall = sanitizeBatchCall(
        unwrapBatchCallPayload(result),
        'elevenlabs-agents:get_batch_call',
      );
      return JSON.stringify({
        ok: true,
        batch_id: batchIdFromSanitized(batchCall) ?? args.batch_id,
        batch_call: batchCall,
      });
    }),
  );

  server.registerTool(
    'cancel_batch_call',
    {
      description: `Cancel a queued or scheduled batch-call job before it dials more recipients.

WHEN TO USE:
- Stop a scheduled job that should no longer run
- Halt a queued batch after noticing a mistake in the audience or timing

EXAMPLE: {"batch_id": "batch_123"}

RELATED TOOLS:
- get_batch_call: confirm the current job status before cancelling
- list_batch_calls: find the correct batch_id
- submit_batch_call: create a corrected replacement batch if needed

RETURNS: batch_call.

FREE.`,
      inputSchema: z.object({
        batch_id: z.string().min(1).describe('Batch job ID to cancel.'),
      }),
      annotations: {
        readOnlyHint: false,
        // Cancelling terminates queued/scheduled production calls and cannot be
        // undone — recovery means submitting a new batch.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.batchCallCancel(args.batch_id),
        { method: 'POST' },
      );
      const batchCall = sanitizeBatchCall(
        unwrapBatchCallPayload(result),
        'elevenlabs-agents:cancel_batch_call',
      );
      return JSON.stringify({
        ok: true,
        batch_id: batchIdFromSanitized(batchCall) ?? args.batch_id,
        batch_call: batchCall,
        message: `Batch call ${args.batch_id} cancelled successfully.`,
      });
    }),
  );

  server.registerTool(
    'retry_batch_call',
    {
      description: `Retry a previously submitted batch-call job.

WHEN TO USE:
- Re-run a batch after fixing quota, provider, or recipient issues
- Create a fresh retry pass for failed or partial recipients

EXAMPLE: {"batch_id": "batch_123"}

RELATED TOOLS:
- get_batch_call: inspect which recipients failed before retrying
- list_batch_calls: find the correct batch_id
- submit_batch_call: create a new batch instead when you need a different audience or schedule

RETURNS: batch_call.

COST: Uses ElevenLabs telephony/call minutes when the retried recipients are dialed.`,
      inputSchema: z.object({
        batch_id: z.string().min(1).describe('Batch job ID to retry.'),
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
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.batchCallRetry(args.batch_id),
        { method: 'POST' },
      );
      const batchCall = sanitizeBatchCall(
        unwrapBatchCallPayload(result),
        'elevenlabs-agents:retry_batch_call',
      );
      return JSON.stringify({
        ok: true,
        batch_id: batchIdFromSanitized(batchCall) ?? args.batch_id,
        batch_call: batchCall,
        message: `Batch call ${args.batch_id} retried successfully.`,
      });
    }),
  );
}
