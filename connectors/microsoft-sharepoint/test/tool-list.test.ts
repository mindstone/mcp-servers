import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createTestClient,
  createMicrosoftConfigDir,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

const EXPECTED_TOOLS = [
  'authenticate_sharepoint',
  'list_sharepoint_sites',
  'get_sharepoint_site',
  'list_site_document_libraries',
  'list_library_files',
  'get_library_file',
  'download_library_file',
  'search_library_files',
  'read_library_text_file',
  'upload_library_file',
  'create_library_folder',
  'delete_library_item',
  'move_library_item',
  'copy_library_item',
  'list_site_pages',
  'read_site_page',
  'create_site_page',
  'update_site_page',
  'publish_site_page',
  'list_site_lists',
  'list_list_items',
  'get_list_item',
  'create_list_item',
  'update_list_item',
  'delete_list_item',
  'list_list_columns',
  'create_site_list',
  'search_sharepoint',
  'rename_library_item',
  'create_sharing_link',
  'list_file_versions',
  'list_item_permissions',
  'invite_item_collaborators',
  'revoke_item_permission',
  'list_subsites',
  'get_recent_files',
  'get_library_tree',
  'get_file_metadata',
  'update_file_metadata',
  'get_site_drive',
  'list_site_items',
  'get_site_item',
  'get_site_list',
  'get_site_by_path',
  'get_sites_delta',
];

const EXPECTED_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  authenticate_sharepoint: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  list_sharepoint_sites: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_sharepoint_site: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  list_site_document_libraries: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  list_library_files: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_library_file: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  download_library_file: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  search_library_files: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  read_library_text_file: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  upload_library_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  create_library_folder: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  delete_library_item: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  move_library_item: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: true,
  },
  copy_library_item: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  list_site_pages: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  read_site_page: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  create_site_page: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  update_site_page: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: true,
  },
  publish_site_page: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  list_site_lists: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  list_list_items: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_list_item: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  create_list_item: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  update_list_item: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: true,
  },
  delete_list_item: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  list_list_columns: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  create_site_list: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  search_sharepoint: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  rename_library_item: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: true,
  },
  create_sharing_link: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  list_file_versions: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  list_item_permissions: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  invite_item_collaborators: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  revoke_item_permission: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  list_subsites: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_recent_files: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_library_tree: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_file_metadata: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  update_file_metadata: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: true,
  },
  get_site_drive: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  list_site_items: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_site_item: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_site_list: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_site_by_path: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_sites_delta: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

describe('microsoft-sharepoint tools/list', () => {
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

  it('registers exactly the locked SharePoint tool surface', async () => {
    const response = await client.client.listTools();
    const names = response.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('does not register the authenticate_microsoft_account tool (SharePoint owns authenticate_sharepoint)', async () => {
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
