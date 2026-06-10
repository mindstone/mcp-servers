/**
 * Slack WebClient factory + token resolution. Wraps `@slack/web-api`'s
 * WebClient with fresh tokens from the SlackTokenProvider on each access,
 * and (in test mode) substitutes a globalThis.fetch-based axios adapter so
 * MSW can intercept HTTP traffic.
 *
 * The clients are cached and only recreated when the underlying token
 * changes — this keeps connection pooling / retries effective in production.
 */

import { WebClient, type WebClientOptions } from '@slack/web-api';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConnectorError, MAX_RETRIES, REQUEST_TIMEOUT_MS, type SlackWorkspace } from './types.js';
import { SlackTokenProvider } from './tokenProvider.js';
import { sanitizeErrorMessage } from './utils.js';

const SLACK_CONFIG_PATH = process.env.SLACK_CONFIG_PATH;
const SLACK_TEAM_ID = process.env.SLACK_TEAM_ID;
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;

/**
 * Construct the token provider whenever the host has wired a config path AND a
 * team ID. OAuth client credentials (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`)
 * are intentionally NOT required here: they are only needed to REFRESH a
 * rotating token (see `SlackTokenProvider.refreshToken`). Non-rotating saved
 * tokens — the common host-injected case — authorize the Slack API directly,
 * so requiring client creds up front wrongly rejected valid saved tokens with
 * "Slack not connected" when the host had not injected them. When a
 * refresh IS required but client creds are absent, the provider throws a
 * structured `REFRESH_NO_CLIENT_CREDENTIALS` error so the host can dispatch
 * reauth instead of failing silently.
 *
 * An invalid team ID (e.g. `../../etc/passwd`) throws from the provider
 * constructor; we surface that via `getLastBotTokenError()` rather than
 * crashing the module load, so the server still starts and reports the
 * misconfiguration to the user.
 */
const tokenProviderOrError: { provider: SlackTokenProvider | null; error: string | null } = (() => {
  if (!SLACK_CONFIG_PATH || !SLACK_TEAM_ID) {
    return { provider: null, error: null };
  }
  try {
    const provider = new SlackTokenProvider(
      SLACK_CONFIG_PATH,
      SLACK_TEAM_ID,
      SLACK_CLIENT_ID ?? '',
      SLACK_CLIENT_SECRET ?? '',
    );
    return { provider, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const safe = sanitizeErrorMessage(msg);
    console.error(`[slack-mcp] SlackTokenProvider init failed: ${safe}`);
    return { provider: null, error: safe };
  }
})();

const tokenProvider = tokenProviderOrError.provider;

export function getTokenProvider(): SlackTokenProvider | null {
  return tokenProvider;
}

/**
 * Test-only axios adapter: forwards HTTP traffic through globalThis.fetch
 * so MSW can intercept it. Active only when `NODE_ENV === 'test'`.
 *
 * Honours the cohort upstream timeout via `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`
 * — axios's built-in `timeout` config is ignored when a custom adapter is in
 * play, so the adapter must enforce it explicitly. (Postmortem 260421.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const testFetchAdapter: ((config: any) => Promise<any>) | undefined =
  process.env.NODE_ENV === 'test'
    ? async (config) => {
        const rawUrl = config.url || '';
        const url = /^https?:\/\//.test(rawUrl) ? rawUrl : (config.baseURL || '') + rawUrl;
        const headers: Record<string, string> = {};
        if (config.headers) {
          const raw =
            typeof config.headers.toJSON === 'function' ? config.headers.toJSON() : config.headers;
          for (const [k, v] of Object.entries(raw)) {
            if (v != null && typeof v !== 'object') headers[k] = String(v);
          }
        }
        let body: BodyInit | undefined;
        if (config.data != null) {
          if (typeof config.data === 'string' || config.data instanceof URLSearchParams) {
            body = config.data;
          } else {
            body = typeof config.data === 'object' ? JSON.stringify(config.data) : String(config.data);
            if (!headers['Content-Type'] && !headers['content-type']) {
              headers['Content-Type'] = 'application/json';
            }
          }
        }
        const response = await globalThis.fetch(url, {
          method: (config.method || 'GET').toUpperCase(),
          headers,
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const responseData = await response.text();
        let data: unknown;
        try {
          data = JSON.parse(responseData);
        } catch {
          data = responseData;
        }
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((v: string, k: string) => {
          responseHeaders[k] = v;
        });
        return {
          data,
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          config,
          request: {},
        };
      }
    : undefined;

/**
 * WebClient options shared by every constructed client.
 *
 * `timeout` enforces the cohort upstream timeout invariant (postmortem
 * `260421_nano_banana_request_timeout_postmortem.md`). Passed via the
 * constructor so it covers EVERY method on the WebClient (chat.postMessage,
 * conversations.list, etc.) without per-call plumbing — axios uses this as
 * its request `timeout` and aborts on expiry.
 *
 * `retryConfig.retries` is bounded by `MAX_RETRIES` so a single timeout
 * doesn't fan out into the 30-minute default p-retry budget — important for
 * cloud (we want fail-fast) and for tests (we assert behaviour quickly).
 */
const baseClientOpts: WebClientOptions = {
  timeout: REQUEST_TIMEOUT_MS,
  retryConfig: { retries: MAX_RETRIES },
};

const clientOpts: WebClientOptions = testFetchAdapter
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ ...baseClientOpts, adapter: testFetchAdapter } as any)
  : baseClientOpts;

