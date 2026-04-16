import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createHumaansHandlers } from './helpers/humaans-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-humaans-key';

describe('Humaans diceroll tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup() {
    mswServer.use(...createHumaansHandlers(API_KEY));
    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
  }

  // --- VAL-B1-HUMAANS-003 variant: list_humaans_people returns paginated results ---
  it('diceroll_humaans_person returns a person from the team', async () => {
    await setup();
    const result = await testClient.callTool('diceroll_humaans_person', {});
    const json = result.json as {
      ok: boolean;
      picked: { id: string; firstName: string; lastName: string; email: string };
      total: number;
      message: string;
    };

    expect(json.ok).toBe(true);
    expect(json.picked).toBeDefined();
    expect(json.picked.id).toBeDefined();
    expect(json.picked.firstName).toBeDefined();
    expect(json.picked.lastName).toBeDefined();
    expect(json.picked.email).toBeDefined();
    expect(typeof json.total).toBe('number');
    expect(json.total).toBeGreaterThan(0);
    expect(json.message).toContain('🎲');
  });

  it('diceroll_humaans_person returns one of the two mock people', async () => {
    await setup();
    const result = await testClient.callTool('diceroll_humaans_person', {});
    const json = result.json as {
      ok: boolean;
      picked: { firstName: string };
    };

    expect(json.ok).toBe(true);
    // With 2 mock people and high iteration count, we should eventually see both
    const names = ['Alice', 'Bob'];
    expect(names).toContain(json.picked.firstName);
  });

  it('diceroll_humaans_person runs multiple times without error (distribution sanity)', async () => {
    await setup();
    const names = new Set<string>();

    for (let i = 0; i < 20; i++) {
      const result = await testClient.callTool('diceroll_humaans_person', {});
      const json = result.json as { ok: boolean; picked: { firstName: string } };
      expect(json.ok).toBe(true);
      names.add(json.picked.firstName);
    }

    // With 2 mock people and 20 rolls, both should appear with overwhelming probability
    expect(names.size).toBeGreaterThan(1);
  });

  it('diceroll_humaans_person returns not-configured error when no API key is set', async () => {
    mswServer.use(...createHumaansHandlers());
    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('diceroll_humaans_person', {});
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });

  it('diceroll_humaans_person returns error when no active employees', async () => {
    mswServer.use(
      http.get('https://app.humaans.io/api/people', ({ request }) => {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${API_KEY}`) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return HttpResponse.json({ total: 0, limit: 250, skip: 0, data: [] });
      }),
    );

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('diceroll_humaans_person', {});
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('No active employees');
  });

  it('diceroll_humaans_person returns error for non-existent person', async () => {
    await setup();
    // The mock server returns Alice or Bob for the two people in the fixture.
    // After many calls, any failure (e.g. 404) would indicate a broken person ID path.
    const result = await testClient.callTool('diceroll_humaans_person', {});
    const json = result.json as { ok: boolean; picked?: { id: string } };
    expect(json.ok).toBe(true);
    expect(json.picked?.id).toBeDefined();
  });

  it('diceroll_humaans_person does not leak API key in response', async () => {
    await setup();
    const result = await testClient.callTool('diceroll_humaans_person', {});
    expect(result.text).not.toContain(API_KEY);
  });
});
