import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createMcpTestClient,
  createMcpTestClientWithMockApi,
  resolveServerScript,
  type McpTestClient,
  type MockApiServer,
} from './fixtures/mcp-test-harness.js';

const CONFIGURED_EMAIL = 'test@example.com';
const TEST_TELEMETRY_SALT_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function createHubSpotConfigDir(opts: { expired: boolean }): string {
  const configDir = mkdtempSync(join(tmpdir(), 'hubspot-m1-gate-'));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({
      accounts: [{ email: CONFIGURED_EMAIL, hubId: 12345678 }],
    }),
  );
  writeFileSync(
    join(configDir, 'credentials', 'test-example-com.token.json'),
    JSON.stringify({
      access_token: opts.expired ? 'expired-access-token' : 'valid-access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + (opts.expired ? -60_000 : 86_400_000),
      hub_id: 12345678,
      user: CONFIGURED_EMAIL,
      schemaVersion: 1,
    }),
  );
  return configDir;
}

async function closeResources(
  client: McpTestClient | undefined,
  mockApi: MockApiServer | undefined,
  configDir: string | undefined,
): Promise<void> {
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

describe('requiresAuth gate without OAuth client credentials', () => {
  it('allows non-refresh API calls when a configured account has a valid token but client_secret is unset', async () => {
    let client: McpTestClient | undefined;
    let mockApi: MockApiServer | undefined;
    let configDir: string | undefined;

    try {
      configDir = createHubSpotConfigDir({ expired: false });
      const setup = await createMcpTestClientWithMockApi({
        name: 'hubspot-m1-valid-token-no-secret',
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
                    properties: { email: 'alice@example.com', firstname: 'Alice' },
                    createdAt: '2026-01-01T00:00:00Z',
                    updatedAt: '2026-01-01T00:00:00Z',
                    archived: false,
                  },
                ],
              },
            }),
          },
        ],
        env: {
          HUBSPOT_CONFIG_DIR: configDir,
          HUBSPOT_CLIENT_ID: 'client-id',
          HUBSPOT_ACCOUNT_EMAIL: CONFIGURED_EMAIL,
          HUBSPOT_TELEMETRY_SALT: TEST_TELEMETRY_SALT_HEX,
        },
        connectTimeout: 15_000,
      });
      client = setup.client;
      mockApi = setup.mockApi;

      const response = await client.callToolJson<{ results: Array<{ id: string }> }>(
        'search_hubspot_contacts',
        { query: 'alice' },
      );

      expect(response.results).toHaveLength(1);
      expect(response.results[0].id).toBe('101');
    } finally {
      await closeResources(client, mockApi, configDir);
    }
  });

  it('returns auth_required with REFRESH_NO_CLIENT_CREDS when an expired token needs refresh without client_secret', async () => {
    let client: McpTestClient | undefined;
    let mockApi: MockApiServer | undefined;
    let configDir: string | undefined;

    try {
      configDir = createHubSpotConfigDir({ expired: true });
      const setup = await createMcpTestClientWithMockApi({
        name: 'hubspot-m1-expired-token-no-secret',
        serverScript: resolveServerScript('hubspot'),
        interceptDomains: ['api.hubapi.com'],
        routes: [],
        env: {
          HUBSPOT_CONFIG_DIR: configDir,
          HUBSPOT_CLIENT_ID: 'client-id',
          HUBSPOT_ACCOUNT_EMAIL: CONFIGURED_EMAIL,
          HUBSPOT_TELEMETRY_SALT: TEST_TELEMETRY_SALT_HEX,
        },
        connectTimeout: 15_000,
      });
      client = setup.client;
      mockApi = setup.mockApi;

      const response = await client.callToolJson<Record<string, unknown>>(
        'search_hubspot_contacts',
        { query: 'alice' },
      );

      expect(response).toMatchObject({
        status: 'auth_required',
        errorCode: 'REFRESH_NO_CLIENT_CREDS',
        setupToolName: 'authenticate_hubspot_account',
      });
      expect(mockApi.requestLog).toHaveLength(0);
    } finally {
      await closeResources(client, mockApi, configDir);
    }
  });

  it.each([
    ['search_hubspot_calls', {}],
    ['search_hubspot_meetings', {}],
  ])(
    'returns auth_required with REFRESH_NO_CLIENT_CREDS for %s when token refresh is needed and client_secret is missing',
    async (toolName, args) => {
      let client: McpTestClient | undefined;
      let mockApi: MockApiServer | undefined;
      let configDir: string | undefined;

      try {
        configDir = createHubSpotConfigDir({ expired: true });
        const setup = await createMcpTestClientWithMockApi({
          name: `hubspot-m1-${toolName}-expired-token-no-secret`,
          serverScript: resolveServerScript('hubspot'),
          interceptDomains: ['api.hubapi.com'],
          routes: [],
          env: {
            HUBSPOT_CONFIG_DIR: configDir,
            HUBSPOT_CLIENT_ID: 'client-id',
            HUBSPOT_ACCOUNT_EMAIL: CONFIGURED_EMAIL,
            HUBSPOT_TELEMETRY_SALT: TEST_TELEMETRY_SALT_HEX,
          },
          connectTimeout: 15_000,
        });
        client = setup.client;
        mockApi = setup.mockApi;

        const response = await client.callToolJson<Record<string, unknown>>(
          toolName,
          args,
        );

        expect(response).toMatchObject({
          status: 'auth_required',
          errorCode: 'REFRESH_NO_CLIENT_CREDS',
          setupToolName: 'authenticate_hubspot_account',
        });
        expect(mockApi.requestLog).toHaveLength(0);
      } finally {
        await closeResources(client, mockApi, configDir);
      }
    },
  );

  it('keeps foreign-account removal rejected after the dispatcher gate loosening', async () => {
    let client: McpTestClient | undefined;
    let configDir: string | undefined;

    try {
      configDir = createHubSpotConfigDir({ expired: false });
      client = await createMcpTestClient({
        name: 'hubspot-m1-remove-foreign',
        serverScript: resolveServerScript('hubspot'),
        env: {
          HUBSPOT_CONFIG_DIR: configDir,
          HUBSPOT_CLIENT_ID: 'client-id',
          HUBSPOT_CLIENT_SECRET: 'client-secret',
          HUBSPOT_ACCOUNT_EMAIL: CONFIGURED_EMAIL,
          HUBSPOT_TELEMETRY_SALT: TEST_TELEMETRY_SALT_HEX,
        },
        connectTimeout: 15_000,
      });

      const response = await client.callToolJson<Record<string, unknown>>(
        'remove_hubspot_account',
        { email: 'foreign@example.com' },
      );

      expect(response).toMatchObject({
        status: 'error',
        errorCode: 'WRONG_ACCOUNT',
      });
    } finally {
      await closeResources(client, undefined, configDir);
    }
  });
});
