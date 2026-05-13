import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createMcpTestClientWithMockApi,
  resolveServerScript,
  type McpTestClient,
  type MockApiServer,
} from './fixtures/mcp-test-harness.js';

const CONFIGURED_EMAIL = 'a.b@example.com';
const COLLIDING_EMAIL = 'a-b@example.com';
const TEST_TELEMETRY_SALT_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function createCollisionConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'hubspot-c3-enforcement-'));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({
      accounts: [
        { email: CONFIGURED_EMAIL, hubId: 101 },
        { email: COLLIDING_EMAIL, hubId: 202 },
      ],
    }),
  );

  // Legacy token shape (no `user` field) that would previously pass auth gate.
  writeFileSync(
    join(configDir, 'credentials', 'a-b-example-com.token.json'),
    JSON.stringify({
      access_token: 'legacy-colliding-access-token',
      refresh_token: 'legacy-colliding-refresh-token',
      expires_at: Date.now() + 86_400_000,
      hub_id: 101,
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

describe('C3 collision enforcement', () => {
  it('short-circuits to auth_required for configured colliding account even with legacy token files', async () => {
    let client: McpTestClient | undefined;
    let mockApi: MockApiServer | undefined;
    let configDir: string | undefined;

    try {
      configDir = createCollisionConfigDir();
      const setup = await createMcpTestClientWithMockApi({
        name: 'hubspot-c3-collision-auth-gate',
        serverScript: resolveServerScript('hubspot'),
        interceptDomains: ['api.hubapi.com'],
        routes: [
          {
            method: 'POST',
            path: '/crm/v3/objects/contacts/search',
            handler: () => ({
              body: { results: [{ id: 'should-not-be-called' }] },
            }),
          },
        ],
        env: {
          HUBSPOT_CONFIG_DIR: configDir,
          HUBSPOT_ACCOUNT_EMAIL: CONFIGURED_EMAIL,
          HUBSPOT_CLIENT_ID: 'client-id',
          HUBSPOT_CLIENT_SECRET: 'client-secret',
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
        setupToolName: 'authenticate_hubspot_account',
      });
      expect(mockApi.requestLog).toHaveLength(0);
    } finally {
      await closeResources(client, mockApi, configDir);
    }
  });
});
