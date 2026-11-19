import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

export const TOOL_CALL_EMAIL = 'user@example.com';

const SCOPES = [
  'https://mail.google.com/', 'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar',
].join(' ');

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

let directory: string | undefined;

/** A real server over a temp account, for calling tools end to end through msw. */
export async function loadToolServer(): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolResult>> {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-tool-call-'));
  const credentials = path.join(directory, 'credentials');
  fs.mkdirSync(credentials);
  fs.writeFileSync(path.join(directory, 'accounts.json'), JSON.stringify({
    accounts: [{ email: TOOL_CALL_EMAIL, category: 'work' }],
  }));
  fs.writeFileSync(path.join(credentials, 'user-example-com.token.json'), JSON.stringify({
    access_token: 'test-access-token', refresh_token: 'test-refresh-token',
    expiry_date: Date.now() + 3_600_000, scope: SCOPES,
  }));
  vi.stubEnv('ACCOUNTS_PATH', path.join(directory, 'accounts.json'));
  vi.stubEnv('CREDENTIALS_PATH', credentials);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
  vi.stubEnv('MCP_WORKSPACE_PATH', directory);
  vi.resetModules();
  const { initializeAllServices } = await import('../../src/utils/service-initializer.js');
  await initializeAllServices();
  const { GSuiteServer } = await import('../../src/tools/server.js');
  const server = new GSuiteServer() as unknown as {
    server: { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<ToolResult>> };
  };
  return async (name, args) => {
    const handler = server.server._requestHandlers.get('tools/call')!;
    return handler({ method: 'tools/call', params: { name, arguments: { email: TOOL_CALL_EMAIL, ...args } } }, {});
  };
}

export function cleanupToolServer(): void {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
}
