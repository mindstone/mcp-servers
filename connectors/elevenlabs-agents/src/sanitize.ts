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

// Agent and knowledge-base responses are fail-safe by default for the same reason
// conversations are: every string a workspace collaborator can author is a prompt-injection
// surface, and the ElevenLabs response models keep growing new ones — `documents[].
// dependent_agents[].name` and `agents[].access_info.creator_name` were both added upstream
// after this connector's allowlist was written. No key-specific exception is carried here;
// only the shared structural predicate (ids/`*_id`, `role`/`type`/`status`/`timestamp`,
// phone numbers) keeps a string literal.
const AGENT_AND_KB_LITERAL_STRING_KEYS = new Set<string>();

/** No key at all -> no structural exemption can apply. Used for non-object response roots. */
const NO_LITERAL_STRING_KEYS = new Set<string>();

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
    if (CONVERSATION_JSON_STRING_KEYS.has(childKey)) {
      out[childKey] = wrapUntrustedJsonStrings(childValue, `${source}:${childKey}`);
      continue;
    }
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

function sanitizeAgentOrKbValue(value: unknown, source: string, key?: string): unknown {
  return sanitizeStringsByDefault(value, source, key, AGENT_AND_KB_LITERAL_STRING_KEYS);
}

/**
 * Every exported sanitizer must decide what to do with a **non-object root**. An
 * HTTP-200 body that is a bare JSON scalar (`"XINJECTX SYSTEM: …"`) or a bare array
 * parses fine in `elevenLabsJson`, so an entry point that returns non-objects
 * unchanged hands raw third-party bytes straight to the model — the object-shaped
 * deny-by-default walk never runs. Never `return value` from that branch.
 *
 * Root arrays re-enter the caller's own sanitizer per item so its structural work
 * (ID remapping, knowledge-base body truncation) still happens; everything else goes
 * through the deny-by-default walk with no key, where no structural exemption can
 * apply. Non-strings (numbers, booleans, `null`) pass through the walk unchanged.
 */
function sanitizeNonObjectRoot(
  value: unknown,
  source: string,
  itemSanitizer: (item: unknown, source: string) => unknown,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => itemSanitizer(item, `${source}[${index}]`));
  }
  return sanitizeStringsByDefault(value, source, undefined, NO_LITERAL_STRING_KEYS);
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
  if (!isObj(agent)) return sanitizeNonObjectRoot(agent, source, sanitizeAgentSummary);
  return sanitizeAgentOrKbValue(agent, source);
}

/**
 * Full agent config. The deny-by-default walk already recurses into
 * `conversation_config` / `platform_settings` and routes `metadata` /
 * `dynamic_variables` through `wrapUntrustedJsonStrings`, so the full-config
 * response needs nothing beyond the summary walk.
 */
export function sanitizeAgent(agent: unknown, source: string): unknown {
  if (!isObj(agent)) return sanitizeNonObjectRoot(agent, source, sanitizeAgent);
  return sanitizeAgentOrKbValue(agent, source);
}

/**
 * No non-object-root guard needed: `sanitizeConversationValue` *is* the
 * deny-by-default walk, which already handles scalar, array, and object roots.
 */
export function sanitizeConversation(conversation: unknown, source: string): unknown {
  return sanitizeConversationValue(conversation, source);
}

/**
 * `simulated_conversation` gets the stricter transcript-turn walk; every *other*
 * top-level key — including ones this connector does not surface today — goes
 * through the deny-by-default simulation walk rather than being copied raw, so a
 * new upstream prose field cannot ship unenveloped if a caller ever returns more
 * of this object than `simulated_conversation` + `analysis`.
 */
export function sanitizeSimulation(result: unknown, source: string): unknown {
  if (!isObj(result)) return sanitizeNonObjectRoot(result, source, sanitizeSimulation);

  const out: Obj = {};
  for (const [key, value] of Object.entries(result)) {
    out[key] = key === 'simulated_conversation'
      ? sanitizeTranscriptTurns(value, `${source}:${key}`)
      : sanitizeSimulationAnalysisValue(value, `${source}:${key}`, key);
  }
  return out;
}

/** Same as `sanitizeConversation`: the walk itself covers every root shape. */
export function sanitizePhoneNumber(phoneNumber: unknown, source: string): unknown {
  return sanitizeConversationValue(phoneNumber, source);
}

export function sanitizeOutboundCall(call: unknown, source: string): unknown {
  if (!isObj(call)) return sanitizeNonObjectRoot(call, source, sanitizeOutboundCall);
  return sanitizeNestedText(call, source);
}

export function sanitizeBatchCall(batchCall: unknown, source: string): unknown {
  if (!isObj(batchCall)) return sanitizeNonObjectRoot(batchCall, source, sanitizeBatchCall);
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

/**
 * Body-bearing fields are enveloped outside the deny-by-default walk because they
 * must be byte-truncated *before* wrapping and carry sidecar truncation metadata.
 * A non-string value here (upstream shape drift) falls back to the same
 * deny-by-default walk rather than passing through raw.
 */
function sanitizeKbBodyField(out: Obj, field: string, raw: unknown, source: string): void {
  if (typeof raw !== 'string') {
    out[field] = sanitizeAgentOrKbValue(raw, `${source}:${field}`, field);
    return;
  }
  const { text, truncated, originalBytes } = truncateUtf8(raw, KB_CONTENT_LIMIT_BYTES);
  out[field] = wrapUntrusted(text, `${source}:${field}`);
  out[`${field}_truncated`] = truncated;
  out[`${field}_original_bytes`] = originalBytes;
  out[`${field}_returned_bytes`] = Buffer.byteLength(text, 'utf8');
}

export function sanitizeKbDoc(doc: unknown, source: string): unknown {
  if (!isObj(doc)) return sanitizeNonObjectRoot(doc, source, sanitizeKbDoc);
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

  const bodyFields = new Map<string, unknown>();
  for (const field of [...KB_METADATA_BODY_FIELDS, 'content']) {
    if (field in out) {
      bodyFields.set(field, out[field]);
      delete out[field];
    }
  }

  const sanitized = sanitizeAgentOrKbValue(out, source) as Obj;

  for (const [field, raw] of bodyFields) {
    sanitizeKbBodyField(sanitized, field, raw, source);
  }

  return sanitized;
}

/**
 * Not a surface sanitizer: it fans an already-extracted array out to one. A
 * non-array root collapses to `[]` (fail-closed, nothing reaches the model), and
 * every element — including a bare hostile string — goes through `sanitizer`,
 * whose own non-object-root branch envelopes it.
 */
export function sanitizeList<T>(
  items: unknown,
  sanitizer: (item: unknown, source: string) => unknown,
  source: string,
): T[] {
  return Array.isArray(items)
    ? items.map((item) => sanitizer(item, source)) as T[]
    : [];
}
