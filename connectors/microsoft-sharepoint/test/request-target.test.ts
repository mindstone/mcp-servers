import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Client } from '@microsoft/microsoft-graph-client';
import { mswServer } from './fixtures/setup.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

// Every Graph request is recorded by its raw URL so the tests can assert the
// exact request target, and that a refused argument makes no request at all.
let graphUrls: string[] = [];

function recordAllGraphRequests(): void {
  mswServer.use(
    http.all('https://graph.microsoft.com/*', ({ request }) => {
      graphUrls.push(request.url);
      return HttpResponse.json({
        id: 'item-1',
        name: 'a.txt',
        displayName: 'Site',
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

const SITE = 'acme.sharepoint.com,2c712604-1370-44e7-a1f5-426573fdc3c8,2d2244e3-7ba1-4b5d-a6a9-1f0d1e2a3b4c';
const SITE_SEGMENT = SITE.replace(/,/g, '%2C');
const DRIVE = 'b!abc-DEF_123';

describe('microsoft-sharepoint request targets', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir();
    client = await createTestClient({
      env: { MS_CLIENT_ID: 'mock-client-id', MS_CONFIG_DIR: cfg.configPath },
    });
  });

  beforeEach(() => {
    graphUrls = [];
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
    hostileMarker = 'victim',
  ): Promise<ErrorEnvelope> {
    const result = await client.callTool(tool, args);
    expect(graphUrls, `raw Graph requests made: ${graphUrls.join(', ')}`).toEqual([]);
    expect(result.isError).toBe(true);
    const json = result.json as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(json.error).toContain(`"${field}"`);
    expect(json.error).not.toContain(hostileMarker);
    expect(json.action_required).not.toMatch(/authenticat/i);
    expect(json.next_step).toBeTruthy();
    return json;
  }

  async function call(tool: string, args: Record<string, unknown>): Promise<string[]> {
    const result = await client.callTool(tool, args);
    expect(result.isError, JSON.stringify(result.json)).not.toBe(true);
    return graphUrls.map(pathOf);
  }

  describe('hostile site IDs are refused before any Graph request', () => {
    it.each([
      ['../../users/victim', 'victim'],
      ['acme.sharepoint.com:/sites/../../users/victim', 'victim'],
      ['victim?$select=id', 'victim'],
      ['victim.example#x', 'victim'],
      ['%2e%2e-sharepoint-percent-marker', 'sharepoint-percent-marker'],
      ['../sharepoint-dot-marker', 'sharepoint-dot-marker'],
    ])('get_sharepoint_site siteId %j', async (siteId, hostileMarker) => {
      await expectRefused('get_sharepoint_site', { siteId }, 'siteId', hostileMarker);
    });

    it.each([
      ['list_site_document_libraries', {}],
      ['list_site_pages', {}],
      ['create_site_page', { title: 'T' }],
      ['list_site_lists', {}],
      ['create_site_list', { displayName: 'L' }],
      ['list_subsites', {}],
      ['list_site_items', {}],
      ['get_site_by_path', { path: '/hr' }],
    ])('%s with a traversal siteId', async (tool, extra) => {
      await expectRefused(tool, { siteId: '../victim', ...extra }, 'siteId');
    });
  });

  describe('hostile drive, item, list, page and permission IDs are refused', () => {
    it.each([
      ['list_library_files', { driveId: '../victim' }, 'driveId'],
      ['get_library_file', { driveId: DRIVE, itemId: '../../victim' }, 'itemId'],
      ['download_library_file', { driveId: DRIVE, itemId: '..' }, 'itemId'],
      ['search_library_files', { driveId: '../victim', query: 'x' }, 'driveId'],
      ['read_library_text_file', { driveId: DRIVE, itemId: 'victim?x=1' }, 'itemId'],
      ['delete_library_item', { driveId: DRIVE, itemId: '..' }, 'itemId'],
      ['move_library_item', { driveId: DRIVE, itemId: '../victim', destinationFolderId: 'f1' }, 'itemId'],
      ['copy_library_item', { driveId: DRIVE, itemId: '../victim', destinationFolderId: 'f1' }, 'itemId'],
      ['rename_library_item', { driveId: DRIVE, itemId: '../victim', newName: 'n' }, 'itemId'],
      ['create_sharing_link', { driveId: '../victim', itemId: 'i1' }, 'driveId'],
      ['list_file_versions', { driveId: DRIVE, itemId: '../victim' }, 'itemId'],
      ['list_item_permissions', { driveId: DRIVE, itemId: '../victim' }, 'itemId'],
      ['invite_item_collaborators', { driveId: DRIVE, itemId: '../victim', recipients: ['jane@example.com'] }, 'itemId'],
      ['revoke_item_permission', { driveId: DRIVE, itemId: 'i1', permissionId: '../victim' }, 'permissionId'],
      ['get_file_metadata', { driveId: DRIVE, itemId: '../victim' }, 'itemId'],
      ['update_file_metadata', { driveId: DRIVE, itemId: '../victim', fields: { Title: 'x' } }, 'itemId'],
      ['get_library_tree', { driveId: DRIVE, folderId: '../victim' }, 'folderId'],
      ['get_site_drive', { siteId: SITE, driveId: '../victim' }, 'driveId'],
      ['read_site_page', { siteId: SITE, pageId: '../victim' }, 'pageId'],
      ['update_site_page', { siteId: SITE, pageId: '../victim', title: 'T' }, 'pageId'],
      ['publish_site_page', { siteId: SITE, pageId: '../victim' }, 'pageId'],
      ['list_list_items', { siteId: SITE, listId: '../victim' }, 'listId'],
      ['get_list_item', { siteId: SITE, listId: 'l1', itemId: '..' }, 'itemId'],
      ['create_list_item', { siteId: SITE, listId: '../victim', fields: { Title: 'x' } }, 'listId'],
      ['update_list_item', { siteId: SITE, listId: 'l1', itemId: '../victim', fields: { Title: 'x' } }, 'itemId'],
      ['delete_list_item', { siteId: SITE, listId: 'l1', itemId: '../victim' }, 'itemId'],
      ['list_list_columns', { siteId: SITE, listId: '../victim' }, 'listId'],
      ['get_site_item', { siteId: SITE, itemId: '../victim' }, 'itemId'],
      ['get_site_list', { siteId: SITE, listId: '../victim' }, 'listId'],
    ])('%s refuses %j', async (tool, args, field) => {
      await expectRefused(tool, args, field);
    });
  });

  describe('hostile drive paths are refused', () => {
    it.each([
      ['list_library_files', { driveId: DRIVE, path: '/General/../../victim' }],
      ['upload_library_file', { driveId: DRIVE, path: 'General/../../victim.txt', content: 'x' }],
      ['upload_library_file_binary', { driveId: DRIVE, path: 'a/../victim.bin', contentBase64: 'eA==' }],
      ['create_library_folder', { driveId: DRIVE, path: 'a/../victim' }],
      ['get_site_by_path', { siteId: SITE, path: '/hr/../../victim' }],
      ['get_site_by_path', { siteId: SITE, path: "/hr\\victim" }],
    ])('%s refuses %j', async (tool, args) => {
      await expectRefused(tool, args, 'path');
    });
  });

  describe('real IDs and paths still reach the same resource', () => {
    it('sends the opaque site ID as one segment', async () => {
      expect(await call('get_sharepoint_site', { siteId: SITE })).toEqual([`/v1.0/sites/${SITE_SEGMENT}`]);
    });

    it('keeps the hostname:/path site form as today for the site itself', async () => {
      expect(await call('get_sharepoint_site', { siteId: 'acme.sharepoint.com:/sites/marketing' })).toEqual([
        '/v1.0/sites/acme.sharepoint.com:/sites/marketing',
      ]);
    });

    it('closes the hostname:/path site form before a further segment', async () => {
      expect(await call('list_site_lists', { siteId: 'acme.sharepoint.com:/sites/marketing' })).toEqual([
        '/v1.0/sites/acme.sharepoint.com:/sites/marketing:/lists',
      ]);
    });

    it('accepts root and a bare hostname', async () => {
      expect(await call('get_sharepoint_site', { siteId: 'root' })).toEqual(['/v1.0/sites/root']);
      graphUrls = [];
      expect(await call('get_sharepoint_site', { siteId: 'acme.sharepoint.com' })).toEqual([
        '/v1.0/sites/acme.sharepoint.com',
      ]);
    });

    it('encodes a list title with spaces', async () => {
      expect(await call('list_list_items', { siteId: SITE, listId: 'Project Tasks' })).toEqual([
        `/v1.0/sites/${SITE_SEGMENT}/lists/Project%20Tasks/items`,
      ]);
    });

    it('keeps drive and item IDs that need no encoding unchanged', async () => {
      expect(await call('get_library_file', { driveId: DRIVE, itemId: '01ABCDEF2GHIJKL' })).toEqual([
        `/v1.0/drives/${DRIVE}/items/01ABCDEF2GHIJKL`,
      ]);
    });

    it('encodes a permission ID', async () => {
      expect(
        await call('revoke_item_permission', { driveId: DRIVE, itemId: 'i1', permissionId: 'aRlYmZjN2Fi=' }),
      ).toEqual([`/v1.0/drives/${DRIVE}/items/i1/permissions/aRlYmZjN2Fi%3D`]);
    });

    it.each([
      ['General/Q3 Report', `/v1.0/drives/${DRIVE}/root:/General/Q3%20Report:/children`],
      ['/', `/v1.0/drives/${DRIVE}/root/children`],
      ['/General/a#1', `/v1.0/drives/${DRIVE}/root:/General/a%231:/children`],
    ])('list_library_files path %j', async (path, expected) => {
      expect(await call('list_library_files', { driveId: DRIVE, path })).toEqual([expected]);
    });

    it('uploads to an encoded path', async () => {
      expect(
        await call('upload_library_file', { driveId: DRIVE, path: 'General/50% #1.txt', content: 'x' }),
      ).toEqual([`/v1.0/drives/${DRIVE}/root:/General/50%25%20%231.txt:/content`]);
    });

    it('creates a folder under an encoded parent path', async () => {
      expect(
        await call('create_library_folder', { driveId: DRIVE, path: 'Team Files/New Folder' }),
      ).toEqual([`/v1.0/drives/${DRIVE}/root:/Team%20Files:/children`]);
    });

    it('get_site_by_path encodes the path and doubles quotes', async () => {
      const urls = await call('get_site_by_path', { siteId: SITE, path: "/Jane's site/hr" });
      expect(urls).toEqual([`/v1.0/sites/${SITE_SEGMENT}/getByPath(path='/Jane''s%20site/hr')`]);
    });
  });

  describe('query values stay one parameter', () => {
    it("search_library_files keeps the query inside search(q='...')", async () => {
      expect(await call('search_library_files', { driveId: DRIVE, query: "Jane's notes" })).toEqual([
        `/v1.0/drives/${DRIVE}/root/search(q='Jane''s%20notes')`,
      ]);
    });

    it('search_library_files cannot break out of the literal into another path', async () => {
      const query = "x')/../../users/victim/drive/root/search(q='";
      const [path] = await call('search_library_files', { driveId: DRIVE, query });
      expect(path).toBe(
        `/v1.0/drives/${DRIVE}/root/search(q=${"'x'')%2F..%2F..%2Fusers%2Fvictim%2Fdrive%2Froot%2Fsearch(q%3D'''"})`,
      );
    });

    it('list_list_items filter cannot add query keys', async () => {
      const filter = "fields/Status eq 'Active'&$top=999&$select=id";
      await call('list_list_items', { siteId: SITE, listId: 'l1', filter });
      const params = new URL(graphUrls[0]!).searchParams;
      expect(params.get('$filter')).toBe(filter);
      expect(params.getAll('$top')).toEqual(['50']);
      expect(params.get('$select')).toBeNull();
    });
  });

  describe('get_sites_delta', () => {
    it('refuses a beta delta link', async () => {
      const result = await client.callTool('get_sites_delta', {
        deltaLink: 'https://graph.microsoft.com/beta/sites/delta?token=abc',
      });
      expect(result.isError).toBe(true);
      expect((result.json as ErrorEnvelope).error).toContain('deltaLink');
      expect(graphUrls).toEqual([]);
    });

    it('follows a v1.0 delta link', async () => {
      const urls = await call('get_sites_delta', {
        deltaLink: 'https://graph.microsoft.com/v1.0/sites/delta?$deltatoken=abc',
      });
      expect(urls).toEqual(['/v1.0/sites/delta']);
    });
  });
});

describe('Graph SDK query building (pinned)', () => {
  beforeEach(() => {
    graphUrls = [];
    recordAllGraphRequests();
  });

  it('does not encode .filter() values, so the connector must', async () => {
    const sdk = Client.init({ authProvider: (done) => done(null, 'test-token') });
    await sdk.api('/sites/s/lists/l/items').filter("fields/Status eq 'A'&$top=999").get();
    const params = new URL(graphUrls[0]!).searchParams;
    expect(params.get('$filter')).toBe("fields/Status eq 'A'");
    expect(params.get('$top')).toBe('999');
  });
});
