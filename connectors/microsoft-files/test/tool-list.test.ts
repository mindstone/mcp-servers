import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createTestClient,
  createMicrosoftConfigDir,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

const EXPECTED_TOOLS = [
  'list_files',
  'get_file',
  'download_file',
  'search_files',
  'upload_file',
  'create_folder',
  'delete_file',
  'move_file',
  'copy_file',
  'get_recent',
  'get_shared',
  'share_file',
  'read_text_file',
  'invite_to_file',
  'list_file_permissions',
  'revoke_file_permission',
  'list_file_versions',
  'restore_file_version',
  'list_file_activities',
  'read_document',
];

const EXPECTED_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  list_files: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_file: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  download_file: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  search_files: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  upload_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  create_folder: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  delete_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  move_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  copy_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  get_recent: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_shared: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  share_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  read_text_file: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  invite_to_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  list_file_permissions: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  revoke_file_permission: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  list_file_versions: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  restore_file_version: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  list_file_activities: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  read_document: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

const DESTRUCTIVE_TOOLS = [
  'create_folder',
  'upload_file',
  'delete_file',
  'move_file',
  'copy_file',
  'share_file',
  'invite_to_file',
  'revoke_file_permission',
  'restore_file_version',
];

describe('microsoft-files tools/list', () => {
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

  it(`registers exactly the ${EXPECTED_TOOLS.length} files tools in the locked surface`, async () => {
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

  it('does not instruct the model to confirm or ask first in tool descriptions', async () => {
    const response = await client.client.listTools();
    for (const tool of response.tools) {
      expect(tool.description ?? '', tool.name).not.toMatch(
        /confirm with the user|ask the user (first|before)/i,
      );
    }
  });

  it('marks every send, delete, or sharing-invite tool as destructive', async () => {
    const response = await client.client.listTools();
    for (const name of DESTRUCTIVE_TOOLS) {
      const tool = response.tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.annotations?.destructiveHint, name).toBe(true);
    }
  });

  it('names other tools only by their plain name', async () => {
    const response = await client.client.listTools();
    for (const tool of response.tools) {
      expect(tool.description ?? '', tool.name).not.toMatch(/[a-z0-9]+(__|\.|:)[a-z]+_[a-z_]+/);
    }
  });
});

describe('microsoft-files description regression proof', () => {
  it('pins link expiry and residual access guidance', async () => {
    const cfg = createMicrosoftConfigDir();
    const client = await createTestClient({
      env: { MS_CLIENT_ID: 'mock-client-id', MS_CONFIG_DIR: cfg.configPath },
    });

    try {
      const response = await client.client.listTools();
      const descriptions = new Map(response.tools.map((tool) => [tool.name, tool.description ?? '']));

      expect(descriptions.get('share_file')).toContain(
        'or until it expires under the organization\'s sharing policy',
      );
      expect(descriptions.get('revoke_file_permission')).toContain(
        'people may keep access through another link, a group or an inherited permission',
      );
    } finally {
      await client.close();
      cfg.cleanup();
    }
  });
});
