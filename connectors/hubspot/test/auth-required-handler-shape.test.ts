import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createMcpTestClientWithMockApi,
  resolveServerScript,
  type McpTestClient,
  type MockApiServer,
} from './fixtures/mcp-test-harness.js';

function createExpiredTokenConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'hubspot-auth-required-shape-'));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });

  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({
      accounts: [{ email: 'test@example.com', hubId: 12345678 }],
    }),
  );

  writeFileSync(
    join(configDir, 'credentials', 'test-example-com.token.json'),
    JSON.stringify({
      access_token: 'expired-access-token',
      refresh_token: 'expired-refresh-token',
      expires_at: Date.now() - 60_000,
      hub_id: 12345678,
      user: 'test@example.com',
      schemaVersion: 1,
    }),
  );

  return configDir;
}

function parseToolPayload(result: CallToolResult): unknown {
  const textContent = result.content.find(
    (content): content is { type: 'text'; text: string } => content.type === 'text',
  );
  if (!textContent) {
    throw new Error('Expected text tool content');
  }
  return JSON.parse(textContent.text);
}

function assertAuthRequiredPayload(payload: unknown): void {
  expect(payload).toMatchObject({
    status: 'auth_required',
    user_action: { id: 'hubspot.connect_account' },
    setupToolName: 'authenticate_hubspot_account',
  });
  expect((payload as { errorCode?: string }).errorCode).not.toBe('UNKNOWN_ERROR');
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain('details');
  expect(serialized).not.toContain('expired-access-token');
  expect(serialized).not.toContain('expired-refresh-token');
}

describe('auth_required error shape from handler catch paths', () => {
  let configDir: string;
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    configDir = createExpiredTokenConfigDir();

    const setup = await createMcpTestClientWithMockApi({
      name: 'hubspot',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        {
          method: 'POST',
          path: '/oauth/v1/token',
          handler: () => ({
            status: 400,
            body: { error: 'invalid_grant' },
          }),
        },
      ],
      env: {
        HUBSPOT_CONFIG_DIR: configDir,
        HUBSPOT_CLIENT_ID: 'client-id',
        HUBSPOT_CLIENT_SECRET: 'client-secret',
        HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
      },
    });

    client = setup.client;
    mockApi = setup.mockApi;
  });

  afterAll(async () => {
    await client.close();
    await mockApi.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('CRM tool returns structured auth_required (not UNKNOWN_ERROR)', async () => {
    const raw = await client.callToolRaw('search_hubspot_contacts', {});
    expect(raw.isError).toBe(true);
    assertAuthRequiredPayload(parseToolPayload(raw));
  });

  it('Files tool returns structured auth_required (not UNKNOWN_ERROR)', async () => {
    const raw = await client.callToolRaw('get_hubspot_file', { fileId: '123' });
    expect(raw.isError).toBe(true);
    assertAuthRequiredPayload(parseToolPayload(raw));
  });

  it('Marketing tool returns structured auth_required (not UNKNOWN_ERROR)', async () => {
    const raw = await client.callToolRaw('list_hubspot_forms', {});
    expect(raw.isError).toBe(true);
    assertAuthRequiredPayload(parseToolPayload(raw));
  });
});
