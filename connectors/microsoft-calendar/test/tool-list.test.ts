import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createTestClient,
  createMicrosoftConfigDir,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

const EXPECTED_TOOLS = [
  'list_events',
  'get_event',
  'create_event',
  'update_event',
  'delete_event',
  'cancel_event',
  'respond_to_event',
  'get_free_busy',
  'find_meeting_times',
  'list_calendars',
];

const EXPECTED_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  list_events: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_event: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  create_event: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  update_event: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  delete_event: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  cancel_event: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  respond_to_event: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  get_free_busy: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  find_meeting_times: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  list_calendars: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

describe('microsoft-calendar tools/list', () => {
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

  it('registers exactly the 10 calendar tools in the locked surface', async () => {
    const response = await client.client.listTools();
    const names = response.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('does not register the authenticate_microsoft_account tool (auth is host-routed to Mail)', async () => {
    const response = await client.client.listTools();
    const names = response.tools.map((tool) => tool.name);
    expect(names).not.toContain('authenticate_microsoft_account');
  });

  it('applies the cohort-locked annotations to every tool', async () => {
    const response = await client.client.listTools();
    for (const tool of response.tools) {
      const expected = EXPECTED_ANNOTATIONS[tool.name];
      expect(expected, `unknown tool: ${tool.name}`).toBeDefined();
      for (const [key, value] of Object.entries(expected)) {
        expect(
          (tool.annotations as Record<string, unknown> | undefined)?.[key],
          `${tool.name}.${key}`,
        ).toBe(value);
      }
    }
  });
});
