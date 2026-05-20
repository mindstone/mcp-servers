import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@mindstone/mcp-server-microsoft-shared';
import {
  copyLibraryItem,
  createLibraryFolder,
  createListItem,
  createSharingLink,
  deleteLibraryItem,
  deleteListItem,
  downloadLibraryFile,
  getFileMetadata,
  getLibraryFile,
  getLibraryTree,
  getListItem,
  getRecentFiles,
  getSharePointSite,
  getSiteByPath,
  getSiteDrive,
  getSiteItem,
  getSiteList,
  getSitesDelta,
  listLibraryFiles,
  listListItems,
  listSharePointSites,
  listSiteDocumentLibraries,
  listSiteItems,
  listSiteLists,
  listSitePages,
  listSubsites,
  moveLibraryItem,
  readLibraryTextFile,
  readSitePage,
  renameLibraryItem,
  searchLibraryFiles,
  searchSharePoint,
  updateFileMetadata,
  updateListItem,
  uploadLibraryFile,
} from '../src/sharepoint.js';

interface MockBuilder {
  options: ReturnType<typeof vi.fn>;
  filter: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
  expand: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  top: ReturnType<typeof vi.fn>;
  orderby: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

interface MockSetup {
  client: Client;
  builder: MockBuilder;
  apiSpy: ReturnType<typeof vi.fn>;
}

function createMockClient(): MockSetup {
  const builder = {} as MockBuilder;
  builder.options = vi.fn().mockReturnValue(builder);
  builder.filter = vi.fn().mockReturnValue(builder);
  builder.header = vi.fn().mockReturnValue(builder);
  builder.expand = vi.fn().mockReturnValue(builder);
  builder.select = vi.fn().mockReturnValue(builder);
  builder.top = vi.fn().mockReturnValue(builder);
  builder.orderby = vi.fn().mockReturnValue(builder);
  builder.get = vi.fn().mockResolvedValue({
    value: [],
    id: 'item-1',
    name: 'item.txt',
    size: 10,
    file: { mimeType: 'text/plain' },
    fields: {},
    '@microsoft.graph.downloadUrl': 'https://downloads.example.com/item-1',
  });
  builder.post = vi.fn().mockResolvedValue({ id: 'mock-id' });
  builder.put = vi.fn().mockResolvedValue({ id: 'mock-id', name: 'mock', size: 0 });
  builder.patch = vi.fn().mockResolvedValue({ id: 'mock-id', name: 'mock' });
  builder.delete = vi.fn().mockResolvedValue(undefined);

  const apiSpy = vi.fn().mockReturnValue(builder);
  const client = { api: apiSpy } as unknown as Client;
  return { client, builder, apiSpy };
}

describe('Graph request signal propagation', () => {
  const cases: Array<{
    name: string;
    invoke: (client: Client, signal: AbortSignal) => Promise<unknown>;
  }> = [
    { name: 'listSharePointSites', invoke: (c, s) => listSharePointSites(c, { top: 1 }, s) },
    { name: 'getSharePointSite', invoke: (c, s) => getSharePointSite(c, { siteId: 'site-1' }, s) },
    { name: 'listSiteDocumentLibraries', invoke: (c, s) => listSiteDocumentLibraries(c, { siteId: 'site-1' }, s) },
    { name: 'listLibraryFiles', invoke: (c, s) => listLibraryFiles(c, { driveId: 'drive-1' }, s) },
    { name: 'getLibraryFile', invoke: (c, s) => getLibraryFile(c, { driveId: 'drive-1', itemId: 'item-1' }, s) },
    { name: 'downloadLibraryFile', invoke: (c, s) => downloadLibraryFile(c, { driveId: 'drive-1', itemId: 'item-1' }, s) },
    { name: 'searchLibraryFiles', invoke: (c, s) => searchLibraryFiles(c, { driveId: 'drive-1', query: 'report' }, s) },
    { name: 'readLibraryTextFile', invoke: (c, s) => readLibraryTextFile(c, { driveId: 'drive-1', itemId: 'item-1' }, s) },
    { name: 'uploadLibraryFile', invoke: (c, s) => uploadLibraryFile(c, { driveId: 'drive-1', path: 'General/x.txt', content: 'x' }, s) },
    { name: 'createLibraryFolder', invoke: (c, s) => createLibraryFolder(c, { driveId: 'drive-1', path: 'General/New' }, s) },
    { name: 'deleteLibraryItem', invoke: (c, s) => deleteLibraryItem(c, { driveId: 'drive-1', itemId: 'item-1' }, s) },
    { name: 'moveLibraryItem', invoke: (c, s) => moveLibraryItem(c, { driveId: 'drive-1', itemId: 'item-1', destinationFolderId: 'folder-1' }, s) },
    { name: 'copyLibraryItem', invoke: (c, s) => copyLibraryItem(c, { driveId: 'drive-1', itemId: 'item-1', destinationFolderId: 'folder-1' }, s) },
    { name: 'listSitePages', invoke: (c, s) => listSitePages(c, { siteId: 'site-1' }, s) },
    { name: 'readSitePage', invoke: (c, s) => readSitePage(c, { siteId: 'site-1', pageId: 'page-1' }, s) },
    { name: 'listSiteLists', invoke: (c, s) => listSiteLists(c, { siteId: 'site-1' }, s) },
    { name: 'listListItems', invoke: (c, s) => listListItems(c, { siteId: 'site-1', listId: 'list-1' }, s) },
    { name: 'getListItem', invoke: (c, s) => getListItem(c, { siteId: 'site-1', listId: 'list-1', itemId: '1' }, s) },
    { name: 'createListItem', invoke: (c, s) => createListItem(c, { siteId: 'site-1', listId: 'list-1', fields: { Title: 'x' } }, s) },
    { name: 'updateListItem', invoke: (c, s) => updateListItem(c, { siteId: 'site-1', listId: 'list-1', itemId: '1', fields: { Status: 'x' } }, s) },
    { name: 'deleteListItem', invoke: (c, s) => deleteListItem(c, { siteId: 'site-1', listId: 'list-1', itemId: '1' }, s) },
    { name: 'searchSharePoint', invoke: (c, s) => searchSharePoint(c, { query: 'budget' }, s) },
    { name: 'renameLibraryItem', invoke: (c, s) => renameLibraryItem(c, { driveId: 'drive-1', itemId: 'item-1', newName: 'renamed.txt' }, s) },
    { name: 'createSharingLink', invoke: (c, s) => createSharingLink(c, { driveId: 'drive-1', itemId: 'item-1', type: 'view' }, s) },
    { name: 'listSubsites', invoke: (c, s) => listSubsites(c, { siteId: 'site-1' }, s) },
    { name: 'getRecentFiles', invoke: (c, s) => getRecentFiles(c, { top: 1 }, s) },
    { name: 'getLibraryTree', invoke: (c, s) => getLibraryTree(c, { driveId: 'drive-1', maxDepth: 1 }, s) },
    { name: 'getFileMetadata', invoke: (c, s) => getFileMetadata(c, { driveId: 'drive-1', itemId: 'item-1' }, s) },
    { name: 'updateFileMetadata', invoke: (c, s) => updateFileMetadata(c, { driveId: 'drive-1', itemId: 'item-1', fields: { Status: 'Updated' } }, s) },
    { name: 'getSiteDrive', invoke: (c, s) => getSiteDrive(c, { siteId: 'site-1', driveId: 'drive-1' }, s) },
    { name: 'listSiteItems', invoke: (c, s) => listSiteItems(c, { siteId: 'site-1' }, s) },
    { name: 'getSiteItem', invoke: (c, s) => getSiteItem(c, { siteId: 'site-1', itemId: 'site-item-1' }, s) },
    { name: 'getSiteList', invoke: (c, s) => getSiteList(c, { siteId: 'site-1', listId: 'list-1' }, s) },
    { name: 'getSiteByPath', invoke: (c, s) => getSiteByPath(c, { siteId: 'site-1', path: '/departments/hr' }, s) },
    { name: 'getSitesDelta', invoke: (c, s) => getSitesDelta(c, {}, s) },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} passes signal to GraphRequest.options`, async () => {
      const { client, builder } = createMockClient();
      const signal = new AbortController().signal;
      await testCase.invoke(client, signal);
      expect(builder.options).toHaveBeenCalledWith({ signal });
    });
  }
});

describe('callGraph + withGraphRetry signal propagation', () => {
  it('callGraph invokes fn with a composed AbortSignal', async () => {
    vi.stubEnv('MS_CONFIG_DIR', '/tmp/microsoft-sharepoint-mock-noop');
    vi.stubEnv('MS_CLIENT_ID', 'mock-client');
    vi.resetModules();

    const sharedMock = {
      createGraphClientWithRetry: vi.fn().mockReturnValue({
        client: { api: vi.fn() },
        tokenProvider: { invalidateCachedToken: vi.fn() },
      }),
      createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    };
    vi.doMock('@mindstone/mcp-server-microsoft-shared', () => sharedMock);

    const { callGraph } = await import('../src/client.js');
    const fn = vi.fn(async (_client: unknown, signal: AbortSignal) => signal);
    const signal = await callGraph({}, fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(fn.mock.calls[0][1]).toBeInstanceOf(AbortSignal);

    vi.doUnmock('@mindstone/mcp-server-microsoft-shared');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('withGraphRetry threads the same signal into both attempts on 401', async () => {
    vi.stubEnv('MS_CONFIG_DIR', '/tmp/microsoft-sharepoint-mock-noop');
    vi.stubEnv('MS_CLIENT_ID', 'mock-client');
    vi.resetModules();

    const invalidateCachedToken = vi.fn();
    const sharedMock = {
      createGraphClientWithRetry: vi.fn().mockReturnValue({
        client: { api: vi.fn() },
        tokenProvider: { invalidateCachedToken },
      }),
      createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    };
    vi.doMock('@mindstone/mcp-server-microsoft-shared', () => sharedMock);

    const { withGraphRetry } = await import('../src/client.js');

    const signal = new AbortController().signal;
    const observed: AbortSignal[] = [];
    const fn = vi.fn(async (_client: unknown, s: AbortSignal) => {
      observed.push(s);
      if (observed.length === 1) {
        const err = new Error('Unauthorized') as Error & { statusCode?: number };
        err.statusCode = 401;
        throw err;
      }
      return 'ok';
    });

    const result = await withGraphRetry(fn, signal);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(observed[0]).toBe(signal);
    expect(observed[1]).toBe(signal);
    expect(invalidateCachedToken).toHaveBeenCalledOnce();

    vi.doUnmock('@mindstone/mcp-server-microsoft-shared');
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
