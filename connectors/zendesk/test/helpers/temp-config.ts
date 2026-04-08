import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { makeAccountsJson, API_TOKEN_ACCOUNT } from '../fixtures/accounts.js';

export interface TempConfigOptions {
  /** Account configs to write to accounts.json. Defaults to [API_TOKEN_ACCOUNT]. */
  accounts?: Array<{ subdomain: string; email: string; apiToken?: string }>;
  /** Default subdomain for accounts.json */
  defaultSubdomain?: string;
  /** OAuth token files to create in credentials/ dir */
  oauthTokens?: Array<{
    subdomain: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    email?: string;
  }>;
  /** If true, create an empty config dir with no accounts.json */
  empty?: boolean;
}

export interface TempConfigResult {
  /** Absolute path to the temp config directory */
  configPath: string;
  /** Absolute path to a temp bridge state file (empty by default) */
  bridgeStatePath: string;
  /** Clean up the temp directory. Call in afterAll/afterEach. */
  cleanup: () => void;
}

/**
 * Creates a temporary config directory with accounts.json and optional credential files.
 * Mimics the real ~/.mcp/zendesk/ directory structure.
 */
export function createTempConfig(options: TempConfigOptions = {}): TempConfigResult {
  const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'zendesk-test-'));
  const bridgeStatePath = path.join(configPath, 'bridge-state.json');

  // Write empty bridge state (no bridge by default)
  fs.writeFileSync(bridgeStatePath, '', { mode: 0o600 });

  if (!options.empty) {
    const accounts = options.accounts ?? [API_TOKEN_ACCOUNT];
    const defaultSubdomain = options.defaultSubdomain ?? accounts[0]?.subdomain;
    const accountsJson = makeAccountsJson(accounts, defaultSubdomain);
    fs.writeFileSync(
      path.join(configPath, 'accounts.json'),
      JSON.stringify(accountsJson, null, 2),
      { mode: 0o600 },
    );
  }

  if (options.oauthTokens?.length) {
    const credDir = path.join(configPath, 'credentials');
    fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });

    for (const token of options.oauthTokens) {
      const tokenData = {
        access_token: token.accessToken,
        refresh_token: token.refreshToken ?? 'test-refresh-token',
        expires_in: 7200,
        expires_at: token.expiresAt ?? Date.now() + 7200_000,
        token_type: 'bearer',
        subdomain: token.subdomain,
        email: token.email ?? `agent@${token.subdomain}.example.com`,
      };
      fs.writeFileSync(
        path.join(credDir, `${token.subdomain}.token.json`),
        JSON.stringify(tokenData, null, 2),
        { mode: 0o600 },
      );
    }
  }

  const cleanup = () => {
    try {
      fs.rmSync(configPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  };

  return { configPath, bridgeStatePath, cleanup };
}
