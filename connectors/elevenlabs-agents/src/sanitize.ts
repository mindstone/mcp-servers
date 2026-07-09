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

/** Body-bearing string fields on GET /knowledge-base/{id} metadata (not the /content body). */
const KB_METADATA_BODY_FIELDS = ['extracted_inner_html'] as const;
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

const STRUCTURAL_LITERAL_STRING_KEYS = new Set([
  'role',
  'type',
  'status',
  'timestamp',
]);

const STRUCTURAL_LITERAL_STRING_COLLECTION_KEYS = new Set([
  'ids',
  'numbers',
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
  'agent_id',
  'branch_id',
  'workflow_node_id',
  'version_id',
  'request_id',
  'tool_name',
  'scope',
  'source_agent_id',
  'source_branch_id',
  'successful',
]);

// Simulation analysis mixes structural IDs/enums with freeform model-authored prose.
// Wrap by default so newly added prose fields are safe unless explicitly allowlisted.
const SIMULATION_ANALYSIS_LITERAL_STRING_KEYS = new Set([
  'criteria_id',
  'data_collection_id',
  'result',
]);

const CONVERSATION_JSON_STRING_KEYS = new Set([
  'analysis',
  'metadata',
  'dynamic_variables',
]);

const CONVERSATION_TRANSCRIPT_ARRAY_KEYS = new Set([
  'transcript_turns',
  'transcript_messages',
  'messages',
  'turns',
]);

const CONVERSATION_LITERAL_STRING_KEYS = new Set<string>();

function isStructuralLiteralStringKey(key?: string): boolean {
  if (!key) return false;
  return (
    STRUCTURAL_LITERAL_STRING_KEYS.has(key) ||
    key === 'id' ||
    key.endsWith('_id') ||
    key === 'phone_number' ||
    key.endsWith('_phone_number') ||
    key === 'to_number' ||
    key === 'from_number'
  );
}

function isStructuralLiteralStringCollectionKey(key?: string): boolean {
  if (!key) return false;
  return (
    STRUCTURAL_LITERAL_STRING_COLLECTION_KEYS.has(key) ||
    key.endsWith('_ids') ||
    key.endsWith('_numbers') ||
    key.endsWith('_phone_numbers')
  );
}

function sanitizeStringsByDefault(
  value: unknown,
  source: string,
  key: string | undefined,
  literalStringKeys: ReadonlySet<string>,
): unknown {
  if (typeof value === 'string') {
    return (isStructuralLiteralStringKey(key) || (key ? literalStringKeys.has(key) : false))
      ? value
      : wrapUntrusted(value, source);
  }
  if (Array.isArray(value)) {
    if (isStructuralLiteralStringCollectionKey(key) && value.every((item) => typeof item === 'string')) {
      return [...value];
    }
    return value.map((item, index) => sanitizeStringsByDefault(item, `${source}[${index}]`, undefined, literalStringKeys));
  }
  if (!isObj(value)) return value;

  const out: Obj = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = sanitizeStringsByDefault(childValue, `${source}:${childKey}`, childKey, literalStringKeys);
  }
  return out;
}

function sanitizeTranscriptTurnValue(value: unknown, source: string, key?: string): unknown {
  return sanitizeStringsByDefault(value, source, key, TRANSCRIPT_TURN_LITERAL_STRING_KEYS);
}

function sanitizeSimulationAnalysisValue(value: unknown, source: string, key?: string): unknown {
  return sanitizeStringsByDefault(value, source, key, SIMULATION_ANALYSIS_LITERAL_STRING_KEYS);
}

function sanitizeConversationValue(value: unknown, source: string, key?: string): unknown {
  if (key && CONVERSATION_TRANSCRIPT_ARRAY_KEYS.has(key)) {
    return sanitizeTranscriptTurns(value, source);
  }
  if (key && CONVERSATION_JSON_STRING_KEYS.has(key)) {
    return wrapUntrustedJsonStrings(value, source);
  }
  // Conversation and phone-number payloads are fail-safe by default: every
  // string is enveloped unless it is a narrow structural literal
  // (IDs/enums/status/timestamps/phone numbers) or a transcript-turn field
  // handled by the stricter transcript walker above.
  return sanitizeStringsByDefault(value, source, key, CONVERSATION_LITERAL_STRING_KEYS);
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
  return sanitizeConversationValue(conversation, source);
}

export function sanitizeSimulation(result: unknown, source: string): unknown {
  if (!isObj(result)) return result;
  const out: Obj = { ...result };

  out.simulated_conversation = sanitizeTranscriptTurns(
    out.simulated_conversation,
    `${source}:simulated_conversation`,
  );

  if (out.analysis !== undefined) {
    out.analysis = sanitizeSimulationAnalysisValue(out.analysis, `${source}:analysis`);
  }

  return out;
}

export function sanitizePhoneNumber(phoneNumber: unknown, source: string): unknown {
  return sanitizeConversationValue(phoneNumber, source);
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

function wrapKbBodyString(
  out: Obj,
  field: string,
  source: string,
  metadataPrefix: string,
): void {
  const raw = out[field];
  if (typeof raw !== 'string') return;
  const { text, truncated, originalBytes } = truncateUtf8(raw, KB_CONTENT_LIMIT_BYTES);
  out[field] = wrapUntrusted(text, `${source}:${field}`);
  out[`${metadataPrefix}_truncated`] = truncated;
  out[`${metadataPrefix}_original_bytes`] = originalBytes;
  out[`${metadataPrefix}_returned_bytes`] = Buffer.byteLength(text, 'utf8');
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

  for (const field of KB_METADATA_BODY_FIELDS) {
    wrapKbBodyString(out, field, source, field);
  }

  wrapKbBodyString(out, 'content', source, 'content');

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
