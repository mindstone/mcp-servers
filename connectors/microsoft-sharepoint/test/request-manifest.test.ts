import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

interface ManifestRow {
  tool: string;
  method: string;
  pathname: string;
  args: Record<string, unknown>;
}

const MANIFEST: ManifestRow[] = [
  { tool: 'list_sharepoint_sites', method: 'GET', pathname: '/v1.0/sites', args: { query: 'marketing', top: 1 } },
  { tool: 'get_sharepoint_site', method: 'GET', pathname: '/v1.0/sites/:siteId', args: { siteId: 'site-1' } },
  { tool: 'list_site_document_libraries', method: 'GET', pathname: '/v1.0/sites/:siteId/drives', args: { siteId: 'site-1', top: 1 } },
  { tool: 'list_library_files', method: 'GET', pathname: '/v1.0/drives/:driveId/root/children', args: { driveId: 'drive-1', top: 1 } },
  { tool: 'get_library_file', method: 'GET', pathname: '/v1.0/drives/:driveId/items/:itemId', args: { driveId: 'drive-1', itemId: 'item-1' } },
  { tool: 'download_library_file', method: 'GET', pathname: '/v1.0/drives/:driveId/items/:itemId', args: { driveId: 'drive-1', itemId: 'item-1' } },
  { tool: 'search_library_files', method: 'GET', pathname: '/v1.0/drives/:driveId/root/search(q=*', args: { driveId: 'drive-1', query: 'report', top: 1 } },
  { tool: 'read_library_text_file', method: 'GET', pathname: '/v1.0/drives/:driveId/items/:itemId/content', args: { driveId: 'drive-1', itemId: 'item-1', maxSize: 200 } },
  { tool: 'upload_library_file', method: 'PUT', pathname: '/v1.0/drives/:driveId/root:/*:/content', args: { driveId: 'drive-1', path: 'General/uploaded.txt', content: 'hello' } },
  { tool: 'create_library_folder', method: 'POST', pathname: '/v1.0/drives/:driveId/root:/*:/children', args: { driveId: 'drive-1', path: 'General/NewFolder' } },
  { tool: 'delete_library_item', method: 'DELETE', pathname: '/v1.0/drives/:driveId/items/:itemId', args: { driveId: 'drive-1', itemId: 'item-1' } },
  { tool: 'move_library_item', method: 'PATCH', pathname: '/v1.0/drives/:driveId/items/:itemId', args: { driveId: 'drive-1', itemId: 'item-1', destinationFolderId: 'folder-1', newName: 'moved.txt' } },
  { tool: 'copy_library_item', method: 'POST', pathname: '/v1.0/drives/:driveId/items/:itemId/copy', args: { driveId: 'drive-1', itemId: 'item-1', destinationFolderId: 'folder-1', newName: 'copy.txt' } },
  { tool: 'list_site_pages', method: 'GET', pathname: '/v1.0/sites/:siteId/pages', args: { siteId: 'site-1', top: 1 } },
  { tool: 'read_site_page', method: 'GET', pathname: '/v1.0/sites/:siteId/pages/:pageId/microsoft.graph.sitePage', args: { siteId: 'site-1', pageId: 'page-1' } },
  { tool: 'list_site_lists', method: 'GET', pathname: '/v1.0/sites/:siteId/lists', args: { siteId: 'site-1', top: 1 } },
  { tool: 'list_list_items', method: 'GET', pathname: '/v1.0/sites/:siteId/lists/:listId/items', args: { siteId: 'site-1', listId: 'list-1', top: 1 } },
  { tool: 'get_list_item', method: 'GET', pathname: '/v1.0/sites/:siteId/lists/:listId/items/:itemId', args: { siteId: 'site-1', listId: 'list-1', itemId: '1' } },
  { tool: 'create_list_item', method: 'POST', pathname: '/v1.0/sites/:siteId/lists/:listId/items', args: { siteId: 'site-1', listId: 'list-1', fields: { Title: 'New item' } } },
  { tool: 'update_list_item', method: 'PATCH', pathname: '/v1.0/sites/:siteId/lists/:listId/items/:itemId/fields', args: { siteId: 'site-1', listId: 'list-1', itemId: '1', fields: { Status: 'Complete' } } },
  { tool: 'delete_list_item', method: 'DELETE', pathname: '/v1.0/sites/:siteId/lists/:listId/items/:itemId', args: { siteId: 'site-1', listId: 'list-1', itemId: '1' } },
  { tool: 'search_sharepoint', method: 'POST', pathname: '/v1.0/search/query', args: { query: 'budget', top: 1, entityTypes: ['site'] } },
  { tool: 'rename_library_item', method: 'PATCH', pathname: '/v1.0/drives/:driveId/items/:itemId', args: { driveId: 'drive-1', itemId: 'item-1', newName: 'renamed.txt' } },
  { tool: 'create_sharing_link', method: 'POST', pathname: '/v1.0/drives/:driveId/items/:itemId/createLink', args: { driveId: 'drive-1', itemId: 'item-1', type: 'view', scope: 'organization' } },
  { tool: 'list_subsites', method: 'GET', pathname: '/v1.0/sites/:siteId/sites', args: { siteId: 'site-1', top: 1 } },
  { tool: 'get_recent_files', method: 'GET', pathname: '/v1.0/me/drive/recent', args: { top: 1 } },
  { tool: 'get_library_tree', method: 'GET', pathname: '/v1.0/drives/:driveId/root/children', args: { driveId: 'drive-1', maxDepth: 1, maxItemsPerLevel: 2 } },
  { tool: 'get_file_metadata', method: 'GET', pathname: '/v1.0/drives/:driveId/items/:itemId/listItem/fields', args: { driveId: 'drive-1', itemId: 'item-1' } },
  { tool: 'update_file_metadata', method: 'PATCH', pathname: '/v1.0/drives/:driveId/items/:itemId/listItem/fields', args: { driveId: 'drive-1', itemId: 'item-1', fields: { Status: 'Updated' } } },
  { tool: 'get_site_drive', method: 'GET', pathname: '/v1.0/sites/:siteId/drives/:driveId', args: { siteId: 'site-1', driveId: 'drive-1' } },
  { tool: 'list_site_items', method: 'GET', pathname: '/v1.0/sites/:siteId/items', args: { siteId: 'site-1', top: 1 } },
  { tool: 'get_site_item', method: 'GET', pathname: '/v1.0/sites/:siteId/items/:itemId', args: { siteId: 'site-1', itemId: 'site-item-1' } },
  { tool: 'get_site_list', method: 'GET', pathname: '/v1.0/sites/:siteId/lists/:listId', args: { siteId: 'site-1', listId: 'list-1' } },
  { tool: 'get_site_by_path', method: 'GET', pathname: '/v1.0/sites/:siteId/getByPath(path=*', args: { siteId: 'site-1', path: '/departments/hr' } },
  { tool: 'get_sites_delta', method: 'GET', pathname: '/v1.0/sites/delta()', args: {} },
];

function matchPath(actual: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[\.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/:\w+/g, '[^/]+')
        .replace(/\*/g, '.*') +
      '$',
  );
  return regex.test(actual);
}

describe('request manifest — Graph endpoint contract', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;
  let state: MockApiState;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir();
    client = await createTestClient({
      env: {
        MS_CLIENT_ID: 'mock-client-id',
        MS_CONFIG_DIR: cfg.configPath,
      },
    });
  });

  beforeEach(() => {
    const mock = createMockApi();
    state = mock.state;
    mswServer.use(...mock.handlers);
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  for (const row of MANIFEST) {
    it(`${row.tool} → ${row.method} ${row.pathname}`, async () => {
      await client.callTool(row.tool, row.args);
      const match = state.requests.find(
        (r) =>
          r.method === row.method &&
          matchPath(r.pathname, row.pathname) &&
          !r.url.includes('login.microsoftonline.com'),
      );
      expect(
        match,
        `${row.tool}: no ${row.method} request matched ${row.pathname} (saw ${state.requests
          .map((r) => `${r.method} ${r.pathname}`)
          .join(', ')})`,
      ).toBeDefined();
    });
  }
});
