/**
 * Envelope-wrapping for every external-text field Browserbase returns to the
 * LLM (AGENTS.md security invariant #6).
 *
 * Browserbase tool handlers return the API object spread into JSON; the
 * external-text fields are nested inside those objects rather than passed
 * individually. This module is the single, auditable place that enumerates
 * each such field and reaches `wrapUntrusted` (single strings) or the local
 * `wrapJsonValues` (structured blobs, values wrapped/keys raw).
 * Handlers call the matching `sanitize*` helper instead of returning the raw
 * object.
 *
 * Connector-generated values (ids, timestamps, counts, statuses, signed CDN
 * URLs, connect/debugger URLs minted by Browserbase) are deliberately NOT
 * enveloped. Web-derived URLs that a visited page controls (debug page
 * url/title/faviconUrl, replay page urls, download filenames) ARE enveloped.
 */
import { wrapUntrusted } from './untrusted-content.js';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function wrapStr(v: unknown, source: string): unknown {
  return typeof v === 'string' ? wrapUntrusted(v, source) : v;
}

/**
 * Recursively wrap every string VALUE inside `value`, leaving object KEYS
 * raw. Use for structured JSON blobs (metadata, results, headers, schemas)
 * where the LLM must still navigate the object shape — wrapping keys (as
 * wrapUntrustedJsonStrings does) would make the data unusable.
 */
function wrapJsonValues(v: unknown, source: string): unknown {
  if (typeof v === 'string') return wrapUntrusted(v, source);
  if (Array.isArray(v)) return v.map((item) => wrapJsonValues(item, source));
  if (isObj(v)) {
    return Object.fromEntries(
      Object.entries(v).map(([key, item]) => [key, wrapJsonValues(item, source)]),
    );
  }
  return v;
}

/**
 * Cap an oversized rawBody at `max` characters with an explicit truncation
 * note. CDP log raw bodies can be megabytes; returning them whole would flood
 * the model context. The note is connector-authored (trusted), the content is
 * wrapped by the caller.
 */
