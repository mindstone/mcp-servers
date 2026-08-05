/**
 * Envelope-wrapping for every external-text field Retell returns to the LLM.
 *
 * Retell tool handlers return the raw Retell API object spread into JSON
 * (`{ ok: true, ...result }`), so the external-text fields are nested inside
 * those objects rather than passed individually. This module is the single,
 * auditable place that enumerates each such field and reaches `wrapUntrusted`
 * (AGENTS.md security invariant #6). Handlers call the matching `sanitize*`
 * helper instead of returning the raw object.
 *
 * Trust note: a call `transcript` is dictated by a phone caller — the most
 * attacker-controlled text in the catalog — so transcript / transcript_object
 * / call_analysis wrapping is the security-critical core of FOX-3490.
 *
 * Retell recording/log URLs are deliberately NOT enveloped: they are URLs, not
 * prose, and are surfaced for the user to open — not auto-followed by the
 * connector.
 */
import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function wrapStr(v: unknown, source: string): unknown {
  return typeof v === 'string' ? wrapUntrusted(v, source) : v;
}

function wrapJsonStrings(v: unknown, source: string): unknown {
  return wrapUntrustedJsonStrings(v, source);
}

function wrapArrayItems(v: unknown, source: string): unknown {
  return Array.isArray(v) ? v.map((item) => wrapStr(item, source)) : v;
}

function sanitizeTranscriptTurns(turns: unknown, field: string, source: string): unknown {
  if (!Array.isArray(turns)) return turns;
  return turns.map((turn) => {
    if (!isObj(turn)) return turn;
    const t: Obj = { ...turn };
    t.content = wrapStr(t.content, `${source}:${field}.content`);
    return t;
  });
}

/** Wrap the analysis text fields a phone caller can influence. */
function sanitizeCallAnalysis(analysis: unknown, source: string): unknown {
  if (!isObj(analysis)) return analysis;
  const out: Obj = { ...analysis };
  // Free-text fields the model summarised from the (caller-controlled) call.
  out.call_summary = wrapStr(out.call_summary, `${source}:call_analysis.call_summary`);
  out.custom_analysis_data = wrapJsonStrings(
    out.custom_analysis_data,
    `${source}:call_analysis.custom_analysis_data`,
  );
  return out;
}

/**
 * Wrap the external-text fields on a single Retell call object.
 */
export function sanitizeCall(call: unknown, source: string): unknown {
  if (!isObj(call)) return call;
  const out: Obj = { ...call };

  out.agent_name = wrapStr(out.agent_name, `${source}:agent_name`);
  out.transcript = wrapStr(out.transcript, `${source}:transcript`);
  out.transcript_object = sanitizeTranscriptTurns(out.transcript_object, 'transcript_object', source);
  out.transcript_with_tool_calls = sanitizeTranscriptTurns(
    out.transcript_with_tool_calls,
    'transcript_with_tool_calls',
    source,
  );
  out.scrubbed_transcript_with_tool_calls = sanitizeTranscriptTurns(
    out.scrubbed_transcript_with_tool_calls,
    'scrubbed_transcript_with_tool_calls',
    source,
  );
  out.call_analysis = sanitizeCallAnalysis(out.call_analysis, source);
  out.metadata = wrapJsonStrings(out.metadata, `${source}:metadata`);
  out.retell_llm_dynamic_variables = wrapJsonStrings(
    out.retell_llm_dynamic_variables,
    `${source}:retell_llm_dynamic_variables`,
  );
  out.collected_dynamic_variables = wrapJsonStrings(
    out.collected_dynamic_variables,
    `${source}:collected_dynamic_variables`,
  );
  out.custom_sip_headers = wrapJsonStrings(out.custom_sip_headers, `${source}:custom_sip_headers`);

  return out;
}

function sanitizeVoicemailOption(option: unknown, source: string): unknown {
  if (!isObj(option)) return option;
  const out: Obj = { ...option };
  if (isObj(out.action)) {
    out.action = {
      ...out.action,
      text: wrapStr(out.action.text, `${source}:voicemail_option.action.text`),
    };
  }
  return out;
}

function sanitizeCallScreeningOption(option: unknown, source: string): unknown {
  if (!isObj(option)) return option;
  return {
    ...option,
    agent_identity: wrapStr(option.agent_identity, `${source}:call_screening_option.agent_identity`),
    call_purpose: wrapStr(option.call_purpose, `${source}:call_screening_option.call_purpose`),
  };
}

