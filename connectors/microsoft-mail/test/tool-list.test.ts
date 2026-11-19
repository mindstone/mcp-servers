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
  'mark_email_read',
  'set_email_flag',
  'get_conversation',
  'get_automatic_replies',
  'set_automatic_replies',
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
  send_email: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  compose_email: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  search_emails: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  reply_to_email: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  forward_email: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
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
  send_draft: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  update_draft: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  mark_email_read: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  set_email_flag: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  get_conversation: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_automatic_replies: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  set_automatic_replies: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

const DESTRUCTIVE_TOOLS = [
  'send_email',
  'reply_to_email',
  'forward_email',
  'send_draft',
  'delete_email',
  'set_automatic_replies',
];

// Sending reaches other people and cannot be undone, so these are destructive.
const DESTRUCTIVE_TOOL_NAMES = [...DESTRUCTIVE_TOOLS].sort();

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

  it('registers exactly the 22 mail tools in the locked surface', async () => {
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

  it('marks exactly the sends, delete and automatic replies as destructive', async () => {
    const response = await client.client.listTools();
    const destructive = response.tools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name)
      .sort();
    expect(destructive).toEqual(DESTRUCTIVE_TOOL_NAMES);
  });

  it('does not instruct the model to confirm or ask first in tool descriptions', async () => {
    const response = await client.client.listTools();
    for (const tool of response.tools) {
      expect(tool.description ?? '', tool.name).not.toMatch(
        /confirm with the user|ask the user (first|before)/i,
      );
    }
  });

  it('names other tools only by their plain name', async () => {
    const response = await client.client.listTools();
    for (const tool of response.tools) {
      expect(tool.description ?? '', tool.name).not.toMatch(/[a-z0-9]+(__|\.|:)[a-z]+_[a-z_]+/);
    }
  });
});

describe('microsoft-mail description regression proof', () => {
  it('describes reply recipients, partial settings updates, and no recall', async () => {
    const cfg = createMicrosoftConfigDir();
    const client = await createTestClient({
      env: { MS_CLIENT_ID: 'mock-client-id', MS_CONFIG_DIR: cfg.configPath },
    });

    try {
      const response = await client.client.listTools();
      const descriptions = new Map(response.tools.map((tool) => [tool.name, tool.description ?? '']));

      expect(descriptions.get('reply_to_email')).toContain(
        'the Reply-To address, if the email has one',
      );
      for (const name of ['send_email', 'reply_to_email', 'forward_email', 'send_draft']) {
        expect(descriptions.get(name), name).toContain('This tool cannot recall it after sending.');
      }
      expect(descriptions.get('set_automatic_replies')).toContain(
        'Only the settings given are changed; any left out keep their current values.',
      );
    } finally {
      await client.close();
      cfg.cleanup();
    }
  });
});
