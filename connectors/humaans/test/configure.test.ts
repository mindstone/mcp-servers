import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createHumaansHandlers } from './helpers/humaans-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-humaans-key';

// The configure tool is a read-only status check: the key is set only by the
// host (Settings → Connectors, or HUMAANS_API_KEY), never as a tool argument.
describe('Humaans configure tool', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('takes no input and is annotated read-only', async () => {
    testClient = await createTestClient({ env: { HUMAANS_API_KEY: '' } });
    const { tools } = await testClient.client.listTools();
    const tool = tools.find((t) => t.name === 'configure_humaans_api_key');

    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties ?? {}).toEqual({});
    expect(tool?.inputSchema.required ?? []).toEqual([]);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.description).toContain('Settings → Connectors');
    expect(tool?.description).toContain('takes no token');
  });

  it('reports configured without echoing the token when one is set', async () => {
    testClient = await createTestClient({ env: { HUMAANS_API_KEY: API_KEY } });

    const result = await testClient.callTool('configure_humaans_api_key', {});
    expect(result.isError).toBeFalsy();
    const json = result.json as { ok: boolean; configured: boolean; message: string };
    expect(json).toMatchObject({ ok: true, configured: true });
    expect(result.text).not.toContain(API_KEY);
  });

  it('points to Settings → Connectors when no token is set', async () => {
    testClient = await createTestClient({ env: { HUMAANS_API_KEY: '' } });

    const result = await testClient.callTool('configure_humaans_api_key', {});
    expect(result.isError).toBeFalsy();
    const json = result.json as {
      ok: boolean;
      configured: boolean;
      next_step: { action: string; get_key_from: string; scopes: string };
    };
    expect(json).toMatchObject({ ok: true, configured: false });
    expect(json.next_step.action).toContain('Settings → Connectors');
    expect(json.next_step.action).toContain('Do not ask for the token in chat');
    expect(json.next_step.get_key_from).toBe('https://app.humaans.io/settings/home?tokens=1');
    expect(json.next_step.scopes).toContain('private:read');
  });

  it('ignores an api_key argument: it never sets the key', async () => {
    const PASTED_KEY = 'pasted-into-chat-key';
    mswServer.use(...createHumaansHandlers(PASTED_KEY));
    testClient = await createTestClient({ env: { HUMAANS_API_KEY: '' } });

    const configResult = await testClient.callTool('configure_humaans_api_key', {
      api_key: PASTED_KEY,
    });
    expect(configResult.text).not.toContain(PASTED_KEY);
    expect((configResult.json as { configured?: boolean }).configured).not.toBe(true);

    const after = await testClient.callTool('list_humaans_people', {});
    const afterJson = after.json as { ok: boolean; error: string; resolution: string };
    expect(afterJson.ok).toBe(false);
    expect(afterJson.error).toContain('not configured');
    expect(afterJson.resolution).toContain('Settings → Connectors');
  });
});
