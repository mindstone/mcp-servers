import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

// Every Graph request is recorded by method and raw URL so the tests can
// assert the exact request target, and that a refused argument makes none.
let graphRequests: Array<{ method: string; url: string }> = [];

function recordAllGraphRequests(): void {
  mswServer.use(
    http.all('https://graph.microsoft.com/*', ({ request }) => {
      graphRequests.push({ method: request.method, url: request.url });
      return HttpResponse.json({
        id: 'item-1',
        name: 'a.txt',
        size: 5,
        file: { mimeType: 'text/plain' },
        value: [],
      });
    }),
  );
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

interface ErrorEnvelope {
  ok: boolean;
  error: string;
  action_required: string;
  next_step?: string;
}

describe('microsoft-files request targets', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir();
    client = await createTestClient({
      env: { MS_CLIENT_ID: 'mock-client-id', MS_CONFIG_DIR: cfg.configPath },
    });
  });

  beforeEach(() => {
    graphRequests = [];
    recordAllGraphRequests();
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  async function expectRefused(
    tool: string,
    args: Record<string, unknown>,
    field: string,
    hostileMarker: string,
  ): Promise<void> {
    const result = await client.callTool(tool, args);
    expect(
      graphRequests.map((r) => `${r.method} ${r.url}`),
      'raw Graph requests made',
    ).toEqual([]);
    expect(result.isError).toBe(true);
    const json = result.json as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(json.error).toContain(`"${field}"`);
    expect(json.error).not.toContain(hostileMarker);
    expect(json.action_required).not.toMatch(/authenticat/i);
    expect(json.next_step).toBeTruthy();
  }

  describe('hostile paths and IDs are refused before any Graph request', () => {
    it.each([
      ['get_file', { path: '/Documents/../../../users/victim/drive/root' }, 'path', 'victim'],
      ['get_file', { path: 'item-1/../../../users/victim' }, 'path', 'victim'],
      ['get_file', { path: 'item-1?$expand=victim' }, 'path', 'victim'],
      ['get_file', { path: 'item-1#victim' }, 'path', 'victim'],
      ['get_file', { path: '%2e%2e-files-percent-marker' }, 'path', 'files-percent-marker'],
      ['delete_file', { path: '../files-delete-marker' }, 'path', 'files-delete-marker'],
      ['delete_file', { path: '/../files-delete-root-marker' }, 'path', 'files-delete-root-marker'],
      ['list_files', { path: '../files-list-marker' }, 'path', 'files-list-marker'],
      ['upload_file', { path: '/Docs/../../files-upload-marker.txt', content: 'x' }, 'path', 'files-upload-marker'],
      ['create_folder', { path: '/Docs/../../files-folder-marker' }, 'path', 'files-folder-marker'],
      ['move_file', { sourcePath: 'item-1', destinationPath: '../files-move-marker' }, 'destinationPath', 'files-move-marker'],
      ['move_file', { sourcePath: '/a/../files-source-marker', destinationPath: '/Docs' }, 'sourcePath', 'files-source-marker'],
      ['copy_file', { sourcePath: '/a/../files-copy-marker', destinationPath: '/Docs' }, 'sourcePath', 'files-copy-marker'],
      ['share_file', { path: 'item-1/../../files-share-marker' }, 'path', 'files-share-marker'],
      ['read_text_file', { path: '/Docs/../files-read-text-marker' }, 'path', 'files-read-text-marker'],
      ['read_document', { path: '/Docs/\\files-read-document-marker' }, 'path', 'files-read-document-marker'],
      ['revoke_file_permission', { path: 'item-1', permissionId: '../files-permission-marker' }, 'permissionId', 'files-permission-marker'],
      ['revoke_file_permission', { path: 'item-1', permissionId: 'p?x=files-permission-query-marker' }, 'permissionId', 'files-permission-query-marker'],
      ['restore_file_version', { path: 'item-1', versionId: '../files-version-marker' }, 'versionId', 'files-version-marker'],
      ['list_file_activities', { path: '../files-activity-marker' }, 'path', 'files-activity-marker'],
    ])('%s %j', async (tool, args, field, hostileMarker) => {
      await expectRefused(tool, args as Record<string, unknown>, field, hostileMarker);
    });
  });

  describe('drive paths are encoded per segment', () => {
    it.each([
      ['/Docs/a#b.txt', '/v1.0/me/drive/root:/Docs/a%23b.txt'],
      ['/Docs/50%.xlsx', '/v1.0/me/drive/root:/Docs/50%25.xlsx'],
      ['/Docs/%2e%2e', '/v1.0/me/drive/root:/Docs/%252e%252e'],
      ['/Docs/what?.txt', '/v1.0/me/drive/root:/Docs/what%3F.txt'],
    ])('get_file %j', async (path, expected) => {
      const result = await client.callTool('get_file', { path });
      expect(result.isError).not.toBe(true);
      expect(pathOf(graphRequests[0]!.url)).toBe(expected);
    });

    it('keeps spaces and Unicode names reaching the same item', async () => {
      const path = '/Documents/Q3 Report – résumé 日本.docx';
      await client.callTool('get_file', { path });
      expect(decodeURIComponent(pathOf(graphRequests[0]!.url))).toBe(`/v1.0/me/drive/root:${path}`);
    });

    it('list_files on the drive root uses /root/children', async () => {
      await client.callTool('list_files', { path: '/' });
      expect(pathOf(graphRequests[0]!.url)).toBe('/v1.0/me/drive/root/children');
    });

    it('upload_file encodes the target path', async () => {
      await client.callTool('upload_file', { path: '/Docs/a#1.txt', content: 'hi' });
      expect(graphRequests[0]!.method).toBe('PUT');
      expect(pathOf(graphRequests[0]!.url)).toBe('/v1.0/me/drive/root:/Docs/a%231.txt:/content');
    });

    it('create_folder encodes the parent path', async () => {
      await client.callTool('create_folder', { path: '/Team #1/New' });
      expect(pathOf(graphRequests[0]!.url)).toBe('/v1.0/me/drive/root:/Team%20%231:/children');
    });

    it('move_file encodes a path destination', async () => {
      await client.callTool('move_file', { sourcePath: 'item-1', destinationPath: '/Archive #2' });
      expect(pathOf(graphRequests[0]!.url)).toBe('/v1.0/me/drive/root:/Archive%20%232');
    });
  });

  describe('a path-addressed item with a suffix closes the path with ":"', () => {
    it.each([
      ['share_file', { path: '/Docs/a.txt' }, 'POST', '/v1.0/me/drive/root:/Docs/a.txt:/createLink'],
      [
        'invite_to_file',
        { path: '/Docs/a.txt', recipients: ['alice@example.com'] },
        'POST',
        '/v1.0/me/drive/root:/Docs/a.txt:/invite',
      ],
      ['list_file_permissions', { path: '/Docs/a.txt' }, 'GET', '/v1.0/me/drive/root:/Docs/a.txt:/permissions'],
      [
        'revoke_file_permission',
        { path: '/Docs/a.txt', permissionId: 'perm-2' },
        'DELETE',
        '/v1.0/me/drive/root:/Docs/a.txt:/permissions/perm-2',
      ],
      ['list_file_versions', { path: '/Docs/a.txt' }, 'GET', '/v1.0/me/drive/root:/Docs/a.txt:/versions'],
      [
        'restore_file_version',
        { path: '/Docs/a.txt', versionId: '1.0' },
        'POST',
        '/v1.0/me/drive/root:/Docs/a.txt:/versions/1.0/restoreVersion',
      ],
      ['list_file_activities', { path: '/Docs/a.txt' }, 'GET', '/v1.0/me/drive/root:/Docs/a.txt:/activities'],
    ])('%s', async (tool, args, method, expected) => {
      await client.callTool(tool, args as Record<string, unknown>);
      const call = graphRequests.find((r) => r.method === method);
      expect(call && pathOf(call.url)).toBe(expected);
    });

    it('read_text_file downloads from :/content', async () => {
      const result = await client.callTool('read_text_file', { path: '/Docs/a.txt' });
      expect(result.isError).not.toBe(true);
      expect(graphRequests.map((r) => pathOf(r.url))).toEqual([
        '/v1.0/me/drive/root:/Docs/a.txt',
        '/v1.0/me/drive/root:/Docs/a.txt:/content',
      ]);
    });

    it('copy_file posts to :/copy', async () => {
      await client.callTool('copy_file', { sourcePath: '/Docs/a.txt', destinationPath: '/Archive' });
      const post = graphRequests.find((r) => r.method === 'POST');
      expect(post && pathOf(post.url)).toBe('/v1.0/me/drive/root:/Docs/a.txt:/copy');
    });
  });

  describe('item IDs', () => {
    it('sends an item ID with reserved characters as one encoded segment', async () => {
      await client.callTool('get_file', { path: 'b!AbC-dE_f=' });
      expect(pathOf(graphRequests[0]!.url)).toBe('/v1.0/me/drive/items/b!AbC-dE_f%3D');
    });

    it('keeps an ordinary item ID unchanged', async () => {
      await client.callTool('delete_file', { path: '01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K' });
      expect(pathOf(graphRequests[0]!.url)).toBe(
        '/v1.0/me/drive/items/01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K',
      );
    });
  });

  describe('search_files', () => {
    it('doubles a single quote inside the search literal', async () => {
      await client.callTool('search_files', { query: "Jane's notes" });
      expect(pathOf(graphRequests[0]!.url)).toBe(
        "/v1.0/me/drive/root/search(q='Jane''s%20notes')",
      );
    });

    it('cannot close the literal and change the route', async () => {
      await client.callTool('search_files', { query: "x')/../../users/victim/drive/root/search(q='" });
      const path = decodeURIComponent(pathOf(graphRequests[0]!.url));
      expect(path).toBe(
        "/v1.0/me/drive/root/search(q='x'')/../../users/victim/drive/root/search(q=''')",
      );
    });
  });
});
