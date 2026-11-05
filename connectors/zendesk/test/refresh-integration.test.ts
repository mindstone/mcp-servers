import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as fs from 'fs';
import * as path from 'path';
import { createTempConfig } from '@mindstone/mcp-test-harness';
import { mswServer } from './helpers/setup.js';
import { createZendeskHandlers } from './helpers/zendesk-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const SUB = 'oauthcorp';
const LARGEST_DATE_MS = 8_640_000_000_000_000;

function tokenFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'expired-access-token',
    refresh_token: 'expired-refresh-token',
    expires_in: 1800,
    expires_at: Date.now() - 60_000,
    token_type: 'bearer',
    subdomain: SUB,
    email: 'agent@oauthcorp.example.com',
    client_id: 'file-client-id',
    scope: 'read write',
    ...overrides,
  };
}

describe('Connector refresh through MCP tool calls', () => {
  let testClient: McpTestClient | undefined;
  let cleanup: (() => void) | undefined;
  let configPath: string;

  async function start(options: Parameters<typeof createTempConfig>[0]): Promise<McpTestClient> {
    const temp = createTempConfig({ prefix: 'zendesk-refresh-int-', ...options });
    cleanup = temp.cleanup;
    configPath = temp.configPath;
    testClient = await createTestClient({
      env: {
        ZENDESK_CONFIG_PATH: temp.configPath,
        MCP_HOST_BRIDGE_STATE: '',
        MINDSTONE_REBEL_BRIDGE_STATE: '',
        ZENDESK_CLIENT_ID: '',
        ZENDESK_CLIENT_SECRET: '',
      },
    });
    return testClient;
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mswServer.use(...createZendeskHandlers(SUB));
  });

  afterEach(async () => {
    await testClient?.close();
    testClient = undefined;
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('refreshes an expired sign-in and rotates the token file', async () => {
    const c = await start({
      empty: true,
      credentials: [{ filename: `${SUB}.token.json`, data: tokenFile() }],
    });

    const result = await c.callTool('search_zendesk_tickets', { query: 'status:open' });
    expect(result.isError).toBeFalsy();
    expect((result.json as { ok?: boolean } | null)?.ok).not.toBe(false);
    expect(result.text).toContain('Search results');

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(configPath, 'credentials', `${SUB}.token.json`), 'utf8'),
    );
    expect(onDisk.access_token).toBe('refreshed-access-token');
    expect(onDisk.refresh_token).toBe('refreshed-refresh-token');
    expect(onDisk.client_id).toBe('file-client-id');
  });

  it('turns a rejected refresh token into a reconnect message and status', async () => {
    mswServer.use(
      http.post(`https://${SUB}.zendesk.com/oauth/tokens`, () =>
        HttpResponse.json({ error: 'invalid_grant' }, { status: 400 })),
    );
    const c = await start({
      empty: true,
      credentials: [{ filename: `${SUB}.token.json`, data: tokenFile() }],
    });

    const result = await c.callTool('search_zendesk_tickets', { query: 'status:open' });
    const data = result.json as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.code).toBe('AUTH_FAILED');
    expect(String(data.resolution)).toContain('Reconnect Zendesk');

    const list = await c.callTool('list_zendesk_accounts', {});
    const listData = list.json as { ok: boolean; accounts: Array<{ status: string }> };
    expect(listData.ok).toBe(true);
    expect(listData.accounts[0].status).toBe('reconnect-required');
  });

  it('sends agents to the app to connect, not to the API-token tool', async () => {
    const c = await start({ empty: true });

    const result = await c.callTool('list_zendesk_accounts', {});
    const data = result.json as { ok: boolean; message: string };
    expect(data.ok).toBe(true);
    expect(data.message).toContain("sign in through your app's Zendesk connector settings");
    expect(data.message).not.toContain('authenticate_zendesk_account');

    const ticket = await c.callTool('get_zendesk_ticket', { ticket_id: 1 });
    const ticketData = ticket.json as { ok: boolean; resolution: string };
    expect(ticketData.ok).toBe(false);
    expect(ticketData.resolution).toContain("your app's Zendesk connector settings");
    expect(ticketData.resolution).not.toContain('authenticate_zendesk_account');

    const { tools } = await c.client.listTools();
    const listTool = tools.find(t => t.name === 'list_zendesk_accounts');
    expect(listTool?.description).toContain("sign in through your app's Zendesk connector settings");
    expect(listTool?.description).toContain('reconnect-required');
    expect(listTool?.description).not.toContain('authenticate_zendesk_account');
    expect(listTool?.description).not.toContain('recommended');
  });

  it('lists a non-expiring sign-in (largest valid date) without throwing (regression guard)', async () => {
    const c = await start({
      empty: true,
      credentials: [{
        filename: `${SUB}.token.json`,
        data: tokenFile({ expires_in: 0, expires_at: LARGEST_DATE_MS }),
      }],
    });

    const result = await c.callTool('list_zendesk_accounts', {});
    const data = result.json as { ok: boolean; accounts: Array<{ status: string; expiresAt?: string }> };
    expect(data.ok).toBe(true);
    expect(data.accounts[0].status).toBe('active');
    expect(data.accounts[0].expiresAt).toBe(new Date(LARGEST_DATE_MS).toISOString());
  });

  it('lists a sign-in whose expiry is missing without throwing', async () => {
    const c = await start({
      empty: true,
      credentials: [{
        filename: `${SUB}.token.json`,
        data: tokenFile({ expires_in: undefined, expires_at: undefined, client_id: undefined }),
      }],
    });

    const result = await c.callTool('list_zendesk_accounts', {});
    const data = result.json as { ok: boolean; accounts: Array<{ subdomain: string }> };
    expect(data.ok).toBe(true);
    expect(data.accounts[0].subdomain).toBe(SUB);
  });
});
