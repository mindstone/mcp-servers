import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createFathomHandlers } from './helpers/fathom-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-fathom-key';

describe('Fathom team tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup() {
    mswServer.use(...createFathomHandlers(API_KEY));
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
  }

  it('list_fathom_teams returns teams', async () => {
    await setup();
    const result = await testClient.callTool('list_fathom_teams', {});
    const json = result.json as {
      ok: boolean;
      teams: Array<{ name: string }>;
      count: number;
    };

    expect(json.ok).toBe(true);
    expect(json.teams).toHaveLength(2);
    expect(json.teams[0]!.name).toBe('Engineering');
    expect(json.teams[1]!.name).toBe('Sales');
    expect(json.count).toBe(2);
  });

  it('list_fathom_team_members returns members', async () => {
    await setup();
    const result = await testClient.callTool('list_fathom_team_members', { team: 'Engineering' });
    const json = result.json as {
      ok: boolean;
      teamMembers: Array<{ name: string; email: string; role: string }>;
      count: number;
    };

    expect(json.ok).toBe(true);
    expect(json.teamMembers).toHaveLength(2);
    expect(json.teamMembers[0]!.email).toBe('alice@example.com');
    expect(json.count).toBe(2);
  });
});
