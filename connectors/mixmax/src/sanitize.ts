/**
 * Envelope-wrapping for every external-text field Mixmax returns to the LLM
 * (AGENTS.md security invariant #6, FOX-3490).
 *
 * Tool handlers pass Mixmax API objects through to the model. This module is
 * the single, auditable place that enumerates which fields of each resource
 * are third-party-authored text (subjects, bodies, names, addresses) and wraps
 * them with `wrapUntrusted`. Fields not listed here (IDs, timestamps, booleans,
 * counters) are structural and pass through untouched.
 */
import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

const SOURCE = 'mixmax';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function wrapField(obj: Obj, key: string, source: string): void {
  const v = obj[key];
  if (typeof v === 'string') obj[key] = wrapUntrusted(v, source);
}

function wrapAddress(v: unknown, source: string): unknown {
  if (!isObj(v)) return v;
  const out: Obj = { ...v };
  wrapField(out, 'email', `${source}.email`);
  wrapField(out, 'name', `${source}.name`);
  return out;
}

function wrapAddressList(v: unknown, source: string): unknown {
  return Array.isArray(v) ? v.map((a) => wrapAddress(a, source)) : v;
}

/** Wrap the free-text fields of a message (subject, body, addresses). */
export function sanitizeMessage(message: unknown): unknown {
  if (!isObj(message)) return message;
  const out: Obj = { ...message };
  wrapField(out, 'subject', `${SOURCE}:message.subject`);
  wrapField(out, 'body', `${SOURCE}:message.body`);
  if (out.from !== undefined) out.from = wrapAddress(out.from, `${SOURCE}:message.from`);
  for (const key of ['to', 'cc', 'bcc']) {
    if (out[key] !== undefined) out[key] = wrapAddressList(out[key], `${SOURCE}:message.${key}`);
  }
  return out;
}

export function sanitizeMessages(messages: unknown): unknown {
  return Array.isArray(messages) ? messages.map(sanitizeMessage) : messages;
}

/** Wrap the free-text fields of a snippet (template). */
export function sanitizeSnippet(snippet: unknown): unknown {
  if (!isObj(snippet)) return snippet;
  const out: Obj = { ...snippet };
  wrapField(out, 'name', `${SOURCE}:snippet.name`);
  wrapField(out, 'title', `${SOURCE}:snippet.title`);
  wrapField(out, 'subject', `${SOURCE}:snippet.subject`);
  wrapField(out, 'body', `${SOURCE}:snippet.body`);
  return out;
}

export function sanitizeSnippets(snippets: unknown): unknown {
  return Array.isArray(snippets) ? snippets.map(sanitizeSnippet) : snippets;
}

/** Wrap the free-text fields of a sequence, including expanded stage content. */
export function sanitizeSequence(sequence: unknown): unknown {
  if (!isObj(sequence)) return sequence;
  const out: Obj = { ...sequence };
  wrapField(out, 'name', `${SOURCE}:sequence.name`);
  if (Array.isArray(out.stages)) {
    out.stages = out.stages.map((stage) => {
      if (!isObj(stage)) return stage;
      const s: Obj = { ...stage };
      wrapField(s, 'subject', `${SOURCE}:sequence.stages.subject`);
      wrapField(s, 'body', `${SOURCE}:sequence.stages.body`);
      return s;
    });
  }
  return out;
}

export function sanitizeSequences(sequences: unknown): unknown {
  return Array.isArray(sequences) ? sequences.map(sanitizeSequence) : sequences;
}

/** Wrap the free-text fields of a meeting type. */
export function sanitizeMeetingType(meetingType: unknown): unknown {
  if (!isObj(meetingType)) return meetingType;
  const out: Obj = { ...meetingType };
  wrapField(out, 'name', `${SOURCE}:meetingtype.name`);
  return out;
}

export function sanitizeMeetingTypes(meetingTypes: unknown): unknown {
  return Array.isArray(meetingTypes) ? meetingTypes.map(sanitizeMeetingType) : meetingTypes;
}

/** Wrap the free-text fields of the user profile. */
export function sanitizeUser(user: unknown): unknown {
  if (!isObj(user)) return user;
  const out: Obj = { ...user };
  wrapField(out, 'name', `${SOURCE}:user.name`);
  wrapField(out, 'email', `${SOURCE}:user.email`);
  return out;
}

/**
 * Report buckets are flexible aggregation rows whose shape depends on the
 * report type; nearly every string leaf (sequence names, subjects, owner
 * names, recipient addresses) is external text, so wrap them all.
 */
export function sanitizeReportBuckets(buckets: unknown): unknown {
  return Array.isArray(buckets)
    ? buckets.map((bucket) => wrapUntrustedJsonStrings(bucket, `${SOURCE}:report.bucket`))
    : buckets;
}
