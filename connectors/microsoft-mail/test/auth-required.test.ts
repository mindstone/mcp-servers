import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

describe('authenticate_microsoft_account', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir();
    client = await createTestClient({
      env: {
        MS_CLIENT_ID: 'mock-client-id',
        MS_CONFIG_DIR: cfg.configPath,
      },
    });
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('emits structured auth_required with user_action, agent_action, setupToolName', async () => {
    const result = await client.callTool('authenticate_microsoft_account', {});
    expect(result.json).toMatchObject({
      status: 'auth_required',
      user_action: { id: 'microsoft.connect_account' },
      agent_action: {
        instruction: expect.stringContaining('Microsoft 365'),
      },
      setupToolName: 'authenticate_microsoft_account',
    });
  });

  it('does not emit auth_url or /bundled/ vocabulary', async () => {
    const result = await client.callTool('authenticate_microsoft_account', {});
    expect(result.text).not.toContain('auth_url');
    expect(result.text).not.toContain('authUrl');
    expect(result.text).not.toContain('/bundled/');
    expect(result.text).not.toContain('BRIDGE_STATE');
    expect(result.text).not.toContain('bridgeRequest');
    expect(result.text).not.toContain('restart_package');
  });
});
