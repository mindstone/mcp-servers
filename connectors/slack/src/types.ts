import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const SERVER_NAME = 'slack-mcp-server';

/**
 * Server version reported on MCP `initialize`. Read from package.json so it
 * cannot drift from the published npm version (cohort fix; closes failure
 * class 8).
 */
export const SERVER_VERSION = pkg.version;

/**
 * Default upstream-call timeout. `search.messages` on large workspaces can
 * be slow; 60s gives enough headroom without being lazy. Postmortem
 * `260421_nano_banana_request_timeout_postmortem.md` explains why we need
 * a positive default and an env override.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Hard ceiling on the override — no caller should hold a Slack request open
 *  for longer than 5 minutes. */
const MAX_REQUEST_TIMEOUT_MS = 300_000;

function resolveRequestTimeoutMs(): number {
  const raw = process.env.SLACK_REQUEST_TIMEOUT_MS;
  if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_REQUEST_TIMEOUT_MS) {
    return parsed;
  }
  console.error(
    `[slack-mcp] SLACK_REQUEST_TIMEOUT_MS=${raw} is invalid; falling back to ${DEFAULT_REQUEST_TIMEOUT_MS}ms.`,
  );
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

export const REQUEST_TIMEOUT_MS = resolveRequestTimeoutMs();

/**
 * Number of WebClient retries on transient failures. Defaults to 10 (the
 * `@slack/web-api` default of `tenRetriesInAboutThirtyMinutes`). Override
 * via `SLACK_MAX_RETRIES` — useful on cloud, where long retry budgets can
 * stack into multi-minute hangs, and in tests, where we want to assert the
 * cohort timeout fires without paying for 10 successive retries.
 */
function resolveMaxRetries(): number {
  const raw = process.env.SLACK_MAX_RETRIES;
  if (raw === undefined || raw === '') return 10;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 20) return parsed;
  console.error(
    `[slack-mcp] SLACK_MAX_RETRIES=${raw} is invalid; falling back to 10.`,
  );
  return 10;
}

export const MAX_RETRIES = resolveMaxRetries();

/**
 * Default `next_step` per error code.
 *
 * Used when a `ConnectorError` is constructed without an explicit `nextStep`.
 * Keeps the recovery-guidance contract (`action_required` + `next_step`) on
 * EVERY error response so callers always have a tool name to retry / hop to.
 */
export const DEFAULT_NEXT_STEP_BY_CODE: Record<string, string> = {
  NO_TOKEN: 'authenticate_slack_workspace',
  REFRESH_FAILED: 'authenticate_slack_workspace',
  REFRESH_TRANSIENT: 'retry_after_delay',
  REFRESH_RATE_LIMITED: 'retry_after_delay',
  REFRESH_AUTH_REJECTED: 'authenticate_slack_workspace',
  REFRESH_MALFORMED_RESPONSE: 'authenticate_slack_workspace',
  // Persisted refresh-token write failed but rotated tokens are still
  // cached in memory for this process. Forcing reauth here would burn
  // Slack's single-use refresh token; tell the caller to retry instead.
  TOKEN_PERSIST_FAILED: 'retry_after_delay',
  TOKEN_FILE_CORRUPT: 'authenticate_slack_workspace',
  TOKEN_FILE_PERMISSION_DENIED: 'list_slack_workspaces',
  TOKEN_FILE_UNREADABLE: 'list_slack_workspaces',
  WORKSPACE_DIR_PERMISSION_DENIED: 'list_slack_workspaces',
  WORKSPACE_DIR_ALL_CORRUPT: 'authenticate_slack_workspace',
  SLACK_FILE_URL_UNTRUSTED: 'list_slack_workspaces',
  INVALID_TEAM_ID: 'list_slack_workspaces',
  TOKEN_EXPIRED_REFRESH_DISABLED: 'authenticate_slack_workspace',
  REFRESH_NO_CLIENT_CREDENTIALS: 'authenticate_slack_workspace',
  NOT_CONNECTED: 'authenticate_slack_workspace',
  MISSING_SCOPE: 'authenticate_slack_workspace',
  RATE_LIMITED: 'retry_after_delay',
  CHANNEL_LOOKUP_FAILED: 'list_slack_channels',
  CHANNEL_NOT_FOUND: 'list_slack_channels',
  USER_NOT_FOUND: 'lookup_user_by_email',
  AMBIGUOUS_USER: 'lookup_user_by_email',
};

