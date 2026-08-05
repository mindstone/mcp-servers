import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createMixmaxHandlers } from './helpers/mixmax-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_TOKEN = 'test-mixmax-token';

describe('Mixmax security — destructiveHint annotations (M3.8)', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('VAL-MIXMAX-001 — add_mixmax_sequence_recipients has destructiveHint: true', async () => {
    mswServer.use(...createMixmaxHandlers(API_TOKEN));
    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    const toolsResult = await testClient.client.listTools();
    const tool = toolsResult.tools.find((t) => t.name === 'add_mixmax_sequence_recipients');
    expect(tool, 'add_mixmax_sequence_recipients tool must be registered').toBeDefined();
    expect(tool!.annotations?.destructiveHint).toBe(true);
  });

  it('VAL-MIXMAX-002 — production-impacting write tools have destructiveHint: true', async () => {
    mswServer.use(...createMixmaxHandlers(API_TOKEN));
    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    const toolsResult = await testClient.client.listTools();
    for (const name of [
      'remove_mixmax_sequence_recipients',
      'cancel_mixmax_message',
      'send_mixmax_email',
      'send_mixmax_snippet',
    ]) {
      const tool = toolsResult.tools.find((t) => t.name === name);
      expect(tool, `${name} tool must be registered`).toBeDefined();
      expect(
        tool!.annotations?.destructiveHint,
        `${name} must have destructiveHint:true`,
      ).toBe(true);
    }
  });

  it('VAL-MIXMAX-101 — read-only mixmax tools keep destructiveHint: false', async () => {
    mswServer.use(...createMixmaxHandlers(API_TOKEN));
    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    const toolsResult = await testClient.client.listTools();

    // Read-only tools by intent: list_*, get_*. These must NOT be flagged destructive.
    const readOnlyTools = toolsResult.tools.filter(
      (t) => t.name.startsWith('list_') || t.name.startsWith('get_'),
    );
    expect(readOnlyTools.length).toBeGreaterThan(0);

    for (const tool of readOnlyTools) {
      expect(
        tool.annotations?.destructiveHint,
        `read-only tool ${tool.name} must have destructiveHint:false`,
      ).toBe(false);
    }
  });
});
