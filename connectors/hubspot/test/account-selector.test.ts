import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createMcpTestClientWithMockApi,
  resolveServerScript,
  type McpTestClient,
  type MockApiServer
} from './fixtures/mcp-test-harness.js';

function createHubSpotConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'hubspot-account-selector-'));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({
      accounts: [{ email: 'test@example.com', hubId: 12345678 }]
    })
  );
  writeFileSync(
    join(configDir, 'credentials', 'test-example-com.token.json'),
    JSON.stringify({
      access_token: 'fake-access-token',
      refresh_token: 'fake-refresh-token',
      expires_at: Date.now() + 86_400_000,
      hub_id: 12345678,
      user: 'test@example.com'
    })
  );
  return configDir;
}

async function closeTestResources(
  client: McpTestClient | undefined,
  mockApi: MockApiServer | undefined,
  configDir: string | undefined
) {
  if (client) {
    await client.close();
  }
  if (mockApi) {
    await mockApi.close();
  }
  if (configDir) {
    rmSync(configDir, { recursive: true, force: true });
  }
}

describe('HUBSPOT_ACCOUNT_EMAIL selector', () => {
  it('returns auth_required when HUBSPOT_ACCOUNT_EMAIL is missing', async () => {
    let client: McpTestClient | undefined;
    let mockApi: MockApiServer | undefined;
    let configDir: string | undefined;

    try {
      configDir = createHubSpotConfigDir();
      const result = await createMcpTestClientWithMockApi({
        name: 'hubspot-account-selector-missing',
        serverScript: resolveServerScript('hubspot'),
        interceptDomains: ['api.hubapi.com'],
        routes: [
          {
            method: 'POST',
            path: '/crm/v3/objects/contacts/search',
            handler: () => ({ body: { results: [] } })
          }
        ],
        env: {
          HUBSPOT_CONFIG_DIR: configDir,
          HUBSPOT_CLIENT_ID: 'fake-client-id',
          HUBSPOT_CLIENT_SECRET: 'fake-client-secret'
        },
        connectTimeout: 15_000
      });

      client = result.client;
      mockApi = result.mockApi;

      const response = await client.callToolJson<Record<string, unknown>>('search_hubspot_contacts', { query: 'alice' });
      expect(response.status).toBe('auth_required');
      expect(response.setupToolName).toBe('authenticate_hubspot_account');
    } finally {
      await closeTestResources(client, mockApi, configDir);
    }
  });

  it('returns auth_required when HUBSPOT_ACCOUNT_EMAIL does not match accounts.json', async () => {
    let client: McpTestClient | undefined;
    let mockApi: MockApiServer | undefined;
    let configDir: string | undefined;

    try {
      configDir = createHubSpotConfigDir();
      const result = await createMcpTestClientWithMockApi({
        name: 'hubspot-account-selector-mismatch',
        serverScript: resolveServerScript('hubspot'),
        interceptDomains: ['api.hubapi.com'],
        routes: [
          {
            method: 'POST',
            path: '/crm/v3/objects/contacts/search',
            handler: () => ({ body: { results: [] } })
          }
        ],
        env: {
          HUBSPOT_CONFIG_DIR: configDir,
          HUBSPOT_CLIENT_ID: 'fake-client-id',
          HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
          HUBSPOT_ACCOUNT_EMAIL: 'mismatch@example.com'
        },
        connectTimeout: 15_000
      });

      client = result.client;
      mockApi = result.mockApi;

      const response = await client.callToolJson<Record<string, unknown>>('search_hubspot_contacts', { query: 'alice' });
      expect(response.status).toBe('auth_required');
      expect(response.setupToolName).toBe('authenticate_hubspot_account');
    } finally {
      await closeTestResources(client, mockApi, configDir);
    }
  });

  it('resolves the selected account when HUBSPOT_ACCOUNT_EMAIL matches', async () => {
    let client: McpTestClient | undefined;
    let mockApi: MockApiServer | undefined;
    let configDir: string | undefined;

    try {
      configDir = createHubSpotConfigDir();
      const result = await createMcpTestClientWithMockApi({
        name: 'hubspot-account-selector-match',
        serverScript: resolveServerScript('hubspot'),
        interceptDomains: ['api.hubapi.com'],
        routes: [
          {
            method: 'POST',
            path: '/crm/v3/objects/contacts/search',
            handler: () => ({
              body: {
                results: [
                  {
                    id: '101',
                    properties: {
                      email: 'alice@example.com',
                      firstname: 'Alice'
                    },
                    createdAt: '2026-01-01T00:00:00Z',
                    updatedAt: '2026-01-01T00:00:00Z',
                    archived: false
                  }
                ]
              }
            })
          }
        ],
        env: {
          HUBSPOT_CONFIG_DIR: configDir,
          HUBSPOT_CLIENT_ID: 'fake-client-id',
          HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
          HUBSPOT_ACCOUNT_EMAIL: 'test@example.com'
        },
        connectTimeout: 15_000
      });

      client = result.client;
      mockApi = result.mockApi;

      const response = await client.callToolJson<{ results: Array<{ id: string }> }>('search_hubspot_contacts', { query: 'alice' });
      expect(response.results).toHaveLength(1);
      expect(response.results[0].id).toBe('101');
    } finally {
      await closeTestResources(client, mockApi, configDir);
    }
  });
});