let _botClient: WebClient | null = null;
let _userClient: WebClient | null = null;
let _lastBotToken: string | null = null;
let _lastUserToken: string | null = null;
let _lastBotTokenError: string | null = tokenProviderOrError.error;

export function getLastBotTokenError(): string | null {
  return _lastBotTokenError;
}

/**
 * Resolve the bot WebClient. Returns null if no bot token is configured.
 * Throws ConnectorError when the token provider explicitly fails (e.g.
 * `TOKEN_EXPIRED_REFRESH_DISABLED`) — caller should let it propagate so
 * `withErrorHandling` converts it to the auth_required shape.
 */
export async function getSlackClient(): Promise<WebClient | null> {
  if (tokenProvider) {
    try {
      const token = await tokenProvider.getBotToken();
      _lastBotTokenError = null;
      if (token !== _lastBotToken) {
        _botClient = new WebClient(token, clientOpts);
        _lastBotToken = token;
      }
      return _botClient;
    } catch (err) {
      if (err instanceof ConnectorError) {
        _lastBotTokenError = err.message;
        throw err;
      }
      const rawMsg = err instanceof Error ? err.message : String(err);
      _lastBotTokenError = sanitizeErrorMessage(rawMsg);
      console.error(`[slack-mcp] Failed to resolve bot token: ${_lastBotTokenError}`);
      return null;
    }
  }
  return null;
}

/**
 * Resolve the user WebClient. Returns null if no user token is configured
 * or if refresh is disabled and the token has expired.
 */
export async function getSlackUserClient(): Promise<WebClient | null> {
  if (tokenProvider) {
    try {
      const token = await tokenProvider.getUserToken();
      if (!token) return null;
      if (token !== _lastUserToken) {
        _userClient = new WebClient(token, clientOpts);
        _lastUserToken = token;
      }
      return _userClient;
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      _lastUserToken = null;
      _userClient = null;
      const rawMsg = err instanceof Error ? err.message : String(err);
      console.error(`[slack-mcp] Failed to resolve user token: ${sanitizeErrorMessage(rawMsg)}`);
      return null;
    }
  }
  return null;
}

/**
 * Reader-preferring client: user token first (broader read access), bot
 * token fallback. Used by list/get tools.
 */
export async function getSlackReaderClient(): Promise<WebClient | null> {
  return (await getSlackUserClient()) ?? (await getSlackClient());
}

