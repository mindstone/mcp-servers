import {
  createInMemoryTestClient,
  createTempConfig,
  type CallToolResult,
  type McpTestClient,
  type TempConfigResult,
} from '@mindstone/mcp-test-harness';
import { vi } from 'vitest';

export type { CallToolResult, McpTestClient };

export interface TestClientOptions {
  env?: Record<string, string>;
}

export interface MicrosoftTestConfig extends TempConfigResult {
  accountEmail: string;
  sanitisedEmail: string;
}

export async function createTestClient(
  options: TestClientOptions = {},
): Promise<McpTestClient> {
  const env = { NODE_ENV: 'test', ...(options.env ?? {}) };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  vi.resetModules();
  const { createServer } = await import('../../src/server.js');
  return createInMemoryTestClient({ createServer });
}

export interface MicrosoftConfigOptions {
  accountEmail?: string;
  expiresAt?: number;
  refreshToken?: string | null;
  accessToken?: string;
  scope?: string;
}

export function createMicrosoftConfigDir(
  options: MicrosoftConfigOptions = {},
): MicrosoftTestConfig {
  const accountEmail = options.accountEmail ?? 'user@example.com';
  const sanitisedEmail = accountEmail.replace(/[^a-zA-Z0-9]/g, '-');
  const accessToken = options.accessToken ?? 'test-access-token';
  const expiresAt = options.expiresAt ?? Date.now() + 60 * 60 * 1000;
  const refreshToken = options.refreshToken;
  const scope =
    options.scope ??
    'Chat.Read Chat.ReadWrite Channel.ReadBasic.All ChannelMessage.Read.All ChannelMessage.Send User.ReadBasic.All Presence.Read.All Presence.ReadWrite offline_access';

  const tempConfig = createTempConfig({
    prefix: 'microsoft-teams-mcp-test-',
    accounts: [{ email: accountEmail, displayName: 'Test User' }],
    credentials: [
      {
        filename: `${sanitisedEmail}.token.json`,
        data: {
          access_token: accessToken,
          ...(refreshToken === null ? {} : { refresh_token: refreshToken ?? 'test-refresh-token' }),
          expires_at: expiresAt,
          token_type: 'Bearer',
          scope,
        },
      },
    ],
  });

  return {
    ...tempConfig,
    accountEmail,
    sanitisedEmail,
  };
}
