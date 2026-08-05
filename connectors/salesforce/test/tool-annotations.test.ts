/**
 * Write-tool safety annotations (AGENTS.md invariant #7): every
 * production-impacting write tool MUST carry `destructiveHint: true` so the
 * host can gate it behind explicit approval; read tools stay non-destructive.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

import { mswServer } from './helpers/setup.js';
import { createSalesforceHandlers, MOCK_ACCESS_TOKEN, MOCK_INSTANCE_URL } from './helpers/salesforce-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';

function createConfigWithToken() {
  return createTempConfig({
    accounts: [{ id: 'test-user', username: 'test@example.com', connected_at: new Date().toISOString() }],
    credentials: [{
      filename: 'test-user.token.json',
      data: {
        access_token: MOCK_ACCESS_TOKEN,
        refresh_token: 'mock-refresh',
        instance_url: MOCK_INSTANCE_URL,
        expires_at: Date.now() + 3600_000,
        username: 'test@example.com',
      },
    }],
  });
}

describe('write-tool safety annotations (invariant #7)', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('every production-impacting write tool carries destructiveHint: true', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({
      env: {
        SALESFORCE_CLIENT_ID: 'mcp-test-client-id',
        SALESFORCE_CLIENT_SECRET: 'mcp-test-client-secret',
        SALESFORCE_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const { tools } = await testClient.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const WRITE_TOOLS = [
      'salesforce_create_account',
      'salesforce_update_account',
      'salesforce_create_contact',
      'salesforce_update_contact',
      'salesforce_create_lead',
      'salesforce_update_lead',
      'salesforce_convert_lead',
      'salesforce_create_opportunity',
      'salesforce_update_opportunity',
      'salesforce_create_task',
      'salesforce_update_task',
      'salesforce_create_case',
      'salesforce_update_case',
      'salesforce_create_event',
      'salesforce_create_note',
      'salesforce_create_record',
      'salesforce_update_record',
    ];
    for (const name of WRITE_TOOLS) {
      const tool = byName.get(name);
      expect(tool, `${name} should be registered`).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, `${name} must not claim readOnly`).toBe(false);
      expect(tool?.annotations?.destructiveHint, `${name} must be marked destructive`).toBe(true);
    }

    // Read tools keep their non-destructive annotation.
    const READ_TOOLS = ['salesforce_get_contacts', 'salesforce_search', 'salesforce_run_report', 'salesforce_get_notes'];
    for (const name of READ_TOOLS) {
      const tool = byName.get(name);
      expect(tool?.annotations?.readOnlyHint, `${name} must stay readOnly`).toBe(true);
      expect(tool?.annotations?.destructiveHint, `${name} must stay non-destructive`).toBe(false);
    }
  });
});
