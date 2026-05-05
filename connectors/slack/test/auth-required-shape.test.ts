import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createSlackHandlers } from './fixtures/slack-mock-api.js';
import { Stage0AuthRequiredSchema } from './fixtures/stage0-auth-schema.js';
import {
  createTestClient,
  createSlackConfigDir,
  type McpTestClient,
  type SlackTestConfig,
} from './fixtures/mcp-test-client.js';

describe('authenticate_slack_workspace returns the chief-designer auth_required shape', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  beforeAll(async () => {
    cfg = createSlackConfigDir(); // No tokens — exercise unauth flow
    client = await createTestClient({
      env: {
        SLACK_CLIENT_ID: 'mock-client-id',
        SLACK_CLIENT_SECRET: 'mock-client-secret',
        SLACK_TEAM_ID: 'T123',
        SLACK_CONFIG_PATH: cfg.configPath,
      },
    });
  });

  beforeEach(() => {
    mswServer.use(...createSlackHandlers());
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('emits structured auth_required with user_action, agent_action, setupToolName', async () => {
    const result = await client.callTool('authenticate_slack_workspace', {});
    const j = result.json as Record<string, unknown>;
    expect(j.status).toBe('auth_required');
    expect(j.user_action).toMatchObject({
      id: 'slack.connect_workspace',
      label: 'Connect Slack',
      instruction: expect.stringContaining('Connect Slack'),
    });
    expect(j.agent_action).toMatchObject({
      instruction: expect.stringContaining('Connect Slack'),
    });
    expect(j.setupToolName).toBe('authenticate_slack_workspace');
  });

  it('does NOT emit auth_url, status:auth_pending, or any /bundled/ vocabulary', async () => {
    const result = await client.callTool('authenticate_slack_workspace', {});
    const text = result.text;
    expect(text).not.toContain('auth_url');
    expect(text).not.toContain('auth_pending');
    expect(text).not.toContain('/bundled/');
    expect(text).not.toContain('BRIDGE_STATE');
    expect(text).not.toContain('restart_package');
  });

  it('parses cleanly against the Stage 0 host schema (zod structural check)', async () => {
    // Structural validation against a copy of host's AuthRequiredResponseSchema.
    // If the OSS response shape drifts from what the host expects, this will
    // fail with a clear zod error pointing at the mismatched field.
    const result = await client.callTool('authenticate_slack_workspace', {});
    const parsed = Stage0AuthRequiredSchema.safeParse(result.json);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true,
    );
  });
});
