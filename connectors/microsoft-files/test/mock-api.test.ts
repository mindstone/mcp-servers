import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

describe('microsoft-files mock-API integration', () => {
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

  // -------------------------------------------------------------------------
  // list_files
  // -------------------------------------------------------------------------
  it('list_files returns formatted items and hits /me/drive/root/children', async () => {
    const result = await client.callTool('list_files', { top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      count: number;
      path: string;
      items: Array<{ id: string; type: string }>;
    };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(2);
    expect(json.path).toBe('/');
    expect(json.items[0]?.type).toBeDefined();
    const call = state.requests.find((r) => r.pathname.endsWith('/me/drive/root/children'));
    expect(call).toBeDefined();
    expect(call?.search).toMatch(/\$top=5/);
  });

  it('list_files with absolute path hits /me/drive/root:/...:/children', async () => {
    await client.callTool('list_files', { path: '/Documents', top: 1 });
    const call = state.requests.find((r) =>
      r.pathname.includes('/me/drive/root:/Documents:/children'),
    );
    expect(call).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // get_file
  // -------------------------------------------------------------------------
  it('get_file returns formatted metadata for an item id', async () => {
    const result = await client.callTool('get_file', { path: '01ABC123xyz' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; id: string; name: string };
    expect(json.ok).toBeUndefined();
    expect(json.id).toBeDefined();
  });

  it('get_file rejects missing path with explicit guidance', async () => {
    const result = await client.callTool('get_file', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameter');
    expect(json.next_step).toBe('list_files');
  });

  // -------------------------------------------------------------------------
  // download_file
  // -------------------------------------------------------------------------
  it('download_file returns a short-lived download URL', async () => {
    const result = await client.callTool('download_file', { path: '01ABC123xyz' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; downloadUrl: string; note: string };
    expect(json.ok).toBeUndefined();
    expect(json.downloadUrl).toContain('downloads.example.com');
    expect(json.note).toContain('short period');
  });

  it('download_file rejects missing path', async () => {
    const result = await client.callTool('download_file', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.next_step).toBe('list_files');
  });

  // -------------------------------------------------------------------------
  // search_files
  // -------------------------------------------------------------------------
  it('search_files hits /me/drive/root/search(q=...) and returns items', async () => {
    const result = await client.callTool('search_files', { query: 'report', top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; query: string; count: number };
    expect(json.ok).toBeUndefined();
    expect(json.query).toBe('report');
    expect(json.count).toBe(1);
    const call = state.requests.find((r) =>
      r.pathname.includes("/me/drive/root/search(q='report')"),
    );
    expect(call).toBeDefined();
  });

  it('search_files rejects empty query with explicit guidance', async () => {
    const result = await client.callTool('search_files', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameter');
    expect(json.next_step).toBe('search_files');
  });

  // -------------------------------------------------------------------------
  // upload_file
  // -------------------------------------------------------------------------
  it('upload_file PUTs text content to /me/drive/root:/{path}:/content', async () => {
    const result = await client.callTool('upload_file', {
      path: '/Documents/notes.txt',
      content: 'Hello world',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; success: boolean; webUrl: string };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'PUT' && r.pathname.includes('/me/drive/root:/Documents/notes.txt:/content'),
    );
    expect(call).toBeDefined();
  });

  it('upload_file rejects oversized content (>4MB)', async () => {
    const big = 'a'.repeat(4 * 1024 * 1024 + 1);
    const result = await client.callTool('upload_file', {
      path: '/Documents/big.txt',
      content: big,
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Maximum size is 4MB');
    expect(json.next_step).toBe('upload_file');
  });

  it('upload_file rejects missing fields', async () => {
    const result = await client.callTool('upload_file', { path: '/x.txt' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameters');
    expect(json.next_step).toBe('upload_file');
  });

  it('upload_file rejects empty content for bundled parity', async () => {
    const result = await client.callTool('upload_file', { path: '/x.txt', content: '' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameters');
    expect(json.next_step).toBe('upload_file');
  });

  // -------------------------------------------------------------------------
  // create_folder
  // -------------------------------------------------------------------------
  it('create_folder POSTs to /me/drive/root/children at the root', async () => {
    const result = await client.callTool('create_folder', { path: '/NewFolder' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; success: boolean; id: string };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/drive/root/children'),
    );
    expect(call?.body).toMatchObject({ name: 'NewFolder', folder: {} });
  });

  it('create_folder POSTs to parent path when nested', async () => {
    await client.callTool('create_folder', { path: '/Documents/Project/Inner' });
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.includes('/me/drive/root:/Documents/Project:/children'),
    );
    expect(call?.body).toMatchObject({ name: 'Inner' });
  });

  it('create_folder rejects missing path', async () => {
    const result = await client.callTool('create_folder', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.next_step).toBe('create_folder');
  });

  // -------------------------------------------------------------------------
  // delete_file
  // -------------------------------------------------------------------------
  it('delete_file DELETEs /me/drive/items/{id}', async () => {
    const result = await client.callTool('delete_file', { path: 'item-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; success: boolean; message: string };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    expect(json.message).toContain('deleted');
    const call = state.requests.find(
      (r) => r.method === 'DELETE' && r.pathname.includes('/me/drive/items/item-1'),
    );
    expect(call).toBeDefined();
  });

  it('delete_file rejects missing path with WARNING guidance', async () => {
    const result = await client.callTool('delete_file', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('WARNING');
    expect(json.next_step).toBe('list_files');
  });

  // -------------------------------------------------------------------------
  // move_file
  // -------------------------------------------------------------------------
  it('move_file PATCHes /me/drive/items/{id} with parentReference', async () => {
    const result = await client.callTool('move_file', {
      sourcePath: 'item-1',
      destinationPath: 'dest-1',
      newName: 'moved.txt',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; success: boolean };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'PATCH' && r.pathname.includes('/me/drive/items/item-1'),
    );
    expect(call?.body).toMatchObject({ parentReference: { id: 'dest-folder-1' }, name: 'moved.txt' });
  });

  it('move_file rejects missing sourcePath/destinationPath', async () => {
    const result = await client.callTool('move_file', { sourcePath: 'item-1' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.next_step).toBe('move_file');
  });

  // -------------------------------------------------------------------------
  // copy_file
  // -------------------------------------------------------------------------
  it('copy_file POSTs to /me/drive/items/{id}/copy with new name', async () => {
    const result = await client.callTool('copy_file', {
      sourcePath: 'src-1',
      destinationPath: 'dest-1',
      newName: 'project-doc.docx',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; success: boolean; message: string };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    expect(json.message).toContain('Copy operation started');
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.includes('/me/drive/items/src-1/copy'),
    );
    expect(call?.body).toMatchObject({
      parentReference: { id: 'dest-folder-1' },
      name: 'project-doc.docx',
    });
  });

  it('copy_file rejects missing args', async () => {
    const result = await client.callTool('copy_file', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.next_step).toBe('copy_file');
  });

  // -------------------------------------------------------------------------
  // get_recent
  // -------------------------------------------------------------------------
  it('get_recent returns recent files', async () => {
    const result = await client.callTool('get_recent', { top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; count: number };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(1);
    const call = state.requests.find((r) => r.pathname.endsWith('/me/drive/recent'));
    expect(call).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // get_shared
  // -------------------------------------------------------------------------
  it('get_shared returns shared files', async () => {
    const result = await client.callTool('get_shared', { top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; count: number };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(1);
    const call = state.requests.find((r) => r.pathname.endsWith('/me/drive/sharedWithMe'));
    expect(call).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // share_file
  // -------------------------------------------------------------------------
  it('share_file POSTs to /me/drive/items/{id}/createLink with type/scope', async () => {
    const result = await client.callTool('share_file', {
      path: 'item-1',
      type: 'edit',
      scope: 'organization',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; shareUrl: string; type: string; scope: string };
    expect(json.ok).toBeUndefined();
    expect(json.shareUrl).toContain('share-1');
    expect(json.type).toBe('edit');
    expect(json.scope).toBe('organization');
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.includes('/me/drive/items/item-1/createLink'),
    );
    expect(call?.body).toMatchObject({ type: 'edit', scope: 'organization' });
  });

  it('share_file rejects missing path', async () => {
    const result = await client.callTool('share_file', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.next_step).toBe('share_file');
  });

  // -------------------------------------------------------------------------
  // read_text_file
  // -------------------------------------------------------------------------
  it('read_text_file returns content for a text file', async () => {
    const result = await client.callTool('read_text_file', { path: 'item-text' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; content: string; mimeType: string };
    expect(json.ok).toBeUndefined();
    expect(json.content).toContain('Hello from text file');
    expect(json.mimeType).toBe('text/plain');
  });

  it('read_text_file rejects missing path', async () => {
    const result = await client.callTool('read_text_file', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.next_step).toBe('list_files');
  });

  // -------------------------------------------------------------------------
  // invite_to_file
  // -------------------------------------------------------------------------
  it('invite_to_file POSTs recipients to /invite and returns enveloped grantees', async () => {
    const result = await client.callTool('invite_to_file', {
      path: 'item-1',
      recipients: ['jane@example.com'],
      role: 'write',
      message: 'Here is the report',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      success: boolean;
      permissions: Array<{
        id: string;
        roles: string[];
        grantedTo: Array<{ displayName?: string; email?: string }>;
      }>;
    };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    expect(json.permissions[0]?.id).toBe('perm-1');
    expect(json.permissions[0]?.grantedTo[0]?.displayName).toContain('untrusted-content');
    expect(json.permissions[0]?.grantedTo[0]?.displayName).toContain('Jane Doe');
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.includes('/me/drive/items/item-1/invite'),
    );
    expect(call?.body).toMatchObject({
      recipients: [{ email: 'jane@example.com' }],
      roles: ['write'],
      requireSignIn: true,
      sendInvitation: false,
      message: 'Here is the report',
    });
  });

  it('invite_to_file rejects missing recipients with guidance', async () => {
    const result = await client.callTool('invite_to_file', { path: 'item-1' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameters');
    expect(json.next_step).toBe('invite_to_file');
  });

  // -------------------------------------------------------------------------
  // list_file_permissions
  // -------------------------------------------------------------------------
  it('list_file_permissions returns permissions with enveloped identities', async () => {
    const result = await client.callTool('list_file_permissions', { path: 'item-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      count: number;
      permissions: Array<{ id: string; link?: { scope?: string } }>;
    };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(2);
    expect(json.permissions[1]?.link?.scope).toBe('organization');
    const call = state.requests.find(
      (r) => r.method === 'GET' && r.pathname.includes('/me/drive/items/item-1/permissions'),
    );
    expect(call).toBeDefined();
  });

  it('list_file_permissions rejects missing path', async () => {
    const result = await client.callTool('list_file_permissions', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.next_step).toBe('list_file_permissions');
  });

  // -------------------------------------------------------------------------
  // revoke_file_permission
  // -------------------------------------------------------------------------
  it('revoke_file_permission DELETEs the permission', async () => {
    const result = await client.callTool('revoke_file_permission', {
      path: 'item-1',
      permissionId: 'perm-2',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; success: boolean };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    const call = state.requests.find(
      (r) =>
        r.method === 'DELETE' &&
        r.pathname.includes('/me/drive/items/item-1/permissions/perm-2'),
    );
    expect(call).toBeDefined();
  });

  it('revoke_file_permission rejects missing permissionId', async () => {
    const result = await client.callTool('revoke_file_permission', { path: 'item-1' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.next_step).toBe('list_file_permissions');
  });

  // -------------------------------------------------------------------------
  // list_file_versions
  // -------------------------------------------------------------------------
  it('list_file_versions returns formatted version history', async () => {
    const result = await client.callTool('list_file_versions', { path: 'item-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      count: number;
      versions: Array<{ id: string; size: string; lastModifiedBy?: string }>;
    };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(2);
    expect(json.versions[0]?.id).toBe('2.0');
    expect(json.versions[0]?.lastModifiedBy).toContain('untrusted-content');
    expect(json.versions[0]?.lastModifiedBy).toContain('Jane Doe');
    const call = state.requests.find(
      (r) => r.method === 'GET' && r.pathname.includes('/me/drive/items/item-1/versions'),
    );
    expect(call).toBeDefined();
  });

  it('list_file_versions rejects missing path', async () => {
    const result = await client.callTool('list_file_versions', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.next_step).toBe('list_file_versions');
  });

  // -------------------------------------------------------------------------
  // restore_file_version
  // -------------------------------------------------------------------------
  it('restore_file_version POSTs to restoreVersion', async () => {
    const result = await client.callTool('restore_file_version', {
      path: 'item-1',
      versionId: '1.0',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; success: boolean; versionId: string };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    expect(json.versionId).toBe('1.0');
    const call = state.requests.find(
      (r) =>
        r.method === 'POST' &&
        r.pathname.includes('/me/drive/items/item-1/versions/1.0/restoreVersion'),
    );
    expect(call).toBeDefined();
  });

  it('restore_file_version rejects missing versionId with WARNING guidance', async () => {
    const result = await client.callTool('restore_file_version', { path: 'item-1' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('WARNING');
    expect(json.next_step).toBe('list_file_versions');
  });

  // -------------------------------------------------------------------------
  // list_file_activities
  // -------------------------------------------------------------------------
  it('list_file_activities returns the drive-wide feed with enveloped fields', async () => {
    const result = await client.callTool('list_file_activities', {});
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      count: number;
      activities: Array<{
        id: string;
        actions: string[];
        actor?: string;
        item?: { name?: string };
      }>;
    };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(1);
    expect(json.activities[0]?.actions).toEqual(['edit']);
    expect(json.activities[0]?.actor).toContain('untrusted-content');
    expect(json.activities[0]?.actor).toContain('Jane Doe');
    expect(json.activities[0]?.item?.name).toContain('report.docx');
    const call = state.requests.find(
      (r) => r.method === 'GET' && r.pathname.endsWith('/me/drive/activities'),
    );
    expect(call).toBeDefined();
  });

  it('list_file_activities with a path hits the item activities endpoint', async () => {
    const result = await client.callTool('list_file_activities', { path: 'item-1' });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'GET' && r.pathname.includes('/me/drive/items/item-1/activities'),
    );
    expect(call).toBeDefined();
  });
});