/**
 * Read the workspace metadata file (`config.json`) — written by the host
 * after a successful OAuth.
 *
 * Per § 5.3, surface distinct error states rather than collapsing every
 * read failure to "no workspaces":
 *   - SLACK_CONFIG_PATH unset: empty array (host hasn't wired the env yet)
 *   - ENOENT on config.json:  empty array (legitimately empty / fresh install)
 *   - EACCES / EPERM on config dir: throw `WORKSPACE_DIR_PERMISSION_DENIED`
 *   - corrupt config.json (parse fail): throw `WORKSPACE_DIR_ALL_CORRUPT`
 *   - any other read error: throw `WORKSPACE_DIR_PERMISSION_DENIED`
 *     (treated as an operational issue — fail-loud rather than mask)
 */
export function getWorkspaces(): SlackWorkspace[] {
  if (!SLACK_CONFIG_PATH) return [];
  const configPath = path.join(SLACK_CONFIG_PATH, 'config.json');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return [];
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ConnectorError(
        'Slack workspace config directory is not readable by this process.',
        'WORKSPACE_DIR_PERMISSION_DENIED',
        'Verify the host has read permission on the Slack config directory. Reconnect via your MCP host application if the directory is missing.',
        { path: configPath },
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConnectorError(
      `Failed to read Slack workspace config: ${sanitizeErrorMessage(msg)}`,
      'WORKSPACE_DIR_PERMISSION_DENIED',
      'Inspect the Slack config directory; reconnect via your MCP host application if the issue persists.',
      { path: configPath },
    );
  }

  let parsed: { workspaces?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConnectorError(
      `Slack workspace config is not valid JSON: ${sanitizeErrorMessage(msg)}`,
      'WORKSPACE_DIR_ALL_CORRUPT',
      'The workspace config is corrupt. Re-authenticate the Slack workspace via your MCP host application to rewrite it.',
      { path: configPath },
    );
  }
  const workspaces = Array.isArray(parsed.workspaces) ? (parsed.workspaces as SlackWorkspace[]) : [];

  // Skip individual workspace token files that are corrupt or unreadable
  // but DO surface the readable ones. If ALL workspaces are corrupt
  // throw WORKSPACE_DIR_ALL_CORRUPT — the user has no usable state.
  if (workspaces.length === 0) return [];
  const wsDir = path.join(SLACK_CONFIG_PATH, 'workspaces');
  let wsDirExists = false;
  try {
    wsDirExists = fs.existsSync(wsDir);
  } catch {
    wsDirExists = false;
  }
  if (!wsDirExists) return workspaces;

  const readable: SlackWorkspace[] = [];
  let corruptCount = 0;
  for (const ws of workspaces) {
    if (!ws?.teamId) continue;
    const tokenFile = path.join(wsDir, `${ws.teamId}.json`);
    try {
      // We only need to verify readability + parseability, not the actual
      // token contents — the tokens are read lazily via SlackTokenProvider.
      if (!fs.existsSync(tokenFile)) {
        readable.push(ws);
        continue;
      }
      const data = fs.readFileSync(tokenFile, 'utf-8');
      JSON.parse(data);
      readable.push(ws);
    } catch (err) {
      corruptCount++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[slack-mcp] Skipping unreadable workspace token file for team=${ws.teamId}: ${sanitizeErrorMessage(msg)}`,
      );
    }
  }
  if (readable.length === 0 && corruptCount > 0) {
    throw new ConnectorError(
      'All Slack workspace token files are corrupt or unreadable.',
      'WORKSPACE_DIR_ALL_CORRUPT',
      'Re-authenticate the Slack workspace via your MCP host application to rewrite the token files.',
      { configPath: SLACK_CONFIG_PATH, corruptCount },
    );
  }
  return readable;
}

/** Reset module-level cache. Test-only — call between vi.resetModules() runs
 *  to ensure clients pick up the new env. */
export function _resetClientCache(): void {
  _botClient = null;
  _userClient = null;
  _lastBotToken = null;
  _lastUserToken = null;
  _lastBotTokenError = null;
}