const FALLBACK_NEXT_STEP = 'list_slack_workspaces';

/**
 * Structured error type used by tool handlers. The host's `withErrorHandling`
 * wrapper turns this into a JSON response with `action_required` /
 * `next_step` fields. Always set `code` and `resolution`; `nextStep` may be
 * supplied explicitly or derived from `DEFAULT_NEXT_STEP_BY_CODE` for the
 * given `code`. Either way, the wrapper guarantees `next_step` is present
 * on every error response.
 */
export class ConnectorError extends Error {
  public readonly nextStep: string;

  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
    public readonly extra?: Record<string, unknown>,
    nextStep?: string,
  ) {
    super(message);
    this.name = 'ConnectorError';
    this.nextStep = nextStep ?? DEFAULT_NEXT_STEP_BY_CODE[code] ?? FALLBACK_NEXT_STEP;
  }
}

/** Error code thrown by the token provider when refresh is disabled and the
 *  token has expired — caller must convert to the `auth_required` shape. */
export const TOKEN_EXPIRED_REFRESH_DISABLED = 'TOKEN_EXPIRED_REFRESH_DISABLED';

/** Error code thrown when a rotating token needs refreshing but no OAuth client
 *  credentials (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`) are configured on this
 *  surface. Saved non-rotating tokens never reach this — they authorize the API
 *  directly without client credentials. Caller converts to `auth_required`. */
export const REFRESH_NO_CLIENT_CREDENTIALS = 'REFRESH_NO_CLIENT_CREDENTIALS';

/**
 * Refresh failure classification — distinct codes per failure mode so the
 * host (and ops) can tell transient network errors apart from genuine auth
 * rejections (which require reauth) and from rate-limit responses (which
 * should be retried after a delay).
 */
export const REFRESH_TRANSIENT = 'REFRESH_TRANSIENT';
export const REFRESH_RATE_LIMITED = 'REFRESH_RATE_LIMITED';
export const REFRESH_AUTH_REJECTED = 'REFRESH_AUTH_REJECTED';
export const REFRESH_MALFORMED_RESPONSE = 'REFRESH_MALFORMED_RESPONSE';

/**
 * Slack `oauth.v2.access` `error` values that indicate the refresh token
 * itself is no longer accepted by Slack — reauth is the only recovery.
 * Other Slack errors (e.g. transient `temporarily_unavailable`) get the
 * REFRESH_TRANSIENT classification.
 */
export const SLACK_REFRESH_AUTH_REJECTED_ERRORS: ReadonlyArray<string> = [
  'invalid_grant',
  'invalid_refresh_token',
  'token_revoked',
  'token_expired',
  'invalid_auth',
  'account_inactive',
];

/**
 * Token data persisted at `${SLACK_CONFIG_PATH}/workspaces/${SLACK_TEAM_ID}.json`.
 * SCHEMA: byte-compatible with the desktop `slackAuthService` writer. Do NOT
 * change field names without coordinating a desktop release.
 */
export interface SlackTokenData {
  botToken: string;
  userToken?: string;
  botRefreshToken?: string;
  botExpiresAt?: number; // epoch ms
  userRefreshToken?: string;
  userExpiresAt?: number; // epoch ms
  botUserId: string;
  botUsername?: string;
  authedUserId?: string;
}

export interface SlackWorkspace {
  teamId: string;
  teamName: string;
  authedAt: string;
}

/** Verified DM partner identity used by `post_slack_message` recipient guard. */
export interface DmRecipient {
  user_id: string;
  real_name: string;
  display_name: string;
  email?: string;
}
