/**
 * Envelope-wrapping for every external-text field the ElevenLabs
 * Conversational AI API returns to the LLM.
 *
 * Conversations are the security-critical core: a phone caller can dictate a
 * prompt injection into the transcript and transcript-turn content. This file
 * is the single auditable map from API field to `<untrusted-content>` wrapper.
 */
import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

type Obj = Record<string, unknown>;

const KB_CONTENT_LIMIT_BYTES = 50_000;
const NESTED_TEXT_KEYS = new Set([
  'name',
  'call_name',
  'label',
  'prompt',
  'system_prompt',
  'first_message',
  'description',
  'summary',
  'text',
  'message',
  'error_message',
  'content',
  'title',
  'instructions',
  'reason',
  'value',
]);

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wrapStr(value: unknown, source: string): unknown {
  return typeof value === 'string' ? wrapUntrusted(value, source) : value;
}

// Keep only structural string fields literal; everything else in transcript turns
// is attacker-controlled phone-call content and must be enveloped recursively.
const TRANSCRIPT_TURN_LITERAL_STRING_KEYS = new Set([
  'role',
  'id',
  'type',
  'status',
  'timestamp',
]);

function sanitizeTranscriptTurnValue(value: unknown, source: string, key?: string): unknown {
  if (typeof value === 'string') {
    return key && TRANSCRIPT_TURN_LITERAL_STRING_KEYS.has(key) ? value : wrapUntrusted(value, source);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeTranscriptTurnValue(item, `${source}[${index}]`));
  }
  if (!isObj(value)) return value;

  const out: Obj = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = sanitizeTranscriptTurnValue(childValue, `${source}:${childKey}`, childKey);
  }
  return out;
}

function sanitizeNestedText(value: unknown, source: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeNestedText(item, `${source}[${index}]`));
  }
  if (!isObj(value)) return value;

  const out: Obj = { ...value };
  for (const [key, child] of Object.entries(out)) {
    if (typeof child === 'string' && NESTED_TEXT_KEYS.has(key)) {
      out[key] = wrapUntrusted(child, `${source}:${key}`);
      continue;
    }
    if (key === 'dynamic_variables' || key === 'analysis' || key === 'summary' || key === 'metadata') {
      out[key] = wrapUntrustedJsonStrings(child, `${source}:${key}`);
      continue;
    }
    if (Array.isArray(child) || isObj(child)) {
      out[key] = sanitizeNestedText(child, `${source}:${key}`);
    }
  }
  return out;
}

function sanitizeTranscriptTurns(turns: unknown, source: string): unknown {
  if (!Array.isArray(turns)) return turns;
  return turns.map((turn, index) => sanitizeTranscriptTurnValue(turn, `${source}[${index}]`));
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; originalBytes: number } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return { text, truncated: false, originalBytes: buffer.length };
  }
  return {
    text: buffer.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
    originalBytes: buffer.length,
  };
}

export function sanitizeAgentSummary(agent: unknown, source: string): unknown {
  if (!isObj(agent)) return agent;
  const out = sanitizeNestedText(agent, source);
  const agentObj = isObj(out) ? out : agent;
  return {
    ...agentObj,
    name: wrapStr(agentObj.name, `${source}:name`),
    prompt: wrapStr(agentObj.prompt, `${source}:prompt`),
    system_prompt: wrapStr(agentObj.system_prompt, `${source}:system_prompt`),
    first_message: wrapStr(agentObj.first_message, `${source}:first_message`),
  };
}

export function sanitizeAgent(agent: unknown, source: string): unknown {
  if (!isObj(agent)) return agent;
  const base = sanitizeAgentSummary(agent, source);
  const out = isObj(base) ? { ...base } : { ...agent };

  if (isObj(out.conversation_config)) {
    out.conversation_config = sanitizeNestedText(out.conversation_config, `${source}:conversation_config`);
  }
  if (isObj(out.platform_settings)) {
    out.platform_settings = sanitizeNestedText(out.platform_settings, `${source}:platform_settings`);
  }
  if (isObj(out.metadata)) {
    out.metadata = wrapUntrustedJsonStrings(out.metadata, `${source}:metadata`);
  }

  return out;
}

