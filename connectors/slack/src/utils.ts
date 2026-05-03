import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ConnectorError,
  REFRESH_AUTH_REJECTED,
  REQUEST_TIMEOUT_MS,
  TOKEN_EXPIRED_REFRESH_DISABLED,
} from './types.js';

/**
 * Error codes that should be routed to the structured `auth_required`
 * shape rather than the generic `{ ok: false, ... }` error envelope.
 *
 * Stage 0 host's `AuthOrchestrator` listens for `status: 'auth_required'`
 * — a refresh failure where Slack rejected the refresh token, OR a
 * never-authed bot token, both belong here so the host can dispatch the
 * Slack OAuth flow.
 */
const AUTH_REQUIRED_CODES: ReadonlyArray<string> = [
  TOKEN_EXPIRED_REFRESH_DISABLED,
  REFRESH_AUTH_REJECTED,
  'NO_TOKEN',
];

/**
 * Strip Slack tokens, OAuth client secrets, and bearer-style credentials
 * from any string before logging or surfacing in a tool response. Defensive
 * second line — primary defence is "never put secrets in messages" — but
 * this guarantees a misbehaving SDK or a wrapped error never leaks them.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Slack token formats: xoxb-, xoxp-, xoxa-, xapp-, xoxe-, xoxr-, xoxs-,
  // optionally followed by token-like body (alphanumeric, hyphens). Match
  // greedily until whitespace / end-of-string. Also match url-encoded `%2D`
  // hyphen variant so percent-encoded credentials don't slip through.
  // Body MUST allow encoded hyphens too — `xoxb%2D123%2D456%2Dsecret`
  // is fully url-encoded and would otherwise leak tail segments.
  { pattern: /\bxox[abeprs](?:-|%2[Dd])(?:[A-Za-z0-9]|-|%2[Dd])+/g, replacement: 'xox?-[REDACTED]' },
  { pattern: /\bxapp(?:-|%2[Dd])(?:[A-Za-z0-9]|-|%2[Dd])+/g, replacement: 'xapp-[REDACTED]' },
  // Authorization: Bearer <token> — handle both literal whitespace and the
  // url-encoded `%20` form. Allow optional surrounding quotes.
  { pattern: /\bBearer(\s|%20)+[A-Za-z0-9._\-/+=%]+/gi, replacement: 'Bearer [REDACTED]' },
  // Long opaque strings that look like client secrets / refresh tokens
  // (32+ chars of base64-ish content). Conservative — only matches when
  // not adjacent to other word chars to limit false positives.
  {
    pattern: /(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/g,
    replacement: '[REDACTED-LONG-SECRET]',
  },
];

export function sanitizeErrorMessage(input: string): string {
  let out = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Sanitize the body of an arbitrary error-extra object, defensively
 * applying secret redaction to every string-valued leaf. Used before
 * spreading `ConnectorError.extra` into a tool response so a future
 * caller that adds structured request/header context can't accidentally
 * leak `Authorization: Bearer xoxb-...` into the public response.
 */
