import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

describe('microsoft-sharepoint mock-API integration', () => {
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

  it('authenticate_sharepoint emits host-orchestrated auth_required shape', async () => {
    const result = await client.callTool('authenticate_sharepoint', {});
    expect(result.isError).not.toBe(true);
    expect(result.json).toMatchObject({
      status: 'auth_required',
      user_action: { id: 'microsoft.connect_sharepoint' },
      setupToolName: 'authenticate_sharepoint',
    });
  });

  it('list_sharepoint_sites returns formatted sites and hits /sites', async () => {
    const result = await client.callTool('list_sharepoint_sites', { top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; count: number; sites: Array<{ id: string }> };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(1);
    expect(json.sites[0]?.id).toBe('site-1');
    const call = state.requests.find((r) => r.pathname.endsWith('/sites'));
    expect(call).toBeDefined();
    expect(call?.search).toMatch(/\$top=5/);
  });

  it('get_sharepoint_site returns site details', async () => {
    const result = await client.callTool('get_sharepoint_site', { siteId: 'site-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; id: string; displayName: string };
    expect(json.ok).toBeUndefined();
    expect(json.id).toBe('site-1');
    expect(json.displayName).toContain('Marketing');
  });

  it('list_site_document_libraries returns drive metadata', async () => {
    const result = await client.callTool('list_site_document_libraries', {
      siteId: 'site-1',
      top: 5,
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      count: number;
      documentLibraries: Array<{ id: string; name: string }>;
    };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(1);
    expect(json.documentLibraries[0]?.id).toBe('drive-1');
  });

  it('list_library_files returns item listing', async () => {
    const result = await client.callTool('list_library_files', { driveId: 'drive-1', top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; count: number; items: Array<{ id: string }> };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(2);
  });

  it('read_library_text_file returns textual content', async () => {
    const result = await client.callTool('read_library_text_file', {
      driveId: 'drive-1',
      itemId: 'item-1',
      maxSize: 1000,
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; content: string; mimeType: string };
    expect(json.ok).toBeUndefined();
    expect(json.mimeType).toBe('text/plain');
    expect(json.content).toContain('Hello SharePoint text content');
  });

  it('upload_library_file PUTs content under drive root path', async () => {
    const result = await client.callTool('upload_library_file', {
      driveId: 'drive-1',
      path: 'General/new.txt',
      content: 'hello',
    });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'PUT' && r.pathname.includes('/drives/drive-1/root:/General/new.txt:/content'),
    );
    expect(call).toBeDefined();
  });

  it('create_library_folder creates nested folder', async () => {
    const result = await client.callTool('create_library_folder', {
      driveId: 'drive-1',
      path: 'General/NewFolder',
    });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.includes('/drives/drive-1/root:/General:/children'),
    );
    expect(call).toBeDefined();
  });

  it('delete_library_item deletes an item', async () => {
    const result = await client.callTool('delete_library_item', {
      driveId: 'drive-1',
      itemId: 'item-1',
    });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'DELETE' && r.pathname.includes('/drives/drive-1/items/item-1'),
    );
    expect(call).toBeDefined();
  });

  it('read_site_page returns page text from web parts', async () => {
    const result = await client.callTool('read_site_page', { siteId: 'site-1', pageId: 'page-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { contentHtml: string };
    expect(json.contentHtml).toContain('Hello SharePoint');
  });

  it('list/list-item mutation tools hit expected list endpoints', async () => {
    const createResult = await client.callTool('create_list_item', {
      siteId: 'site-1',
      listId: 'list-1',
      fields: { Title: 'Created' },
    });
    expect(createResult.isError).not.toBe(true);

    const updateResult = await client.callTool('update_list_item', {
      siteId: 'site-1',
      listId: 'list-1',
      itemId: '1',
      fields: { Status: 'Complete' },
    });
    expect(updateResult.isError).not.toBe(true);

    const deleteResult = await client.callTool('delete_list_item', {
      siteId: 'site-1',
      listId: 'list-1',
      itemId: '1',
    });
    expect(deleteResult.isError).not.toBe(true);

    expect(
      state.requests.some(
        (r) => r.method === 'POST' && /\/sites\/site-1\/lists\/list-1\/items$/.test(r.pathname),
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (r) =>
          r.method === 'PATCH' && /\/sites\/site-1\/lists\/list-1\/items\/1\/fields$/.test(r.pathname),
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (r) =>
          r.method === 'DELETE' && /\/sites\/site-1\/lists\/list-1\/items\/1$/.test(r.pathname),
      ),
    ).toBe(true);
  });

  it('search_sharepoint hits POST /search/query', async () => {
    const result = await client.callTool('search_sharepoint', {
      query: 'budget',
      entityTypes: ['site'],
      top: 2,
    });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/search/query'),
    );
    expect(call).toBeDefined();
  });

  it('create_sharing_link creates link permissions', async () => {
    const result = await client.callTool('create_sharing_link', {
      driveId: 'drive-1',
      itemId: 'item-1',
      type: 'view',
      scope: 'organization',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; link: string; type: string; scope: string };
    expect(json.ok).toBeUndefined();
    expect(json.link).toContain('/share/perm-1');
  });

  it('get_library_tree returns recursive tree payload', async () => {
    const result = await client.callTool('get_library_tree', {
      driveId: 'drive-1',
      maxDepth: 1,
      maxItemsPerLevel: 5,
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { tree: Array<{ name: string }> };
    expect(Array.isArray(json.tree)).toBe(true);
    expect(json.tree.length).toBeGreaterThan(0);
  });

  it('get_file_metadata/update_file_metadata handle listItem fields endpoints', async () => {
    const getResult = await client.callTool('get_file_metadata', {
      driveId: 'drive-1',
      itemId: 'item-1',
    });
    expect(getResult.isError).not.toBe(true);
    const getJson = getResult.json as { fields: { Department: string } };
    expect(getJson.fields.Department).toContain('Marketing');

    const updateResult = await client.callTool('update_file_metadata', {
      driveId: 'drive-1',
      itemId: 'item-1',
      fields: { Status: 'Updated' },
    });
    expect(updateResult.isError).not.toBe(true);
    const updateJson = updateResult.json as { updatedFields: { Status: string } };
    expect(updateJson.updatedFields.Status).toContain('Updated');
  });

  it('get_site_by_path and get_sites_delta return site discovery payloads', async () => {
    const byPath = await client.callTool('get_site_by_path', {
      siteId: 'site-1',
      path: '/departments/hr',
    });
    expect(byPath.isError).not.toBe(true);
    const byPathJson = byPath.json as { id: string };
    expect(byPathJson.id).toBe('site-1');

    const delta = await client.callTool('get_sites_delta', {});
    expect(delta.isError).not.toBe(true);
    const deltaJson = delta.json as { deltaLink: string };
    expect(deltaJson.deltaLink).toContain('/sites/delta(');
  });

  it('get_recent_files labels its personal-OneDrive scope', async () => {
    const result = await client.callTool('get_recent_files', { top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; note?: string };
    expect(json.ok).toBeUndefined();
    expect(json.note).toContain('OneDrive');
  });

  it('list_item_permissions returns grants with enveloped display names', async () => {
    const result = await client.callTool('list_item_permissions', {
      driveId: 'drive-1',
      itemId: 'item-1',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      count: number;
      permissions: Array<{ id: string; roles: string[]; grantedTo: Array<{ displayName?: string; email?: string }> }>;
    };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(1);
    expect(json.permissions[0]?.id).toBe('perm-1');
    expect(json.permissions[0]?.grantedTo[0]?.displayName).toContain('<untrusted-content');
    expect(json.permissions[0]?.grantedTo[0]?.displayName).toContain('Alice Example');
  });

  it('invite_item_collaborators POSTs to /invite with safe defaults', async () => {
    const result = await client.callTool('invite_item_collaborators', {
      driveId: 'drive-1',
      itemId: 'item-1',
      recipients: ['jane@example.com'],
    });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.includes('/drives/drive-1/items/item-1/invite'),
    );
    expect(call).toBeDefined();
    const body = call?.body as {
      recipients: Array<{ email: string }>;
      requireSignIn: boolean;
      sendInvitation: boolean;
      roles: string[];
    };
    expect(body.recipients).toEqual([{ email: 'jane@example.com' }]);
    expect(body.requireSignIn).toBe(true);
    expect(body.sendInvitation).toBe(false);
    expect(body.roles).toEqual(['read']);
  });

  it('invite_item_collaborators rejects an empty recipient list', async () => {
    const result = await client.callTool('invite_item_collaborators', {
      driveId: 'drive-1',
      itemId: 'item-1',
      recipients: [],
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('recipients');
  });

  it('revoke_item_permission deletes the permission', async () => {
    const result = await client.callTool('revoke_item_permission', {
      driveId: 'drive-1',
      itemId: 'item-1',
      permissionId: 'perm-1',
    });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'DELETE' && r.pathname.includes('/drives/drive-1/items/item-1/permissions/perm-1'),
    );
    expect(call).toBeDefined();
  });

  it('returns explicit guidance when scope-gated tool arguments are missing', async () => {
    const result = await client.callTool('get_sharepoint_site', {});
    expect(result.isError).toBe(true);
    const json = result.json as {
      ok: boolean;
      error: string;
      action_required: string;
      next_step: string;
    };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameter');
    expect(json.action_required).toContain('Adjust the arguments');
    expect(json.next_step).toBe('get_sharepoint_site');
  });
});
