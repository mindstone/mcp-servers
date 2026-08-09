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

  it('upload_library_file_binary uploads via an upload session in one chunk', async () => {
    const contentBase64 = Buffer.from('binary-payload').toString('base64');
    const result = await client.callTool('upload_library_file_binary', {
      driveId: 'drive-1',
      path: 'General/report.bin',
      contentBase64,
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; success: boolean; id: string };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    expect(json.id).toBe('uploaded-bin-1');
    const sessionCall = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.includes('/createUploadSession'),
    );
    expect(sessionCall).toBeDefined();
    expect((sessionCall?.body as { item: Record<string, unknown> }).item['@microsoft.graph.conflictBehavior']).toBe('rename');
    const chunkCalls = state.requests.filter(
      (r) => r.method === 'PUT' && r.pathname.includes('/uploadSessions/'),
    );
    expect(chunkCalls).toHaveLength(1);
  });

  it('upload_library_file_binary chunks large payloads (202 then 201)', async () => {
    // 5 MB > one 3.2 MB chunk, so the upload must span two PUTs.
    const contentBase64 = Buffer.alloc(5 * 1024 * 1024, 7).toString('base64');
    const result = await client.callTool('upload_library_file_binary', {
      driveId: 'drive-1',
      path: 'General/big.bin',
      contentBase64,
      conflictBehavior: 'replace',
    });
    expect(result.isError).not.toBe(true);
    const chunkCalls = state.requests.filter(
      (r) => r.method === 'PUT' && r.pathname.includes('/uploadSessions/'),
    );
    expect(chunkCalls).toHaveLength(2);
  });

  it('upload_library_file_binary rejects invalid base64', async () => {
    const result = await client.callTool('upload_library_file_binary', {
      driveId: 'drive-1',
      path: 'General/report.bin',
      contentBase64: '!!!not-base64!!!',
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('base64');
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

  it('create_site_page POSTs a sitePage draft with derived name and text web part', async () => {
    const result = await client.callTool('create_site_page', {
      siteId: 'site-1',
      title: 'Q3 Update',
      contentHtml: '<p>Summary</p>',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; success: boolean; id: string; message: string };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    expect(json.message).toContain('draft');
    const call = state.requests.find(
      (r) => r.method === 'POST' && /\/sites\/site-1\/pages$/.test(r.pathname),
    );
    expect(call).toBeDefined();
    const body = call?.body as {
      '@odata.type': string;
      title: string;
      name: string;
      pageLayout: string;
      canvasLayout: { horizontalSections: Array<{ columns: Array<{ webparts: Array<{ innerHtml: string }> }> }> };
    };
    expect(body['@odata.type']).toBe('#microsoft.graph.sitePage');
    expect(body.name).toBe('q3-update.aspx');
    expect(body.pageLayout).toBe('article');
    expect(body.canvasLayout.horizontalSections[0]?.columns[0]?.webparts[0]?.innerHtml).toBe('<p>Summary</p>');
  });

  it('create_site_page rejects a missing title', async () => {
    const result = await client.callTool('create_site_page', { siteId: 'site-1' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('title');
  });

  it('update_site_page PATCHes the sitePage cast endpoint', async () => {
    const result = await client.callTool('update_site_page', {
      siteId: 'site-1',
      pageId: 'page-1',
      title: 'Updated title',
    });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'PATCH' && /\/pages\/page-1\/microsoft\.graph\.sitePage$/.test(r.pathname),
    );
    expect(call).toBeDefined();
    const body = call?.body as { '@odata.type': string; title: string };
    expect(body['@odata.type']).toBe('#microsoft.graph.sitePage');
    expect(body.title).toBe('Updated title');
  });

  it('update_site_page rejects a call with nothing to update', async () => {
    const result = await client.callTool('update_site_page', { siteId: 'site-1', pageId: 'page-1' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Nothing to update');
  });

  it('publish_site_page POSTs to the publish endpoint', async () => {
    const result = await client.callTool('publish_site_page', { siteId: 'site-1', pageId: 'page-1' });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'POST' && /\/pages\/page-1\/microsoft\.graph\.sitePage\/publish$/.test(r.pathname),
    );
    expect(call).toBeDefined();
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
    const json = result.json as {
      ok?: unknown;
      link: string;
      type?: string;
      scope?: string;
      roles?: Array<string | undefined>;
    };
    expect(json.ok).toBeUndefined();
    // The sharing URL stays raw so the caller can use it directly.
    expect(json.link).toContain('/share/perm-1');
    // type/scope/roles are Graph-controlled strings and must be enveloped.
    expect(json.type).toContain('<untrusted-content');
    expect(json.type).toContain('view');
    expect(json.scope).toContain('<untrusted-content');
    expect(json.roles?.[0]).toContain('<untrusted-content');
    expect(json.roles?.[0]).toContain('read');
  });

  it('list_site_lists envelopes the tenant-visible list template', async () => {
    const result = await client.callTool('list_site_lists', { siteId: 'site-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      count: number;
      lists: Array<{ displayName?: string; template?: string }>;
    };
    expect(json.count).toBeGreaterThan(0);
    expect(json.lists[0]?.displayName).toContain('<untrusted-content');
    expect(json.lists[0]?.template).toContain('<untrusted-content');
    expect(json.lists[0]?.template).toContain('genericList');
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
    const getJson = getResult.json as { fields: Record<string, unknown> };
    // Field keys are tenant-controlled column names, so they are enveloped too.
    const departmentKey = '<untrusted-content source="microsoft-sharepoint:get_file_metadata:fields">Department</untrusted-content>';
    expect(String(getJson.fields[departmentKey])).toContain('Marketing');

    const updateResult = await client.callTool('update_file_metadata', {
      driveId: 'drive-1',
      itemId: 'item-1',
      fields: { Status: 'Updated' },
    });
    expect(updateResult.isError).not.toBe(true);
    const updateJson = updateResult.json as { updatedFields: Record<string, unknown> };
    const statusKey = '<untrusted-content source="microsoft-sharepoint:update_file_metadata:updatedFields">Status</untrusted-content>';
    expect(String(updateJson.updatedFields[statusKey])).toContain('Updated');
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
    expect(deltaJson.deltaLink).toContain('/sites/delta');
  });

  it('get_recent_files labels its personal-OneDrive scope', async () => {
    const result = await client.callTool('get_recent_files', { top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; note?: string };
    expect(json.ok).toBeUndefined();
    expect(json.note).toContain('OneDrive');
  });

  it('list_list_columns returns column schema with derived types', async () => {
    const result = await client.callTool('list_list_columns', {
      siteId: 'site-1',
      listId: 'list-1',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      count: number;
      truncated: boolean;
      columns: Array<{ name?: string; displayName?: string; type: string; required: boolean }>;
    };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(2);
    expect(json.truncated).toBe(false);
    expect(json.columns[0]?.type).toBe('text');
    expect(json.columns[1]?.type).toBe('choice');
    expect(json.columns[1]?.required).toBe(true);
    // Both the internal column name and the display name are tenant-controlled.
    expect(json.columns[0]?.name).toContain('<untrusted-content');
    expect(json.columns[1]?.displayName).toContain('<untrusted-content');
  });

  it('create_site_list POSTs a list with column schema', async () => {
    const result = await client.callTool('create_site_list', {
      siteId: 'site-1',
      displayName: 'Project Tracker',
      columns: [
        { name: 'Status', type: 'choice', choices: ['Active', 'Complete'], required: true },
        { name: 'Notes', type: 'text' },
      ],
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; success: boolean; id: string };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'POST' && /\/sites\/site-1\/lists$/.test(r.pathname),
    );
    expect(call).toBeDefined();
    const body = call?.body as {
      displayName: string;
      list: { template: string };
      columns: Array<Record<string, unknown>>;
    };
    expect(body.displayName).toBe('Project Tracker');
    expect(body.list.template).toBe('genericList');
    expect(body.columns[0]).toMatchObject({
      name: 'Status',
      required: true,
      choice: { choices: ['Active', 'Complete'] },
    });
    expect(body.columns[1]).toMatchObject({ name: 'Notes', text: {} });
  });

  it('create_site_list rejects a choice column without choices', async () => {
    const result = await client.callTool('create_site_list', {
      siteId: 'site-1',
      displayName: 'Bad List',
      columns: [{ name: 'Status', type: 'choice' }],
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('choices');
  });

  it('list_file_versions returns version history with enveloped names', async () => {
    const result = await client.callTool('list_file_versions', {
      driveId: 'drive-1',
      itemId: 'item-1',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      count: number;
      versions: Array<{ id: string; modifiedBy?: string }>;
    };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(2);
    expect(json.versions[0]?.id).toBe('1.0');
    expect(json.versions[0]?.modifiedBy).toContain('<untrusted-content');
  });

  it('list_file_versions rejects missing arguments with guidance', async () => {
    const result = await client.callTool('list_file_versions', { driveId: 'drive-1' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('itemId');
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
      truncated: boolean;
      permissions: Array<{
        id: string;
        roles: Array<string | undefined>;
        shareId?: string;
        link?: { type?: string; scope?: string; webUrl?: string };
        grantedTo: Array<{ displayName?: string; email?: string }>;
      }>;
    };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(1);
    expect(json.truncated).toBe(false);
    expect(json.permissions[0]?.id).toBe('perm-1');
    expect(json.permissions[0]?.grantedTo[0]?.displayName).toContain('<untrusted-content');
    expect(json.permissions[0]?.grantedTo[0]?.displayName).toContain('Alice Example');
    // Every Graph-controlled string field is enveloped, not just displayName.
    expect(json.permissions[0]?.roles[0]).toContain('<untrusted-content');
    expect(json.permissions[0]?.roles[0]).toContain('read');
    expect(json.permissions[0]?.shareId).toContain('<untrusted-content');
    expect(json.permissions[0]?.link?.type).toContain('<untrusted-content');
    expect(json.permissions[0]?.link?.scope).toContain('<untrusted-content');
    expect(json.permissions[0]?.link?.webUrl).toContain('<untrusted-content');
    expect(json.permissions[0]?.grantedTo[0]?.email).toContain('<untrusted-content');
    expect(json.permissions[0]?.grantedTo[0]?.email).toContain('alice@example.com');
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