function sanitizeExtraDeep(value: unknown, depth = 0): unknown {
  // At max depth, do NOT pass the raw value through — a deeply-nested
  // secret would leak. Return a placeholder so downstream JSON.stringify
  // succeeds and ops can see the truncation happened.
  if (depth > 6) return '[REDACTED-DEPTH-EXCEEDED]';
  // BigInt is not serialisable by JSON.stringify and would throw, breaking
  // the error pipeline itself. Convert to a string with the conventional
  // `n` suffix so the value is still inspectable in logs.
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'string') return sanitizeErrorMessage(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeExtraDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeExtraDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Wraps a tool handler with standard error handling. Handlers return JSON
 * strings; this turns thrown `ConnectorError`s and unexpected errors into
 * `{ ok: false, ... }` responses with `action_required` / `next_step`
 * recovery guidance preserved on the error object.
 */
export function withErrorHandling<T>(
  fn: (args: T, extra: unknown) => Promise<string>,
): ToolHandler<T> {
  return async (args, extra) => {
    try {
      const result = await fn(args, extra);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      // Codes that mean "host must re-run OAuth" → auth_required shape so
      // the host's AuthOrchestrator (Stage 0 `AuthRequiredResponseSchema`)
      // dispatches reauth automatically. Includes:
      //   - TOKEN_EXPIRED_REFRESH_DISABLED (cloud surface, fail-closed)
      //   - REFRESH_AUTH_REJECTED (Slack rejected refresh — invalid_grant
      //     etc; the only recovery is reauth)
      //   - NO_TOKEN (never authenticated; same UX as reauth)
      if (error instanceof ConnectorError && AUTH_REQUIRED_CODES.includes(error.code)) {
        return {
          content: [{ type: 'text', text: JSON.stringify(buildAuthRequiredResponse()) }],
          isError: true,
        };
      }

      if (error instanceof ConnectorError) {
        const sanitizedExtra =
          error.extra ? (sanitizeExtraDeep(error.extra) as Record<string, unknown>) : {};
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: sanitizeErrorMessage(error.message),
                code: error.code,
                resolution: sanitizeErrorMessage(error.resolution),
                action_required: sanitizeErrorMessage(error.resolution),
                // ConnectorError now always carries a next_step (explicit or
                // derived from DEFAULT_NEXT_STEP_BY_CODE). Surface it so the
                // recovery-guidance contract holds for every error response.
                next_step: error.nextStep,
                // Spread sanitized extras LAST but never let them clobber
                // the canonical fields — that would let a buggy throw-site
                // override `next_step` with a misleading recovery hint.
                ...Object.fromEntries(
                  Object.entries(sanitizedExtra).filter(
                    ([k]) => !['ok', 'error', 'code', 'resolution', 'action_required', 'next_step']
                      .includes(k),
                  ),
                ),
              }),
            },
          ],
          isError: true,
        };
      }

      // Slack WebAPI errors — extract structured fields where possible
      const slackError = extractSlackErrorCode(error);
      if (slackError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: `Slack API error: ${slackError.code}`,
                code: slackError.code,
                resolution: slackError.resolution,
                action_required: slackError.resolution,
                next_step: slackError.next_step,
              }),
            },
          ],
          isError: true,
        };
      }

      const rawMessage = error instanceof Error ? error.message : String(error);
      const errorMessage = sanitizeErrorMessage(rawMessage);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: errorMessage,
              action_required: 'Retry the operation. If it continues to fail, run list_slack_workspaces to verify the connection.',
              next_step: 'list_slack_workspaces',
            }),
          },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Compose a per-call abort signal with the cohort timeout.
 *
 * Returns an AbortSignal that fires when EITHER the caller's signal aborts
 * OR `REQUEST_TIMEOUT_MS` elapses, whichever is sooner. Per postmortem
 * 260421, never let a caller-supplied signal silently disable the timeout.
 */
