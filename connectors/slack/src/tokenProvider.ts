/**
 * Slack Token Provider — manages OAuth token lifecycle for the Slack MCP server.
 *
 * Honours the byte-compatible token-file schema at
 * `${configPath}/workspaces/{teamId}.json` written by the desktop host.
 * Reads the file on every access (cache is invalidated cheaply); refreshes
 * via `oauth.v2.access` when expired; rewrites with mode 0o600.
 *
 * `SLACK_DISABLE_REFRESH=1`:
 *   When set, the provider will NOT call `oauth.v2.access` on expiry.
 *   Instead, it throws a `ConnectorError` with code
 *   `TOKEN_EXPIRED_REFRESH_DISABLED`. Tool handlers catch this and emit the
 *   structured `auth_required` response so the host can dispatch reauth.
 *   Used on cloud surfaces where the desktop is sole refresh authority,
 *   preventing cross-process refresh races (single-use refresh tokens).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ConnectorError,
  REFRESH_AUTH_REJECTED,
  REFRESH_MALFORMED_RESPONSE,
  REFRESH_RATE_LIMITED,
  REFRESH_TRANSIENT,
  REQUEST_TIMEOUT_MS,
  SLACK_REFRESH_AUTH_REJECTED_ERRORS,
  type SlackTokenData,
  TOKEN_EXPIRED_REFRESH_DISABLED,
} from './types.js';
import { sanitizeErrorMessage } from './utils.js';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Returns true when refresh is disabled by env. Unsafe equality is fine —
 * `'0'`, `'false'`, and `''` all leave refresh enabled. Anything else
 * truthy disables it.
 */
function isRefreshDisabled(): boolean {
  const v = process.env.SLACK_DISABLE_REFRESH;
  if (!v) return false;
  return v !== '0' && v.toLowerCase() !== 'false';
}

/**
 * Slack workspace IDs match `T[A-Z0-9]+` (uppercase alphanumeric, leading T).
 * Validating at construction time prevents path traversal attacks via
 * `SLACK_TEAM_ID=../../etc/passwd` and similar misconfigurations.
 */
const SLACK_TEAM_ID_PATTERN = /^T[A-Z0-9]+$/;

type RefreshEvent = 'refresh_attempt' | 'refresh_success' | 'refresh_failure';
type RefreshOutcomeCode =
  | 'success'
  | typeof REFRESH_TRANSIENT
  | typeof REFRESH_RATE_LIMITED
  | typeof REFRESH_AUTH_REJECTED
  | typeof REFRESH_MALFORMED_RESPONSE;

/**
 * Single-source structured logging for refresh outcomes. Fields: ISO
 * timestamp, team_id, event, outcome_code, slack_error_code, retry_after,
 * sanitized_message. Emitted to stderr as a single-line JSON object so an
 * operator can grep / pipe-to-jq.
 */
function logRefreshEvent(
  event: RefreshEvent,
  fields: {
    teamId: string;
    tokenType?: 'bot' | 'user';
    outcomeCode?: RefreshOutcomeCode;
    slackErrorCode?: string;
    retryAfterSeconds?: number;
    message?: string;
  },
): void {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    component: 'slack-mcp.tokenProvider',
    event,
    team_id: fields.teamId,
  };
  if (fields.tokenType) payload.token_type = fields.tokenType;
  if (fields.outcomeCode) payload.outcome_code = fields.outcomeCode;
  if (fields.slackErrorCode) {
    // Sanitize defensively — Slack error strings should be short identifiers
    // (`invalid_grant`, `token_revoked`), but a misbehaving upstream or a
    // proxied error could surface a token-shaped value here.
    payload.slack_error_code = sanitizeErrorMessage(fields.slackErrorCode);
  }
  if (typeof fields.retryAfterSeconds === 'number') {
    payload.retry_after_seconds = fields.retryAfterSeconds;
  }
  if (fields.message) payload.sanitized_message = sanitizeErrorMessage(fields.message);
  console.error(`[slack-mcp] ${JSON.stringify(payload)}`);
}