export function sanitizeConversation(conversation: unknown, source: string): unknown {
  if (!isObj(conversation)) return conversation;
  const out: Obj = { ...conversation };

  out.summary = wrapStr(out.summary, `${source}:summary`);
  out.transcript = wrapStr(out.transcript, `${source}:transcript`);
  out.analysis = wrapUntrustedJsonStrings(out.analysis, `${source}:analysis`);
  out.metadata = wrapUntrustedJsonStrings(out.metadata, `${source}:metadata`);
  out.dynamic_variables = wrapUntrustedJsonStrings(out.dynamic_variables, `${source}:dynamic_variables`);
  out.transcript_turns = sanitizeTranscriptTurns(out.transcript_turns, `${source}:transcript_turns`);
  out.transcript_messages = sanitizeTranscriptTurns(out.transcript_messages, `${source}:transcript_messages`);
  out.messages = sanitizeTranscriptTurns(out.messages, `${source}:messages`);
  out.turns = sanitizeTranscriptTurns(out.turns, `${source}:turns`);

  if (isObj(out.conversation_initiation_client_data)) {
    const clientData = { ...out.conversation_initiation_client_data };
    clientData.dynamic_variables = wrapUntrustedJsonStrings(
      clientData.dynamic_variables,
      `${source}:conversation_initiation_client_data.dynamic_variables`,
    );
    out.conversation_initiation_client_data = clientData;
  }

  return out;
}

export function sanitizePhoneNumber(phoneNumber: unknown, source: string): unknown {
  if (!isObj(phoneNumber)) return phoneNumber;
  const out: Obj = { ...phoneNumber };
  out.label = wrapStr(out.label, `${source}:label`);
  return out;
}

export function sanitizeOutboundCall(call: unknown, source: string): unknown {
  if (!isObj(call)) return call;
  return sanitizeNestedText(call, source);
}

export function sanitizeBatchCall(batchCall: unknown, source: string): unknown {
  if (!isObj(batchCall)) return batchCall;
  const sanitized = sanitizeNestedText(batchCall, source);
  const out = isObj(sanitized) ? { ...sanitized } : { ...batchCall };

  // List/get/submit responses use `id`; get/cancel/retry tools expect `batch_id`.
  const batchId =
    typeof out.batch_id === 'string'
      ? out.batch_id
      : typeof out.id === 'string'
        ? out.id
        : undefined;
  if (batchId !== undefined) {
    out.batch_id = batchId;
  }
  if ('id' in out) {
    delete out.id;
  }

  return out;
}

export function sanitizeKbDoc(doc: unknown, source: string): unknown {
  if (!isObj(doc)) return doc;
  const out: Obj = { ...doc };

  // List responses use `id`; get/delete tools expect `documentation_id`.
  const documentationId =
    typeof out.documentation_id === 'string'
      ? out.documentation_id
      : typeof out.id === 'string'
        ? out.id
        : undefined;
  if (documentationId !== undefined) {
    out.documentation_id = documentationId;
  }
  if ('id' in out) {
    delete out.id;
  }

  out.name = wrapStr(out.name, `${source}:name`);
  if (out.metadata !== undefined) {
    out.metadata = wrapUntrustedJsonStrings(out.metadata, `${source}:metadata`);
  }

  if (typeof out.content === 'string') {
    const { text, truncated, originalBytes } = truncateUtf8(out.content, KB_CONTENT_LIMIT_BYTES);
    out.content = wrapUntrusted(text, `${source}:content`);
    out.content_truncated = truncated;
    out.content_original_bytes = originalBytes;
    out.content_returned_bytes = Buffer.byteLength(text, 'utf8');
  }

  return out;
}

export function sanitizeList<T>(
  items: unknown,
  sanitizer: (item: unknown, source: string) => unknown,
  source: string,
): T[] {
  return Array.isArray(items)
    ? items.map((item) => sanitizer(item, source)) as T[]
    : [];
}