function sanitizePronunciationDictionary(items: unknown, source: string): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!isObj(item)) return item;
    return {
      ...item,
      word: wrapStr(item.word, `${source}:pronunciation_dictionary.word`),
      phoneme: wrapStr(item.phoneme, `${source}:pronunciation_dictionary.phoneme`),
    };
  });
}

function sanitizePostCallAnalysisData(items: unknown, source: string): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!isObj(item)) return item;
    return {
      ...item,
      description: wrapStr(item.description, `${source}:post_call_analysis_data.description`),
      examples: wrapArrayItems(item.examples, `${source}:post_call_analysis_data.examples`),
      conditional_prompt: wrapStr(
        item.conditional_prompt,
        `${source}:post_call_analysis_data.conditional_prompt`,
      ),
    };
  });
}

/** Wrap external-text fields on an agent object (`agent_name`). */
export function sanitizeAgent(agent: unknown, source: string): unknown {
  if (!isObj(agent)) return agent;
  return {
    ...agent,
    agent_name: wrapStr(agent.agent_name, `${source}:agent_name`),
    version_description: wrapStr(agent.version_description, `${source}:version_description`),
    assigned_tags: wrapArrayItems(agent.assigned_tags, `${source}:assigned_tags`),
    // POST /v2/list-agents summary items carry these extra display fields.
    voice_name: wrapStr(agent.voice_name, `${source}:voice_name`),
    tags: wrapJsonStrings(agent.tags, `${source}:tags`),
    backchannel_words: wrapArrayItems(agent.backchannel_words, `${source}:backchannel_words`),
    boosted_keywords: wrapArrayItems(agent.boosted_keywords, `${source}:boosted_keywords`),
    pronunciation_dictionary: sanitizePronunciationDictionary(agent.pronunciation_dictionary, source),
    voicemail_message: wrapStr(agent.voicemail_message, `${source}:voicemail_message`),
    voicemail_option: sanitizeVoicemailOption(agent.voicemail_option, source),
    call_screening_option: sanitizeCallScreeningOption(agent.call_screening_option, source),
    post_call_analysis_data: sanitizePostCallAnalysisData(agent.post_call_analysis_data, source),
    analysis_successful_prompt: wrapStr(
      agent.analysis_successful_prompt,
      `${source}:analysis_successful_prompt`,
    ),
    analysis_summary_prompt: wrapStr(agent.analysis_summary_prompt, `${source}:analysis_summary_prompt`),
    analysis_user_sentiment_prompt: wrapStr(
      agent.analysis_user_sentiment_prompt,
      `${source}:analysis_user_sentiment_prompt`,
    ),
  };
}

function sanitizeToolDescriptions(tools: unknown, source: string): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!isObj(tool)) return tool;
    return {
      ...tool,
      description: wrapStr(tool.description, source),
    };
  });
}

function sanitizeStateEdges(edges: unknown, source: string): unknown {
  if (!Array.isArray(edges)) return edges;
  return edges.map((edge) => {
    if (!isObj(edge)) return edge;
    return {
      ...edge,
      description: wrapStr(edge.description, source),
    };
  });
}

function sanitizeStates(states: unknown, source: string): unknown {
  if (!Array.isArray(states)) return states;
  return states.map((state) => {
    if (!isObj(state)) return state;
    return {
      ...state,
      state_prompt: wrapStr(state.state_prompt, `${source}:states.state_prompt`),
      edges: sanitizeStateEdges(state.edges, `${source}:states.edges.description`),
      tools: sanitizeToolDescriptions(state.tools, `${source}:states.tools.description`),
    };
  });
}

/** Wrap external-text fields on a Retell LLM object (`general_prompt`, `begin_message`). */
export function sanitizeLlm(llm: unknown, source: string): unknown {
  if (!isObj(llm)) return llm;
  return {
    ...llm,
    general_prompt: wrapStr(llm.general_prompt, `${source}:general_prompt`),
    begin_message: wrapStr(llm.begin_message, `${source}:begin_message`),
    general_tools: sanitizeToolDescriptions(llm.general_tools, `${source}:general_tools.description`),
    states: sanitizeStates(llm.states, source),
    default_dynamic_variables: wrapJsonStrings(
      llm.default_dynamic_variables,
      `${source}:default_dynamic_variables`,
    ),
  };
}

/** Wrap external-text fields on a voice object (`voice_name`, `name`). */
export function sanitizeVoice(voice: unknown, source: string): unknown {
  if (!isObj(voice)) return voice;
  return {
    ...voice,
    voice_name: wrapStr(voice.voice_name, `${source}:voice_name`),
    name: wrapStr(voice.name, `${source}:name`),
  };
}