export function truncateWithNote(text: string, max = 4096): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated — showing ${max} of ${text.length} characters]`;
}

function wrapTruncated(v: unknown, source: string): unknown {
  return typeof v === 'string' ? wrapUntrusted(truncateWithNote(v), source) : v;
}

/** Project: `name` is user-authored in the Browserbase dashboard. */
export function sanitizeProject(project: unknown, source: string): unknown {
  if (!isObj(project)) return project;
  const out: Obj = { ...project };
  out.name = wrapStr(out.name, `${source}:project.name`);
  return out;
}

/** Session: `userMetadata` is arbitrary caller-supplied JSON echoed back. */
export function sanitizeSession(session: unknown, source: string): unknown {
  if (!isObj(session)) return session;
  const out: Obj = { ...session };
  out.userMetadata = wrapJsonValues(out.userMetadata, `${source}:session.userMetadata`);
  return out;
}

/** Context: `name` is user-authored. */
export function sanitizeContext(context: unknown, source: string): unknown {
  if (!isObj(context)) return context;
  const out: Obj = { ...context };
  out.name = wrapStr(out.name, `${source}:context.name`);
  return out;
}

/** Agent: `name` and `systemPrompt` are user-authored; `resultSchema` is
 * user-authored JSON whose string values (titles, descriptions, enums) are
 * free text. */
export function sanitizeAgent(agent: unknown, source: string): unknown {
  if (!isObj(agent)) return agent;
  const out: Obj = { ...agent };
  out.name = wrapStr(out.name, `${source}:agent.name`);
  out.systemPrompt = wrapStr(out.systemPrompt, `${source}:agent.systemPrompt`);
  out.resultSchema = wrapJsonValues(out.resultSchema, `${source}:agent.resultSchema`);
  return out;
}

/** Agent run: `task` and `result` are model/task-authored free text; `cause`
 * carries a human-readable failure message. */
export function sanitizeAgentRun(run: unknown, source: string): unknown {
  if (!isObj(run)) return run;
  const out: Obj = { ...run };
  out.task = wrapStr(out.task, `${source}:run.task`);
  out.result = wrapJsonValues(out.result, `${source}:run.result`);
  if (isObj(out.cause)) {
    out.cause = {
      ...out.cause,
      message: wrapStr(out.cause.message, `${source}:run.cause.message`),
    };
  }
  return out;
}

/** UIMessage keys whose values are protocol metadata (enums/ids), not prose. */
const STRUCTURAL_MESSAGE_KEYS = new Set(['role', 'type', 'id', 'toolCallId', 'toolName', 'state']);

/**
 * Recursively wrap string values inside a UIMessage payload, leaving the
 * allowlisted structural keys (role, part type, tool ids/names) raw so the
 * conversation shape stays readable. Keys themselves are never wrapped.
 */
function wrapMessageStrings(value: unknown, source: string): unknown {
  if (typeof value === 'string') return wrapUntrusted(value, source);
  if (Array.isArray(value)) return value.map((item) => wrapMessageStrings(item, source));
  if (isObj(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        STRUCTURAL_MESSAGE_KEYS.has(key) ? item : wrapMessageStrings(item, source),
      ]),
    );
  }
  return value;
}

/**
 * Agent-run message entry ({id, createdAt, message}). The `message` payload is
 * an AI-SDK UIMessage authored by the run's agent loop: wrap its string
 * content, keeping structural fields (`role`, part `type`, tool names)
 * readable so the LLM can still follow the conversation shape.
 */
export function sanitizeRunMessageEntry(entry: unknown, source: string): unknown {
  if (!isObj(entry)) return entry;
  const out: Obj = { ...entry };
  if (isObj(out.message)) {
    out.message = wrapMessageStrings(out.message, `${source}:message`);
  } else if (typeof out.message === 'string') {
    out.message = wrapStr(out.message, `${source}:message`);
  }
  return out;
}

/** Session live URLs: page `url`, `title`, and `faviconUrl` are controlled by
 * the visited (potentially hostile) page. The debugger/ws URLs are minted by
 * Browserbase and stay raw so they can be shared with a human. */
export function sanitizeDebugUrls(live: unknown, source: string): unknown {
  if (!isObj(live)) return live;
  const out: Obj = { ...live };
  if (Array.isArray(out.pages)) {
    out.pages = out.pages.map((page) => {
      if (!isObj(page)) return page;
      const p: Obj = { ...page };
      p.url = wrapStr(p.url, `${source}:page.url`);
      p.title = wrapStr(p.title, `${source}:page.title`);
      p.faviconUrl = wrapStr(p.faviconUrl, `${source}:page.faviconUrl`);
      return p;
    });
  }
  return out;
}

/** CDP session log: `params` / `result` are page-influenced CDP payloads and
 * `rawBody` is the raw wire body (page-authored, potentially huge). */
export function sanitizeSessionLog(log: unknown, source: string): unknown {
  if (!isObj(log)) return log;
  const out: Obj = { ...log };
  if (isObj(out.request)) {
    out.request = {
      ...out.request,
      params: wrapJsonValues(out.request.params, `${source}:log.request.params`),
      rawBody: wrapTruncated(out.request.rawBody, `${source}:log.request.rawBody`),
    };
  }
  if (isObj(out.response)) {
    out.response = {
      ...out.response,
      result: wrapJsonValues(out.response.result, `${source}:log.response.result`),
      rawBody: wrapTruncated(out.response.rawBody, `${source}:log.response.rawBody`),
    };
  }
  return out;
}

/** Replay page: `url` is controlled by the visited page. */
export function sanitizeReplayPage(page: unknown, source: string): unknown {
  if (!isObj(page)) return page;
  const out: Obj = { ...page };
  out.url = wrapStr(out.url, `${source}:replay_page.url`);
  return out;
}

/** Download record: `filename` is chosen by the downloaded content/site. */
export function sanitizeDownload(download: unknown, source: string): unknown {
  if (!isObj(download)) return download;
  const out: Obj = { ...download };
  out.filename = wrapStr(out.filename, `${source}:download.filename`);
  return out;
}

/** Extension record: `fileName` comes from the uploaded archive. */
export function sanitizeExtension(extension: unknown, source: string): unknown {
  if (!isObj(extension)) return extension;
  const out: Obj = { ...extension };
  out.fileName = wrapStr(out.fileName, `${source}:extension.fileName`);
  return out;
}

/** Function record: `name` is authored by whoever deployed the function. */
export function sanitizeFunction(fn: unknown, source: string): unknown {
  if (!isObj(fn)) return fn;
  const out: Obj = { ...fn };
  out.name = wrapStr(out.name, `${source}:function.name`);
  return out;
}

/** Function build: `cause.message`, `request.entrypoint`/`functionNames`, and
 * built function names are function-author-controlled text. */
export function sanitizeFunctionBuild(build: unknown, source: string): unknown {
  if (!isObj(build)) return build;
  const out: Obj = { ...build };
  if (isObj(out.cause)) {
    out.cause = {
      ...out.cause,
      message: wrapStr(out.cause.message, `${source}:build.cause.message`),
    };
  }
  if (isObj(out.request)) {
    const request: Obj = { ...out.request };
    request.entrypoint = wrapStr(request.entrypoint, `${source}:build.request.entrypoint`);
    if (Array.isArray(request.functionNames)) {
      request.functionNames = request.functionNames.map((n) =>
        wrapStr(n, `${source}:build.request.functionNames`));
    }
    out.request = request;
  }
  if (Array.isArray(out.builtFunctions)) {
    out.builtFunctions = out.builtFunctions.map((f) => sanitizeFunction(f, source));
  }
  return out;
}

/** Function invocation: `results` is arbitrary output of third-party function
 * code (often scraped web content); `cause.message` is failure text.
 * `params` is what the caller passed in — already known to the LLM — and is
 * left unwrapped. */
export function sanitizeInvocation(invocation: unknown, source: string): unknown {
  if (!isObj(invocation)) return invocation;
  const out: Obj = { ...invocation };
  out.results = wrapJsonValues(out.results, `${source}:invocation.results`);
  if (isObj(out.cause)) {
    out.cause = {
      ...out.cause,
      message: wrapStr(out.cause.message, `${source}:invocation.cause.message`),
    };
  }
  return out;
}

/** Build/invocation log entry: `message` is emitted by third-party code. */
export function sanitizeLogEntry(entry: unknown, source: string): unknown {
  if (!isObj(entry)) return entry;
  const out: Obj = { ...entry };
  out.message = wrapStr(out.message, `${source}:log.message`);
  return out;
}

/** Fetch response: `content` is arbitrary web content; response header values
 * are server-authored by the fetched origin. */
export function sanitizeFetchResponse(response: unknown, source: string): unknown {
  if (!isObj(response)) return response;
  const out: Obj = { ...response };
  if (typeof out.content === 'string') {
    out.content = wrapStr(out.content, `${source}:fetch.content`);
  } else if (out.content !== undefined) {
    out.content = wrapJsonValues(out.content, `${source}:fetch.content`);
  }
  out.headers = wrapJsonValues(out.headers, `${source}:fetch.headers`);
  return out;
}

/** Search result: every field (title, snippet, url, …) is authored by the
 * indexed page. */
export function sanitizeSearchResult(result: unknown, source: string): unknown {
  return wrapJsonValues(result, `${source}:search.result`);
}

export function sanitizeList(items: unknown, sanitize: (item: unknown, source: string) => unknown, source: string): unknown[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => sanitize(item, source));
}