/**
 * Test-only re-export of the structured refresh logger so tests can verify
 * sanitization behaviour without driving a full refresh path. Not part of
 * the public API.
 */
export const __testOnlyLogRefreshEvent = logRefreshEvent;

export class SlackTokenProvider {
  private cachedTokens: SlackTokenData | null = null;
  private botRefreshPromise: Promise<string> | null = null;
  private userRefreshPromise: Promise<string | null> | null = null;

  constructor(
    private readonly configPath: string,
    private readonly teamId: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {
    if (!SLACK_TEAM_ID_PATTERN.test(teamId)) {
      throw new ConnectorError(
        `Invalid SLACK_TEAM_ID: ${JSON.stringify(teamId)}. Slack workspace IDs match the pattern T[A-Z0-9]+.`,
        'INVALID_TEAM_ID',
        'Set SLACK_TEAM_ID to a valid Slack workspace ID (e.g., T0123ABCD). Reconnect Slack if you do not have one yet.',
      );
    }
  }

  private getTokenPath(): string {
    const tokenPath = path.join(this.configPath, 'workspaces', `${this.teamId}.json`);
    // Belt-and-braces: even with the regex check, verify the resolved path
    // still lives inside the configured `workspaces/` directory before any
    // disk I/O. Defends against future refactors that loosen the regex or
    // change `path.join` semantics on a future Node version.
    const resolvedRoot = path.resolve(this.configPath, 'workspaces') + path.sep;
    const resolvedToken = path.resolve(tokenPath);
    if (!resolvedToken.startsWith(resolvedRoot)) {
      throw new ConnectorError(
        `Token path escaped workspaces directory: ${resolvedToken}`,
        'INVALID_TEAM_ID',
        'Set SLACK_TEAM_ID to a valid Slack workspace ID (e.g., T0123ABCD).',
      );
    }
    return tokenPath;
  }

  /**
   * Read the on-disk token file and cache the result.
   *
   * Distinct error codes per § 5.3 — silent failure here is a bug because
   * a corrupt file (or a `chmod 000` file) gets the same response as a
   * fresh install, which produces wrong remediation guidance.
   *
   * - ENOENT  → return null  (legitimate first-run / not-yet-authed)
   * - EACCES / EPERM → throw `TOKEN_FILE_PERMISSION_DENIED`
   * - SyntaxError on parse → throw `TOKEN_FILE_CORRUPT`
   * - other unexpected → throw `TOKEN_FILE_UNREADABLE`
   */
  async loadTokens(): Promise<SlackTokenData | null> {
    const tokenPath = this.getTokenPath();
    let raw: string;
    try {
      raw = fs.readFileSync(tokenPath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return null;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new ConnectorError(
          'Slack token file exists but is not readable by this process.',
          'TOKEN_FILE_PERMISSION_DENIED',
          'Verify the host has read permission on the Slack token file. On POSIX, the file should be mode 0600 owned by the host process user.',
          { path: tokenPath },
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConnectorError(
        `Failed to read Slack token file: ${sanitizeErrorMessage(msg)}`,
        'TOKEN_FILE_UNREADABLE',
        'Inspect the token file path; if disk-level errors persist, reconnect via your MCP host application.',
        { path: tokenPath },
      );
    }
    try {
      this.cachedTokens = JSON.parse(raw) as SlackTokenData;
      return this.cachedTokens;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConnectorError(
        `Slack token file is not valid JSON: ${sanitizeErrorMessage(msg)}`,
        'TOKEN_FILE_CORRUPT',
        'The token file is corrupt or partially written. Re-authenticate the Slack workspace via your MCP host application to rewrite it.',
        { path: tokenPath },
      );
    }
  }

  private isExpired(expiresAt: number | undefined): boolean {
    if (!expiresAt) return false;
    return expiresAt < Date.now() + REFRESH_BUFFER_MS;
  }

  /** Force re-read on next access (after a known external write). */
  invalidateCache(): void {
    this.cachedTokens = null;
  }

  async hasTokens(): Promise<boolean> {
    const tokens = this.cachedTokens ?? (await this.loadTokens());
    return !!tokens?.botToken;
  }

  async getBotToken(): Promise<string> {
    let tokens = this.cachedTokens ?? (await this.loadTokens());
    if (!tokens?.botToken) {
      throw new ConnectorError(
        'No Slack bot token found.',
        'NO_TOKEN',
        'Re-authenticate the Slack workspace via your MCP host application to provision tokens.',
      );
    }

    // Non-rotating token: never expires.
    if (!tokens.botRefreshToken) return tokens.botToken;

    // Token still valid.
    if (!this.isExpired(tokens.botExpiresAt)) return tokens.botToken;

    // Re-read disk: another process may have refreshed.
    const diskTokens = await this.loadTokens();
    if (diskTokens && !this.isExpired(diskTokens.botExpiresAt)) {
      console.error('[slack-mcp] Bot token refreshed by another process, using disk token');
      return diskTokens.botToken;
    }

    // Refresh disabled — throw a structured error the host turns into auth_required.
    if (isRefreshDisabled()) {
      throw new ConnectorError(
        'Slack bot token expired and refresh is disabled on this surface.',
        TOKEN_EXPIRED_REFRESH_DISABLED,
        'Re-authenticate the Slack workspace via your MCP host application. The OS is the sole refresh authority for this MCP.',
      );
    }

    const refreshToken = diskTokens?.botRefreshToken ?? tokens.botRefreshToken;
    if (!refreshToken) return tokens.botToken;

    if (this.botRefreshPromise) return this.botRefreshPromise;

    logRefreshEvent('refresh_attempt', { teamId: this.teamId, tokenType: 'bot' });
    this.botRefreshPromise = (async () => {
      try {
        const result = await this.refreshToken(refreshToken, 'bot');
        const updated: SlackTokenData = {
          ...(diskTokens ?? tokens!),
          botToken: result.accessToken,
          botRefreshToken: result.refreshToken,
          botExpiresAt: result.expiresAt,
        };
        // saveTokens caches the rotated tokens in memory FIRST (before disk
        // I/O) so a persistence failure cannot lose Slack's single-use
        // refresh token. If saveTokens throws TOKEN_PERSIST_FAILED, the
        // in-memory cache already holds the rotated values — we re-throw
        // distinctly so the host knows we have valid tokens in memory but
        // couldn't persist. Critically, we do NOT call loadTokens() in the
        // catch path: doing so would overwrite the freshly-rotated
        // in-memory tokens with the now-stale on-disk value, and Slack
        // would have already invalidated the old refresh token.
        await this.saveTokens(updated);
        logRefreshEvent('refresh_success', {
          teamId: this.teamId,
          tokenType: 'bot',
          outcomeCode: 'success',
        });
        return updated.botToken;
      } catch (err) {
        // Persistence failure: rotated tokens survive in cachedTokens (set
        // by saveTokens BEFORE the write attempt). Re-throw distinctly —
        // do NOT remap to REFRESH_FAILED and do NOT call loadTokens().
        if (err instanceof ConnectorError && err.code === 'TOKEN_PERSIST_FAILED') {
          logRefreshEvent('refresh_failure', {
            teamId: this.teamId,
            tokenType: 'bot',
            outcomeCode: 'success',
            message: 'rotated tokens cached in memory only (persist failed)',
          });
          throw err;
        }

        // Refresh classification: transient / rate-limited / auth-rejected
        // / malformed. Already-classified ConnectorErrors propagate.
        if (err instanceof ConnectorError) {
          logRefreshEvent('refresh_failure', {
            teamId: this.teamId,
            tokenType: 'bot',
            outcomeCode: err.code as RefreshOutcomeCode,
            slackErrorCode: typeof err.extra?.slack_error_code === 'string' ? err.extra.slack_error_code : undefined,
            retryAfterSeconds: typeof err.extra?.retry_after_seconds === 'number' ? err.extra.retry_after_seconds : undefined,
            message: err.message,
          });
          throw err;
        }

        // Unexpected non-ConnectorError — wrap as transient (caller can
        // retry); never silently downgrade to a stale on-disk token.
        const msg = err instanceof Error ? err.message : String(err);
        logRefreshEvent('refresh_failure', {
          teamId: this.teamId,
          tokenType: 'bot',
          outcomeCode: REFRESH_TRANSIENT,
          message: msg,
        });
        throw new ConnectorError(
          'Slack bot token refresh failed unexpectedly.',
          REFRESH_TRANSIENT,
          'Retry the operation. If it continues to fail, re-authenticate via your MCP host application.',
          { sanitized_message: sanitizeErrorMessage(msg) },
        );
      } finally {
        this.botRefreshPromise = null;
      }
    })();
    return this.botRefreshPromise;
  }

  /**
   * Returns the current user token, refreshing if needed. Returns null if
   * no user token exists. User refresh failure is non-fatal for read paths
   * that fall back to the bot token (returns null), but auth-rejected
   * refreshes propagate so the host can surface auth_required for tools
   * that strictly require the user token.
   */
  async getUserToken(): Promise<string | null> {
    let tokens = this.cachedTokens ?? (await this.loadTokens());
    if (!tokens?.userToken) return null;

    if (!tokens.userRefreshToken) return tokens.userToken;

    if (!this.isExpired(tokens.userExpiresAt)) return tokens.userToken;

    const diskTokens = await this.loadTokens();
    if (diskTokens?.userToken && !this.isExpired(diskTokens.userExpiresAt)) {
      console.error('[slack-mcp] User token refreshed by another process, using disk token');
      return diskTokens.userToken;
    }

    if (isRefreshDisabled()) {
      throw new ConnectorError(
        'Slack user token expired and refresh is disabled on this surface.',
        TOKEN_EXPIRED_REFRESH_DISABLED,
        'Re-authenticate the Slack workspace via your MCP host application. The OS is the sole refresh authority for this MCP.',
      );
    }

    const refreshToken = diskTokens?.userRefreshToken ?? tokens.userRefreshToken;
    if (!refreshToken) return tokens.userToken;

    if (this.userRefreshPromise) return this.userRefreshPromise;

    logRefreshEvent('refresh_attempt', { teamId: this.teamId, tokenType: 'user' });
    this.userRefreshPromise = (async () => {
      try {
        const result = await this.refreshToken(refreshToken, 'user');
        const updated: SlackTokenData = {
          ...(diskTokens ?? tokens!),
          userToken: result.accessToken,
          userRefreshToken: result.refreshToken,
          userExpiresAt: result.expiresAt,
        };
        await this.saveTokens(updated);
        logRefreshEvent('refresh_success', {
          teamId: this.teamId,
          tokenType: 'user',
          outcomeCode: 'success',
        });
        return result.accessToken;
      } catch (err) {
        // Persistence failure: rotated tokens cached in memory; surface
        // distinctly (don't loadTokens() back to stale value).
        if (err instanceof ConnectorError && err.code === 'TOKEN_PERSIST_FAILED') {
          logRefreshEvent('refresh_failure', {
            teamId: this.teamId,
            tokenType: 'user',
            outcomeCode: 'success',
            message: 'rotated tokens cached in memory only (persist failed)',
          });
          throw err;
        }

        // Auth-rejected refreshes propagate so the host can dispatch
        // reauth via the auth_required shape; transient failures for the
        // user token are non-fatal for read fallbacks (return null).
        if (err instanceof ConnectorError) {
          logRefreshEvent('refresh_failure', {
            teamId: this.teamId,
            tokenType: 'user',
            outcomeCode: err.code as RefreshOutcomeCode,
            slackErrorCode: typeof err.extra?.slack_error_code === 'string' ? err.extra.slack_error_code : undefined,
            retryAfterSeconds: typeof err.extra?.retry_after_seconds === 'number' ? err.extra.retry_after_seconds : undefined,
            message: err.message,
          });
          if (err.code === REFRESH_AUTH_REJECTED) throw err;
          return null;
        }

        const msg = err instanceof Error ? err.message : String(err);
        logRefreshEvent('refresh_failure', {
          teamId: this.teamId,
          tokenType: 'user',
          outcomeCode: REFRESH_TRANSIENT,
          message: msg,
        });
        return null;
      } finally {
        this.userRefreshPromise = null;
      }
    })();
    return this.userRefreshPromise;
  }

  private async refreshToken(
    refreshToken: string,
    tokenType: 'bot' | 'user',
  ): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    // Compose cohort timeout into raw fetch so the request can never hang
    // indefinitely on a network stall (postmortem 260421 invariant).
    let response: Response;
    try {
      response = await globalThis.fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error / abort / DNS — transient. Keep the cached tokens;
      // caller may retry.
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConnectorError(
        `Slack ${tokenType} token refresh transient network error.`,
        REFRESH_TRANSIENT,
        'Retry the operation in a few seconds. If failures persist, check connectivity to slack.com.',
        { sanitized_message: sanitizeErrorMessage(msg) },
      );
    }

    if (!response.ok) {
      // HTTP-level failures: 429 → rate-limited; 5xx → transient; other → transient + body.
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch {
        // ignore — body unreadable
      }
      const sanitizedBody = sanitizeErrorMessage(bodyText).slice(0, 500);
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
        const extra: Record<string, unknown> = { http_status: 429 };
        if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
          extra.retry_after_seconds = retryAfterSeconds;
        }
        throw new ConnectorError(
          `Slack ${tokenType} token refresh rate-limited.`,
          REFRESH_RATE_LIMITED,
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? `Wait ${retryAfterSeconds} seconds before retrying.`
            : 'Wait a moment before retrying.',
          extra,
        );
      }
      if (response.status >= 500 && response.status <= 599) {
        throw new ConnectorError(
          `Slack ${tokenType} token refresh upstream error (HTTP ${response.status}).`,
          REFRESH_TRANSIENT,
          'Slack returned a server error. Retry the operation in a few seconds.',
          { http_status: response.status, body: sanitizedBody },
        );
      }
      throw new ConnectorError(
        `Slack ${tokenType} token refresh HTTP error (HTTP ${response.status}).`,
        REFRESH_TRANSIENT,
        'Retry the operation. If failures persist, re-authenticate via your MCP host application.',
        { http_status: response.status, body: sanitizedBody },
      );
    }

    let data: {
      ok?: boolean;
      error?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    try {
      data = (await response.json()) as typeof data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConnectorError(
        `Slack ${tokenType} token refresh returned non-JSON body.`,
        REFRESH_MALFORMED_RESPONSE,
        'Slack returned an unexpected response. Retry; if it persists, re-authenticate via your MCP host application.',
        { sanitized_message: sanitizeErrorMessage(msg) },
      );
    }

    if (data.ok === false) {
      const slackError = data.error ?? 'unknown';
      if (SLACK_REFRESH_AUTH_REJECTED_ERRORS.includes(slackError)) {
        throw new ConnectorError(
          `Slack ${tokenType} token refresh rejected by Slack: ${slackError}.`,
          REFRESH_AUTH_REJECTED,
          'Slack rejected the refresh token. Re-authenticate the Slack workspace via your MCP host application.',
          { slack_error_code: slackError },
        );
      }
      // Unknown Slack error code — treat as transient so we don't burn
      // tokens on a Slack-side transient outage; ops can investigate via
      // structured logs.
      throw new ConnectorError(
        `Slack ${tokenType} token refresh failed: ${slackError}.`,
        REFRESH_TRANSIENT,
        'Slack returned an error. Retry; if it persists, re-authenticate via your MCP host application.',
        { slack_error_code: slackError },
      );
    }

    if (!data.access_token) {
      throw new ConnectorError(
        `Slack ${tokenType} token refresh response missing access_token.`,
        REFRESH_MALFORMED_RESPONSE,
        'Slack returned an unexpected response. Re-authenticate via your MCP host application.',
        { ok: data.ok ?? false },
      );
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 43200) * 1000,
    };
  }

