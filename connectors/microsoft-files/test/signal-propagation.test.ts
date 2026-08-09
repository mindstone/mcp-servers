import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@mindstone/mcp-server-microsoft-shared';
import {
  copyFile,
  createFolder,
  deleteFile,
  downloadFile,
  getFile,
  getRecent,
  getShared,
  listFiles,
  moveFile,
  searchFiles,
  shareFile,
  uploadFile,
} from '../src/files.js';

interface MockBuilder {
  options: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  top: ReturnType<typeof vi.fn>;
  orderby: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
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
  builder.select = vi.fn().mockReturnValue(builder);
  builder.top = vi.fn().mockReturnValue(builder);
  builder.orderby = vi.fn().mockReturnValue(builder);
  builder.header = vi.fn().mockReturnValue(builder);
  builder.get = vi.fn().mockImplementation(async () => ({ value: [] }));
  builder.post = vi.fn().mockResolvedValue({ id: 'mock-id' });
  builder.put = vi.fn().mockResolvedValue({ id: 'mock-id', name: 'mock', size: 0 });
  builder.patch = vi.fn().mockResolvedValue({ id: 'mock-id', name: 'mock' });
  builder.delete = vi.fn().mockResolvedValue(undefined);

  const apiSpy = vi.fn().mockReturnValue(builder);
  const client = { api: apiSpy } as unknown as Client;
  return { client, builder, apiSpy };
}

describe('Graph request signal propagation', () => {
  it('listFiles passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await listFiles(client, { top: 5 }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('getFile passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    builder.get.mockResolvedValueOnce({ id: 'f-1', name: 'x.txt' });
    const signal = new AbortController().signal;
    await getFile(client, { path: '/Documents/x.txt' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('downloadFile passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    builder.get.mockResolvedValueOnce({
      id: 'f-1',
      name: 'x.txt',
      '@microsoft.graph.downloadUrl': 'https://example.com/download',
    });
    const signal = new AbortController().signal;
    await downloadFile(client, { path: '/Documents/x.txt' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('searchFiles passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await searchFiles(client, { query: 'report', top: 5 }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('uploadFile passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    builder.put.mockResolvedValueOnce({
      id: 'new-1',
      name: 'notes.txt',
      size: 42,
      webUrl: 'https://example.com/new-1',
    });
    const signal = new AbortController().signal;
    await uploadFile(client, { path: '/notes.txt', content: 'hello' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('createFolder passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    builder.post.mockResolvedValueOnce({
      id: 'folder-new',
      name: 'NewFolder',
      webUrl: 'https://example.com/folder-new',
    });
    const signal = new AbortController().signal;
    await createFolder(client, { path: '/Documents/NewFolder' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('deleteFile passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await deleteFile(client, { path: '/Documents/old.txt' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('moveFile passes signal to GraphRequest.options on both Graph calls', async () => {
    const { client, builder } = createMockClient();
    builder.get.mockResolvedValueOnce({ id: 'dest-folder' });
    builder.patch.mockResolvedValueOnce({
      id: 'file-1',
      name: 'moved.txt',
      webUrl: 'https://example.com/file-1',
    });
    const signal = new AbortController().signal;
    await moveFile(
      client,
      {
        sourcePath: '/Documents/file.txt',
        destinationPath: '/Archive',
        newName: 'moved.txt',
      },
      signal,
    );
    expect(builder.options).toHaveBeenCalledWith({ signal });
    expect(builder.options.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('copyFile passes signal to GraphRequest.options on every Graph call', async () => {
    const { client, builder } = createMockClient();
    builder.get
      .mockResolvedValueOnce({ id: 'src-1', name: 'template.docx' })
      .mockResolvedValueOnce({ id: 'dest-folder' });
    builder.post.mockResolvedValueOnce(undefined);
    const signal = new AbortController().signal;
    await copyFile(
      client,
      {
        sourcePath: '/Documents/template.docx',
        destinationPath: '/Projects',
      },
      signal,
    );
    expect(builder.options).toHaveBeenCalledWith({ signal });
    expect(builder.options.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('getRecent passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await getRecent(client, { top: 5 }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('getShared passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await getShared(client, { top: 5 }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('shareFile passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    builder.post.mockResolvedValueOnce({
      shareId: 'share-1',
      link: { webUrl: 'https://example.com/share/share-1' },
    });
    const signal = new AbortController().signal;
    await shareFile(client, { path: '/Documents/report.pdf' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('readTextFile passes signal to the metadata request and the bounded content download', async () => {
    const { client, builder } = createMockClient();
    builder.get.mockResolvedValueOnce({
      id: 'text-1',
      name: 'notes.txt',
      size: 42,
      file: { mimeType: 'text/plain' },
    });
    const signal = new AbortController().signal;

    // The content download goes through the byte-capped raw-fetch helper
    // (shared with read_document), not the Graph SDK client — stub the token
    // provider and fetch, and assert the signal reaches both requests.
    vi.doMock('../src/client.js', () => ({ getAccessToken: async () => 'mock-token' }));
    vi.resetModules();
    const fetchSpy = vi.fn(async () => new Response('hello world', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { readTextFile: readTextFileWithMocks } = await import('../src/files.js');
      await readTextFileWithMocks(client, { path: '/Documents/notes.txt' }, signal);
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock('../src/client.js');
      vi.resetModules();
    }

    expect(builder.options).toHaveBeenCalledWith({ signal });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ signal });
  });
});

describe('callGraph + withGraphRetry signal propagation', () => {
  it('callGraph invokes fn with a composed AbortSignal', async () => {
    vi.stubEnv('MS_CONFIG_DIR', '/tmp/microsoft-files-mock-noop');
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
    vi.stubEnv('MS_CONFIG_DIR', '/tmp/microsoft-files-mock-noop');
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
