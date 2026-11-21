import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConnectorError } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

/**
 * URL scheme deny-list for browser_navigate / browser_authenticate.
 *
 * Only `http:` and `https:` are accepted. The pseudo-URL `about:blank` is
 * special-cased and permitted (it's the only safe `about:` page — no local
 * data, no chrome internals). All other schemes are refused before the
 * underlying agent-browser CLI is invoked, so the agent cannot:
 *   - read local files via `file:` URLs,
 *   - access browser internals via `chrome:` / `chrome-extension:` URLs,
 *   - execute page-side JavaScript via `javascript:` URLs,
 *   - render attacker-controlled inline payloads via `data:` URLs,
 *   - bypass the same-origin policy via `view-source:` URLs,
 *   - touch privileged `about:` pages (about:config, about:cache, …).
 */
const BLOCKED_URL_SCHEMES: ReadonlySet<string> = new Set([
  'file:',
  'chrome:',
  'chrome-extension:',
  'javascript:',
  'data:',
  'view-source:',
]);

/**
 * Validate the URL scheme of a user-supplied URL before forwarding it to the
 * agent-browser CLI. Throws a `ConnectorError` with a human-readable message
 * (and a stable code suitable for tool error responses) when the scheme is
 * not on the allow-list.
 */
export function validateUrlScheme(url: string): void {
  // Special case: `about:blank` is the only `about:` URL we accept. We match
  // it textually to sidestep any quirks in URL parsing for opaque schemes.
  if (url.toLowerCase() === 'about:blank') return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConnectorError(
      `URL scheme not allowed: invalid URL ${wrapUntrusted(url, 'browser-automation:url')}`,
      'URL_SCHEME_REJECTED',
      'Pass a valid http: or https: URL (or about:blank). Only http and https schemes are permitted.',
    );
  }

  const proto = parsed.protocol.toLowerCase();

  if (proto === 'http:' || proto === 'https:') return;

  if (proto === 'about:') {
    // We already returned above for about:blank — anything else here is
    // about:config / about:cache / about:debugging etc.
    throw new ConnectorError(
      `URL scheme not allowed: ${proto} (only about:blank is permitted, got ${wrapUntrusted(url, 'browser-automation:url')})`,
      'URL_SCHEME_REJECTED',
      'Only http://, https://, and about:blank URLs are accepted by the browser-automation connector.',
    );
  }

  // Default-deny: explicit deny-list match OR unknown scheme — both rejected.
  // The deny-list is enumerated for documentation; the protocol check above
  // is what actually enforces the policy.
  void BLOCKED_URL_SCHEMES; // referenced so the import survives tree-shaking

  throw new ConnectorError(
    `URL scheme not allowed: ${proto}. Only http: and https: schemes are permitted (about:blank also allowed).`,
    'URL_SCHEME_REJECTED',
    'Pass an http://, https://, or about:blank URL. Schemes like file:, chrome:, chrome-extension:, javascript:, data:, view-source:, and about: (other than about:blank) are refused.',
  );
}

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * The tool result for a thrown error. A ConnectorError carries text this
 * connector wrote, with any outside text in it (CLI output, a URL or path the
 * model passed) enveloped where the error is built, so it is returned with its
 * code and resolution. Any other error's message can carry
 * text from outside the connector (a path, a page, the CLI), so it reaches the
 * model only inside an untrusted-content envelope.
 */
function errorResult(error: unknown): CallToolResult {
  const body = error instanceof ConnectorError
    ? { ok: false, error: error.message, code: error.code, resolution: error.resolution }
    : { ok: false, error: wrapUntrusted(error instanceof Error ? error.message : String(error), 'browser-automation:error') };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
}

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On error: returns a structured JSON error (see errorResult).
 */
export function withErrorHandling<T>(
  fn: (args: T, extra: unknown) => Promise<string>,
): ToolHandler<T> {
  return async (args, extra) => {
    try {
      const result = await fn(args, extra);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      return errorResult(error);
    }
  };
}

/**
 * Wraps a tool handler that returns a CallToolResult directly (e.g. for image responses).
 */
export function withErrorHandlingRaw<T>(
  fn: (args: T, extra: unknown) => Promise<CallToolResult>,
): ToolHandler<T> {
  return async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (error) {
      return errorResult(error);
    }
  };
}
