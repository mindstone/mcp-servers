/**
 * Receipts for the tools that place real phone calls, and the conversation list the
 * assistant uses to check whether an earlier call went through.
 *
 * Each reply is parsed with Zod before the tool reports success. A reply this module
 * cannot read arrives after the request was sent, so it never becomes "submitted":
 * the tool says the call may or may not have been placed and how to check.
 */

import { z } from 'zod';
import { ElevenLabsError } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

export type CallTool = 'make_outbound_call' | 'submit_batch_call' | 'retry_batch_call';

const CHECK_BEFORE_CALLING_AGAIN: Record<CallTool, string> = {
  make_outbound_call:
    'check list_conversations (filtered by agent_id) for this call',
  submit_batch_call:
    'check list_batch_calls, then get_batch_call, for this batch',
  retry_batch_call:
    'check get_batch_call for this batch',
};

function unclearResultResolution(tool: CallTool): string {
  return `The request may have reached ElevenLabs, so the call may already have been placed. `
    + `Do not just retry: ${CHECK_BEFORE_CALLING_AGAIN[tool]}, tell the user what you found. `
    + `An empty or unclear check does not prove no call was made.`;
}

/** Twilio and SIP-trunk outbound-call replies: `{ success, message, conversation_id, callSid | sip_call_id }`. */
const outboundCallReceiptSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});

/**
 * Batch job statuses that mean no call will be placed from this request. ElevenLabs
 * documents `pending`, `in_progress`, `completed`, `failed` and `cancelled` on the
 * submit and retry replies; `failed` and `cancelled` are terminal and not a success.
 * Any other status (including ones added later) is left to the batch's own reporting.
 */
const FAILED_BATCH_STATUSES: ReadonlySet<string> = new Set(['failed', 'cancelled']);

/**
 * Batch submit/retry reply: the batch job (`id`, `status`, ...), possibly under `batch_call`.
 * The API sends no `success` flag on success; one that says `false`, or a `failed` or
 * `cancelled` status, is a refusal.
 */
const batchCallReceiptSchema = z.object({
  id: z.string().min(1).optional(),
  batch_id: z.string().min(1).optional(),
  status: z.string().optional(),
  success: z.boolean().optional(),
  message: z.string().optional(),
}).refine(
  (receipt) => receipt.success === false || receipt.id !== undefined || receipt.batch_id !== undefined,
);

const listOfItems = z.array(z.unknown());

/** Where a conversation list reply may carry its items: a bare array, or one of these keys. */
const conversationListSchema = z.union([
  listOfItems,
  z.object({ conversations: listOfItems }).transform((reply) => reply.conversations),
  z.object({ items: listOfItems }).transform((reply) => reply.items),
  z.object({ data: listOfItems }).transform((reply) => reply.data),
]);

function unclearReceipt(tool: CallTool): ElevenLabsError {
  return new ElevenLabsError(
    'ElevenLabs sent back a reply this tool could not read, so the call may or may not have been placed.',
    'UNCONFIRMED_CALL_RESULT',
    unclearResultResolution(tool),
  );
}

function vendorRefusal(
  tool: CallTool,
  message: string | undefined,
  lead = 'ElevenLabs reported that the call request failed',
): ElevenLabsError {
  const detail = message ? `: ${wrapUntrusted(message, `elevenlabs-agents:${tool}:message`)}` : '.';
  return new ElevenLabsError(
    `${lead}${detail}`,
    'CALL_FAILED',
    'Tell the user what ElevenLabs said.',
  );
}

/** Parse a Twilio/SIP-trunk outbound-call receipt; throws unless ElevenLabs says it succeeded. */
export function parseOutboundCallReceipt(result: unknown): void {
  const parsed = outboundCallReceiptSchema.safeParse(result);
  if (!parsed.success) throw unclearReceipt('make_outbound_call');
  if (!parsed.data.success) throw vendorRefusal('make_outbound_call', parsed.data.message);
}

/** Parse a batch submit/retry receipt (already unwrapped from `batch_call`). */
export function parseBatchCallReceipt(tool: 'submit_batch_call' | 'retry_batch_call', result: unknown): void {
  const parsed = batchCallReceiptSchema.safeParse(result);
  if (!parsed.success) throw unclearReceipt(tool);
  if (parsed.data.success === false) throw vendorRefusal(tool, parsed.data.message);
  const status = parsed.data.status?.toLowerCase();
  if (status !== undefined && FAILED_BATCH_STATUSES.has(status)) {
    throw vendorRefusal(tool, parsed.data.message, `ElevenLabs reported the batch as ${status}`);
  }
}

/** The conversation items in a list reply; an unexpected shape is an error, never "0 conversations". */
export function parseConversationList(result: unknown): unknown[] {
  const parsed = conversationListSchema.safeParse(result);
  if (!parsed.success) {
    throw new ElevenLabsError(
      'ElevenLabs returned the conversation list in an unexpected shape, so this tool cannot tell which conversations exist.',
      'INVALID_RESPONSE',
      'Do not read this as "no conversations". Try list_conversations again shortly; if checking for an earlier call, tell the user the check was unclear.',
    );
  }
  return parsed.data;
}

function mayHaveReachedElevenLabs(error: ElevenLabsError): boolean {
  return error.code === 'TIMEOUT'
    || error.code === 'INVALID_RESPONSE'
    || /^HTTP_5\d\d$/.test(error.code);
}

/**
 * Send a call-placing request. A timeout, a 5xx, an unreadable body or a dropped
 * connection may come after ElevenLabs placed the call, so those errors carry a
 * check-first resolution instead of the shared client's "try again".
 */
export async function sendCallRequest<T>(tool: CallTool, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (error instanceof ElevenLabsError) {
      if (!mayHaveReachedElevenLabs(error)) throw error;
      throw new ElevenLabsError(error.message, error.code, unclearResultResolution(tool));
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ElevenLabsError(
      `The call request did not complete: ${message}`,
      'REQUEST_FAILED',
      unclearResultResolution(tool),
    );
  }
}