export function abortableSignal(callerSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!callerSignal) return timeoutSignal;
  // Node 20+ has AbortSignal.any
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  // Fallback: manual composition
  const controller = new AbortController();
  const onAbort = (reason: unknown) => controller.abort(reason);
  if (callerSignal.aborted) {
    controller.abort(callerSignal.reason);
  } else {
    callerSignal.addEventListener('abort', () => onAbort(callerSignal.reason), { once: true });
  }
  if (timeoutSignal.aborted) {
    controller.abort(timeoutSignal.reason);
  } else {
    timeoutSignal.addEventListener('abort', () => onAbort(timeoutSignal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Build the chief-designer-approved structured `auth_required` response.
 *
 * The host's `invokeStdioAuthenticateTool` (Stage 0) parses this shape and
 * dispatches to the registered `slackApi` orchestrator, which initiates the
 * desktop OAuth flow. The OSS server NEVER initiates OAuth itself — it just
 * signals the host to.
 */
export function buildAuthRequiredResponse(): Record<string, unknown> {
  return {
    status: 'auth_required',
    user_action: {
      id: 'slack.connect_workspace',
      label: 'Connect Slack',
      instruction: 'Click "Connect Slack" in the side panel to authorise the workspace.',
    },
    agent_action: {
      instruction:
        'Tell the user to click the Connect Slack button in the connector settings to authorise. Then call list_slack_workspaces to verify.',
    },
    setupToolName: 'authenticate_slack_workspace',
  };
}

/**
 * Validate that a Slack-supplied URL is safe to send a bearer token to:
 *   - parses as a URL
 *   - uses the `https:` scheme
 *   - hostname is exactly `slack.com` or any `*.slack.com` subdomain
 *
 * Throws `ConnectorError('SLACK_FILE_URL_UNTRUSTED', ...)` if any check
 * fails. Used by file-download paths because an attacker who can influence
 * `url_private_download` could otherwise exfiltrate the workspace bot
 * token to a server they control.
 *
 * The user-facing error message intentionally does NOT include the
 * offending URL (could be very long; could leak structure) — but stderr
 * gets a structured log with the hostname so ops can detect upstream
 * attacks.
 */
const SLACK_OWNED_HOSTNAME = /(^|\.)slack\.com$/;

export function assertSlackOwnedHttpsUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    console.error(
      `[slack-mcp] BLOCKED untrusted file URL (malformed): rawUrlLength=${rawUrl.length}`,
    );
    throw new ConnectorError(
      'Slack returned a malformed download URL — refusing to attach the workspace credential to an unparseable host.',
      'SLACK_FILE_URL_UNTRUSTED',
      'Re-run get_slack_channel_history to refresh the file metadata, then retry the download.',
    );
  }
  if (parsed.protocol !== 'https:') {
    console.error(
      `[slack-mcp] BLOCKED untrusted file URL (non-https): protocol=${parsed.protocol} hostname=${parsed.hostname}`,
    );
    throw new ConnectorError(
      'Slack returned a non-HTTPS download URL — refusing to attach the workspace credential over an insecure scheme.',
      'SLACK_FILE_URL_UNTRUSTED',
      'Re-run get_slack_channel_history to refresh the file metadata, then retry the download.',
    );
  }
  if (!SLACK_OWNED_HOSTNAME.test(parsed.hostname)) {
    console.error(
      `[slack-mcp] BLOCKED untrusted file URL (off-Slack host): hostname=${parsed.hostname}`,
    );
    throw new ConnectorError(
      'Slack returned a download URL outside the slack.com domain — refusing to attach the workspace credential to that host.',
      'SLACK_FILE_URL_UNTRUSTED',
      'Re-run get_slack_channel_history to refresh the file metadata, then retry the download. If the upstream URL is genuinely external, fetch it from a separate context without workspace credentials.',
    );
  }
}

/**
 * Convert a Slack timestamp ("1234567890.123456") to ISO 8601 datetime.
 */
export function slackTsToDatetime(ts: string): string {
  const [secondsStr, microsStr = '000000'] = ts.split('.');
  const seconds = parseInt(secondsStr, 10);
  const millis = parseInt(microsStr.slice(0, 3).padEnd(3, '0'), 10);
  return new Date(seconds * 1000 + millis).toISOString();
}

interface ParsedSlackPermalink {
  channelId: string;
  messageTs: string;
  threadTs?: string;
}

function normalizeSlackTs(input: string): string | null {
  if (/^\d{10}\.\d{6}$/.test(input)) return input;
  if (/^\d{16}$/.test(input)) {
    const seconds = input.slice(0, -6);
    const micros = input.slice(-6);
    const ts = `${seconds}.${micros}`;
    return /^\d{10}\.\d{6}$/.test(ts) ? ts : null;
  }
  return null;
}

export function parseSlackPermalink(urlString: string): ParsedSlackPermalink | null {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  if (!url.hostname.endsWith('slack.com')) return null;
  const pathParts = url.pathname.split('/').filter(Boolean);
  let channelId: string | undefined;
  let pPart: string | undefined;
  if (pathParts[0] === 'archives' && pathParts.length >= 3) {
    channelId = pathParts[1];
    pPart = pathParts[2];
  }
  if (pathParts[0] === 'client' && pathParts.length >= 4) {
    channelId = pathParts[2];
    pPart = pathParts[3];
  }
  if (!channelId || !/^[CGD][A-Z0-9]+$/.test(channelId)) return null;
  if (!pPart || !/^p\d+$/.test(pPart)) return null;
  const digits = pPart.slice(1);
  if (!/^\d{16}$/.test(digits)) return null;
  const messageTs = normalizeSlackTs(digits);
  if (!messageTs) return null;
  const threadTsParam = url.searchParams.get('thread_ts');
  const threadTs = threadTsParam
    ? normalizeSlackTs(threadTsParam) ?? normalizeSlackTs(threadTsParam.replace('.', ''))
    : null;
  if (threadTsParam && !threadTs) return null;
  return { channelId, messageTs, ...(threadTs ? { threadTs } : {}) };
}

/**
 * Extract a Slack file ID from a `Fxxx` literal or a permalink URL.
 */
export function parseSlackFileId(urlOrId: string): string | null {
  if (/^F[A-Z0-9]+$/i.test(urlOrId)) return urlOrId.toUpperCase();
  try {
    const url = new URL(urlOrId);
    const filesMatch = url.pathname.match(/\/files\/[^/]+\/(F[A-Z0-9]+)/i);
    if (filesMatch) return filesMatch[1].toUpperCase();
    const filesPriMatch = url.pathname.match(/\/files-pri\/[^-]+-?(F[A-Z0-9]+)/i);
    if (filesPriMatch) return filesPriMatch[1].toUpperCase();
  } catch {
    // Not a valid URL
  }
  return null;
}

interface SlackErrorInfo {
  code: string;
  resolution: string;
  next_step: string;
}

function extractSlackErrorCode(error: unknown): SlackErrorInfo | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  const data = e.data as Record<string, unknown> | undefined;

  // Rate limit
  if (
    e.code === 'slack_webapi_rate_limited' ||
    (data && data.error === 'ratelimited')
  ) {
    const retryAfter =
      (typeof e.retryAfter === 'number' && e.retryAfter) ||
      (data && typeof data.retry_after === 'number' && data.retry_after) ||
      undefined;
    const wait = retryAfter ? `${retryAfter} seconds` : 'a moment';
    return {
      code: 'rate_limited',
      resolution: `Slack rate-limited the request. Wait ${wait} and retry.`,
      next_step: 'retry_after_delay',
    };
  }

  const slackCode = typeof data?.error === 'string' ? data.error : null;
  if (!slackCode) return null;

  switch (slackCode) {
    case 'not_in_channel':
      return {
        code: 'not_in_channel',
        resolution:
          'The bot is not a member of this channel. Invite the Slack app to the channel via /invite @<app-name>, then retry.',
        next_step: 'invite_app_to_channel',
      };
    case 'missing_scope':
    case 'not_allowed_token_type':
      return {
        code: 'missing_scope',
        resolution:
          'The connected Slack tokens lack required scopes. Reconnect Slack to grant the missing permissions.',
        next_step: 'authenticate_slack_workspace',
      };
    case 'invalid_auth':
    case 'token_expired':
    case 'token_revoked':
    case 'account_inactive':
      return {
        code: 'invalid_auth',
        resolution:
          'Slack tokens have expired or been revoked. Reconnect Slack to refresh credentials.',
        next_step: 'authenticate_slack_workspace',
      };
    case 'channel_not_found':
      return {
        code: 'channel_not_found',
        resolution:
          'No matching channel. Use list_slack_channels to find the channel ID, then retry with the ID.',
        next_step: 'list_slack_channels',
      };
    case 'user_not_found':
    case 'users_not_found':
      return {
        code: 'user_not_found',
        resolution:
          'No matching user. Use lookup_user_by_email or list_slack_users to find the user ID first.',
        next_step: 'lookup_user_by_email',
      };
    default:
      return {
        code: slackCode,
        resolution: `Slack returned error "${slackCode}". Check the input parameters and retry.`,
        next_step: 'list_slack_workspaces',
      };
  }
}

/** True if the error is a Slack rate-limit error. */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as Record<string, unknown>;
  const data = e.data as Record<string, unknown> | undefined;
  return e.code === 'slack_webapi_rate_limited' || data?.error === 'ratelimited';
}

/** True if the error is an `invalid_auth` / `token_expired` family error. */
export function isTokenExpiredError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as Record<string, unknown>;
  const data = e.data as Record<string, unknown> | undefined;
  if (!data || typeof data.error !== 'string') return false;
  return ['invalid_auth', 'token_expired', 'token_revoked', 'account_inactive'].includes(data.error);
}

/** True if the error is a missing-scope error. */
export function isMissingScopeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as Record<string, unknown>;
  const data = e.data as Record<string, unknown> | undefined;
  return data?.error === 'missing_scope' || data?.error === 'not_allowed_token_type';
}

/** Build a JSON-stringified error response with recovery guidance. */
export function errorJson(payload: {
  error: string;
  action_required: string;
  next_step: string;
  [key: string]: unknown;
}): string {
  return JSON.stringify({ ok: false, ...payload });
}

/** Build a JSON-stringified `auth_required` response (raw string for tools). */
export function authRequiredJson(): string {
  return JSON.stringify(buildAuthRequiredResponse());
}
