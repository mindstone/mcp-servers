import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createMixmaxHandlers } from './helpers/mixmax-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_TOKEN = 'test-mixmax-token';

describe('Mixmax meeting types and user tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup(opts?: { token?: string }) {
    mswServer.use(...createMixmaxHandlers(opts?.token ?? API_TOKEN));
    testClient = await createTestClient({
      env: {
        MIXMAX_API_TOKEN: opts?.token ?? API_TOKEN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  it('list_mixmax_meeting_types returns meeting types', async () => {
    await setup();
    const result = await testClient.callTool('list_mixmax_meeting_types', {});
    const json = result.json as {
      ok: boolean;
      meetingTypes: Array<{ name: string; durationMin: number }>;
      count: number;
    };

    expect(json.ok).toBe(true);
    expect(json.meetingTypes).toHaveLength(2);
    expect(json.count).toBe(2);
    expect(json.meetingTypes[0].name).toBe(
      '<untrusted-content source="mixmax:meetingtype.name">30 min intro call</untrusted-content>',
    );
    expect(json.meetingTypes[0].durationMin).toBe(30);
  });

  it('get_mixmax_user returns user profile', async () => {
    await setup();
    const result = await testClient.callTool('get_mixmax_user', {});
    const json = result.json as {
      ok: boolean;
      user: { name: string; email: string; plan: string };
    };

    expect(json.ok).toBe(true);
    expect(json.user.name).toBe(
      '<untrusted-content source="mixmax:user.name">Test User</untrusted-content>',
    );
    expect(json.user.email).toBe(
      '<untrusted-content source="mixmax:user.email">testuser@acme.com</untrusted-content>',
    );
    expect(json.user.plan).toBe(
      '<untrusted-content source="mixmax:user.plan">Growth</untrusted-content>',
    );
  });

  it('returns not-configured error for meeting types when no API token', async () => {
    mswServer.use(...createMixmaxHandlers());
    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_mixmax_meeting_types', {});
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });

  it('returns not-configured error for user when no API token', async () => {
    mswServer.use(...createMixmaxHandlers());
    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_mixmax_user', {});
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });
});