  private async saveTokens(tokens: SlackTokenData): Promise<void> {
    const tokenPath = this.getTokenPath();
    const dir = path.dirname(tokenPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Cache the rotated tokens FIRST so an in-progress write can never lose
    // the freshly-rotated single-use refresh token from memory if disk I/O
    // fails partway. The host process can keep using these in-memory tokens
    // for the lifetime of the process even if the disk write fails. The
    // refresh-path catch in getBotToken() / getUserToken() relies on this
    // ordering — do not move the assignment below the write.
    this.cachedTokens = tokens;

    // Atomic + durable write: temp file in the same directory, fsync the
    // file, rename to the final path, fsync the parent dir (POSIX). § 5.1
    // requires fsync because rename() returning is not enough — without
    // fsync a power loss between rename and journal commit can leave the
    // disk holding an empty/partial file.
    const tmpPath = `${tokenPath}.tmp.${process.pid}.${Date.now()}`;
    const payload = JSON.stringify(tokens, null, 2);
    try {
      // openSync(mode=0o600) creates the file with 0600 even on filesystems
      // that ignore the writeFileSync mode option.
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        // Loop until the entire payload is written. fs.writeSync(fd, string)
        // historically returns the number of bytes written and CAN short-write
        // on some platforms / signal interruptions. Looping is the safe pattern
        // — a short write that we ignore would leave a truncated-but-fsynced
        // file that survives the rename and surfaces as TOKEN_FILE_CORRUPT
        // on next load.
        const buf = Buffer.from(payload, 'utf8');
        let written = 0;
        while (written < buf.length) {
          const n = fs.writeSync(fd, buf, written, buf.length - written);
          if (n <= 0) {
            throw new Error(
              `writeSync returned ${n} after writing ${written}/${buf.length} bytes`,
            );
          }
          written += n;
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Belt-and-braces: openSync mode is usually honoured but some Node
      // versions / filesystems still benefit from an explicit chmod.
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch {
        // Best effort — Windows may reject chmod on some filesystems.
      }
      fs.renameSync(tmpPath, tokenPath);
      // MED-2: explicit chmod on the FINAL path. rename() preserves the
      // source mode, but if a tokenPath already exists from a prior buggy
      // write (or a host-side bundled connector wrote with a different
      // umask) its mode could leak through. Chmod after rename closes
      // that gap.
      try {
        fs.chmodSync(tokenPath, 0o600);
      } catch {
        // Windows: chmod on some filesystems is a no-op or unsupported.
      }
      // Optional: fsync the parent directory for full POSIX durability.
      // Windows does not support fsync(directory) — accept and continue.
      try {
        const dirFd = fs.openSync(dir, 'r');
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        // Windows or filesystem without dir-fsync — accept.
      }
    } catch (err) {
      // Best-effort cleanup of the temp file. Don't mask the original error.
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[slack-mcp] Token persist FAILED for team ${this.teamId} (tokens kept in memory only): ${sanitizeErrorMessage(msg)}`,
      );
      throw new ConnectorError(
        'Failed to persist refreshed Slack tokens to disk.',
        'TOKEN_PERSIST_FAILED',
        'Tokens are still cached in memory for this process. Retry the operation; the host can refresh persistently when disk access recovers.',
      );
    }
  }
}