/** Wrap external-text fields on a phone-number object (`nickname`). */
export function sanitizePhoneNumber(num: unknown, source: string): unknown {
  if (!isObj(num)) return num;
  return { ...num, nickname: wrapStr(num.nickname, `${source}:nickname`) };
}

/** Wrap the analysis text fields a chat user can influence. */
function sanitizeChatAnalysis(analysis: unknown, source: string): unknown {
  if (!isObj(analysis)) return analysis;
  const out: Obj = { ...analysis };
  out.chat_summary = wrapStr(out.chat_summary, `${source}:chat_analysis.chat_summary`);
  out.custom_analysis_data = wrapJsonStrings(
    out.custom_analysis_data,
    `${source}:chat_analysis.custom_analysis_data`,
  );
  return out;
}

/**
 * Wrap the external-text fields on a Retell chat object. A chat `transcript`
 * is written by the end user chatting with the agent — the same trust level
 * as a phone caller — so transcript / message content / chat analysis get the
 * same envelope treatment as call objects.
 */
export function sanitizeChat(chat: unknown, source: string): unknown {
  if (!isObj(chat)) return chat;
  const out: Obj = { ...chat };

  out.agent_name = wrapStr(out.agent_name, `${source}:agent_name`);
  out.transcript = wrapStr(out.transcript, `${source}:transcript`);
  out.message_with_tool_calls = sanitizeTranscriptTurns(
    out.message_with_tool_calls,
    'message_with_tool_calls',
    source,
  );
  out.chat_analysis = sanitizeChatAnalysis(out.chat_analysis, source);
  out.metadata = wrapJsonStrings(out.metadata, `${source}:metadata`);
  out.retell_llm_dynamic_variables = wrapJsonStrings(
    out.retell_llm_dynamic_variables,
    `${source}:retell_llm_dynamic_variables`,
  );
  out.collected_dynamic_variables = wrapJsonStrings(
    out.collected_dynamic_variables,
    `${source}:collected_dynamic_variables`,
  );
  out.custom_attributes = wrapJsonStrings(out.custom_attributes, `${source}:custom_attributes`);

  return out;
}

/** Wrap external-text fields on a batch-call object (`name`). */
export function sanitizeBatchCall(batch: unknown, source: string): unknown {
  if (!isObj(batch)) return batch;
  return { ...batch, name: wrapStr(batch.name, `${source}:name`) };
}

function sanitizeKnowledgeBaseSources(sources: unknown, source: string): unknown {
  if (!Array.isArray(sources)) return sources;
  return sources.map((item) => {
    if (!isObj(item)) return item;
    return {
      ...item,
      filename: wrapStr(item.filename, `${source}:knowledge_base_sources.filename`),
      title: wrapStr(item.title, `${source}:knowledge_base_sources.title`),
    };
  });
}

/**
 * Wrap external-text fields on a knowledge-base object (`knowledge_base_name`,
 * source `filename`/`title`). Source URLs (`url`, `file_url`, `content_url`)
 * are deliberately NOT enveloped: they are URLs surfaced for the user, not
 * prose (same rationale as call recording URLs).
 */
export function sanitizeKnowledgeBase(kb: unknown, source: string): unknown {
  if (!isObj(kb)) return kb;
  return {
    ...kb,
    knowledge_base_name: wrapStr(kb.knowledge_base_name, `${source}:knowledge_base_name`),
    knowledge_base_sources: sanitizeKnowledgeBaseSources(kb.knowledge_base_sources, source),
  };
}

/**
 * Wrap external-text fields on an agent-version item returned by
 * get_agent_versions. `version_description`/`description` are user-authored
 * (publish_agent writes version_description), so they are untrusted prose.
 */
export function sanitizeAgentVersion(version: unknown, source: string): unknown {
  if (!isObj(version)) return version;
  // A get_agent_versions item is a FULL agent-version object — the same shape
  // sanitizeAgent covers (agent_name, voicemail, pronunciation, post-call
  // analysis prompts, …) PLUS the version-only description fields. Compose the
  // full agent sanitizer, then wrap the version-only prose.
  const agentSanitized = sanitizeAgent(version, source);
  const base = isObj(agentSanitized) ? agentSanitized : version;
  return {
    ...base,
    version_description: wrapStr(base.version_description, `${source}:version_description`),
    description: wrapStr(base.description, `${source}:description`),
  };
}

/** Map a sanitizer over an array, passing non-arrays through unchanged. */
export function sanitizeList(
  items: unknown,
  fn: (item: unknown, source: string) => unknown,
  source: string,
): unknown {
  return Array.isArray(items) ? items.map((it) => fn(it, source)) : items;
}
