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
});
