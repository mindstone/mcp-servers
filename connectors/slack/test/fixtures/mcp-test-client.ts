import {
  createInMemoryTestClient,
  type McpTestClient,
  type CallToolResult,
} from '@mindstone/mcp-test-harness';
import { vi } from 'vitest';

export type { McpTestClient, CallToolResult };

export interface TestClientOptions {
  env?: Record<string, string>;
}

export async function createTestClient(options: TestClientOptions = {}): Promise<McpTestClient> {
  const env = { NODE_ENV: 'test', ...(options.env ?? {}) };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  vi.resetModules();
  const { createServer } = await import('../../src/server.js');
  return createInMemoryTestClient({ createServer });
}

/**
 * Build a workspace config dir layout matching what the desktop
 * `slackAuthService` writes:
 *   - {configPath}/config.json     ({ workspaces: [...] })
 *   - {configPath}/workspaces/{teamId}.json   (token data, mode 0600)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SlackTestConfig {
  configPath: string;
  cleanup: () => void;
}

export function createSlackConfigDir(opts?: {
  teamId?: string;
  teamName?: string;
  tokens?: {
    botToken: string;
    userToken?: string;
    botRefreshToken?: string;
    botExpiresAt?: number;
    userRefreshToken?: string;
    userExpiresAt?: number;
    botUserId?: string;
    botUsername?: string;
    authedUserId?: string;
  } | null;
}): SlackTestConfig {
  const teamId = opts?.teamId ?? 'T123';
  const teamName = opts?.teamName ?? 'Test Workspace';
  const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-test-'));
  fs.writeFileSync(
    path.join(configPath, 'config.json'),
    JSON.stringify(
      {
        workspaces: [{ teamId, teamName, authedAt: new Date().toISOString() }],
      },
      null,
      2,
    ),
  );
  if (opts?.tokens) {
    const wsDir = path.join(configPath, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(wsDir, `${teamId}.json`),
      JSON.stringify(
        {
          botToken: opts.tokens.botToken,
          userToken: opts.tokens.userToken ?? 'xoxp-mock-user-token',
          botUserId: opts.tokens.botUserId ?? 'U999BOT',
          botUsername: opts.tokens.botUsername ?? 'slack-bot',
          authedUserId: opts.tokens.authedUserId ?? 'U123',
          botRefreshToken: opts.tokens.botRefreshToken,
          botExpiresAt: opts.tokens.botExpiresAt,
          userRefreshToken: opts.tokens.userRefreshToken,
          userExpiresAt: opts.tokens.userExpiresAt,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  return {
    configPath,
    cleanup: () => {
      fs.rmSync(configPath, { recursive: true, force: true });
    },
  };
}
