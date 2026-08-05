import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestClient, createMicrosoftConfigDir, type McpTestClient, type MicrosoftTestConfig } from './fixtures/mcp-test-client.js';

const EXPECTED_TOOLS = [
  'authenticate_microsoft_account',
  'list_emails',
  'get_email',
  'list_attachments',
  'download_attachment',
  'send_email',
  'compose_email',
  'search_emails',
  'reply_to_email',
  'forward_email',
  'delete_email',
  'list_folders',
  'move_email',
  'create_reply_draft',
  'create_draft',
  'send_draft',
  'update_draft',
];

const EXPECTED_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  authenticate_microsoft_account: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  list_emails: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_email: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  list_attachments: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  download_attachment: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  send_email: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  compose_email: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  search_emails: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  reply_to_email: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  forward_email: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  delete_email: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  list_folders: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  move_email: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  create_reply_draft: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  create_draft: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  send_draft: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  update_draft: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

describe('microsoft-mail tools/list', () => {
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

  it('registers exactly the 17 mail tools in the locked surface', async () => {
    const response = await client.client.listTools();
    const names = response.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
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
