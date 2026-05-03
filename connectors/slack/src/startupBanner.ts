/**
 * Startup mode banner — § 6.1 requires every connector to log auth mode +
 * env wiring at startup so operators can verify configuration without
 * running tools.
 *
 * Secrets MUST never appear in the banner — only env-presence flags, the
 * team ID, the path, and the token-source state. Even when the env var is
 * set, never echo `SLACK_CLIENT_SECRET` / token values.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SERVER_VERSION } from './types.js';

/**
 * Replace the user's home directory in a path with `~` so the banner
 * still gives operators useful diagnostic context (e.g. `~/.mcp/slack/...`)
 * without leaking the OS username if logs are shared / shipped off-host.
 */
function redactHomeDir(p: string): string {
  if (!p || p === '<unset>') return p;
  try {
    const home = os.homedir();
    if (home && p.startsWith(home + path.sep)) {
      return '~' + p.slice(home.length);
    }
    if (home && p === home) return '~';
  } catch {
    // os.homedir() may throw on minimal environments — fall through.
  }
  return p;
}

export interface StartupBannerFields {
  authMode: 'host_injected';
  version: string;
  teamId: string;
  configPath: string;
  refreshDisabled: boolean;
  tokenSource: 'disk' | 'missing';
}

function isRefreshDisabled(): boolean {
  const v = process.env.SLACK_DISABLE_REFRESH;
  if (!v) return false;
  return v !== '0' && v.toLowerCase() !== 'false';
}

function detectTokenSource(): 'disk' | 'missing' {
  const cfg = process.env.SLACK_CONFIG_PATH;
  const team = process.env.SLACK_TEAM_ID;
  if (!cfg || !team) return 'missing';
  try {
    const tokenFile = path.join(cfg, 'workspaces', `${team}.json`);
    return fs.existsSync(tokenFile) ? 'disk' : 'missing';
  } catch {
    return 'missing';
  }
}

export function getStartupBannerFields(): StartupBannerFields {
  return {
    authMode: 'host_injected',
    version: SERVER_VERSION,
    teamId: process.env.SLACK_TEAM_ID || '<unset>',
    configPath: process.env.SLACK_CONFIG_PATH || '<unset>',
    refreshDisabled: isRefreshDisabled(),
    tokenSource: detectTokenSource(),
  };
}

export function formatStartupBanner(fields: StartupBannerFields = getStartupBannerFields()): string {
  return (
    `[slack-mcp] auth_mode=${fields.authMode} ` +
    `version=${fields.version} ` +
    `team_id=${fields.teamId} ` +
    `config_path=${redactHomeDir(fields.configPath)} ` +
    `refresh_disabled=${fields.refreshDisabled} ` +
    `token_source=${fields.tokenSource}`
  );
}

export function logStartupBanner(): void {
  console.error(formatStartupBanner());
}
