import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mswServer } from './helpers/setup.js';
import { createPandaDocHandlers } from './helpers/pandadoc-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { readUploadFile } from '../src/tools/path-safety.js';

const BASE = 'https://api.pandadoc.com/public/v1';

/**
 * Build an MSW handler for the upload endpoint that records every invocation
 * and returns a fixed success body. Returns a `getCallCount` accessor so tests
 * can assert that the upload was (or was not) invoked.
 */
function uploadHandler(expectedKey = 'test-pandadoc-key') {
  let count = 0;
  const handler = http.post(`${BASE}/documents`, ({ request }) => {
    const url = new URL(request.url);
    if (!url.searchParams.has('upload')) {
      // Not the upload variant — fall through to other handlers.
      return undefined;
    }
    if (request.headers.get('Authorization') !== `API-Key ${expectedKey}`) {
      return HttpResponse.json({ type: 'unauthorized' }, { status: 401 });
    }
    count++;
    return HttpResponse.json({
      id: 'doc-1',
      name: 'in.pdf',
      status: 'document.uploaded',
      date_created: '2026-03-01T10:00:00Z',
      date_modified: '2026-03-01T10:00:00Z',
      expiration_date: null,
      version: null,
      uuid: 'doc-1',
      links: [],
      info_message: 'Document uploaded.',
    });
  });
  return { handler, getCallCount: () => count };
}

/**
 * Make the smallest possible PDF so size/type checks pass; bytes are
 * irrelevant because msw intercepts the upload before any real network call.
 */
function writePdf(filePath: string): void {
  fs.writeFileSync(filePath, '%PDF-1.4\n%EOF\n');
}

describe('PandaDoc M3.7 — upload_document sandbox + send_document warning', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  // ── VAL-PANDADOC-001 ────────────────────────────────────────────
  it('VAL-PANDADOC-001 — in-workspace upload succeeds (positive)', async () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ws-')));
    const inFile = path.join(workspace, 'in.pdf');
    writePdf(inFile);

    const upload = uploadHandler();
    mswServer.use(upload.handler, ...createPandaDocHandlers());
    testClient = await createTestClient({
      env: {
        PANDADOC_API_KEY: 'test-pandadoc-key',
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspace,
      },
    });

    const result = await testClient.callTool('upload_document', { file_path: inFile });
    const json = result.json as { ok: boolean; document?: { id: string } };
    expect(json.ok).toBe(true);
    expect(json.document?.id).toBe('doc-1');
    expect(upload.getCallCount()).toBe(1);
  });

  // ── VAL-PANDADOC-002 ────────────────────────────────────────────
  it('VAL-PANDADOC-002 — workspace unset → tmpdir', async () => {
    // Resolve the real os.tmpdir() so any platform-symlinked tmpdir
    // (e.g. /tmp → /private/tmp on macOS) doesn't trip the sandbox.
    const tmpRoot = fs.realpathSync(os.tmpdir());
    const unique = `pd-${process.pid}-${Date.now()}.pdf`;
    const inFile = path.join(tmpRoot, unique);
    writePdf(inFile);

    const upload = uploadHandler();
    mswServer.use(upload.handler, ...createPandaDocHandlers());
    testClient = await createTestClient({
      env: {
        PANDADOC_API_KEY: 'test-pandadoc-key',
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: '',
      },
    });

    try {
      const result = await testClient.callTool('upload_document', { file_path: inFile });
      const json = result.json as { ok: boolean };
      expect(json.ok).toBe(true);
      expect(upload.getCallCount()).toBe(1);
    } finally {
      try { fs.unlinkSync(inFile); } catch { /* noop */ }
    }
  });

  // ── VAL-PANDADOC-101 ────────────────────────────────────────────
  it('VAL-PANDADOC-101 — path outside workspace rejected', async () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ws-')));
    // Real PDF lives elsewhere under tmpdir but NOT under the workspace.
    const tmpRoot = fs.realpathSync(os.tmpdir());
    const outside = path.join(tmpRoot, `pd-outside-${process.pid}-${Date.now()}.pdf`);
    writePdf(outside);

    const upload = uploadHandler();
    mswServer.use(upload.handler, ...createPandaDocHandlers());
    testClient = await createTestClient({
      env: {
        PANDADOC_API_KEY: 'test-pandadoc-key',
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspace,
      },
    });

    try {
      const result = await testClient.callTool('upload_document', { file_path: outside });
      const json = result.json as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toMatch(/workspace|sandbox|outside|allow-list/i);
      expect(upload.getCallCount()).toBe(0);
    } finally {
      try { fs.unlinkSync(outside); } catch { /* noop */ }
    }
  });

  // ── VAL-PANDADOC-102 ────────────────────────────────────────────
  it('VAL-PANDADOC-102 — `..` traversal rejected', async () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ws-')));

    const upload = uploadHandler();
    mswServer.use(upload.handler, ...createPandaDocHandlers());
    testClient = await createTestClient({
      env: {
        PANDADOC_API_KEY: 'test-pandadoc-key',
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspace,
      },
    });

    const traversal = path.join(workspace, '..', '..', 'etc', 'passwd');
    const result = await testClient.callTool('upload_document', { file_path: traversal });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/workspace|sandbox|outside|allow-list/i);
    expect(upload.getCallCount()).toBe(0);
  });

  // ── VAL-PANDADOC-103 ────────────────────────────────────────────
  it('VAL-PANDADOC-103 — symlink escape rejected', async () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ws-')));
    const tmpRoot = fs.realpathSync(os.tmpdir());
    const realTarget = path.join(tmpRoot, `pd-escape-${process.pid}-${Date.now()}.pdf`);
    writePdf(realTarget);
    const linkInside = path.join(workspace, 'escape.pdf');
    fs.symlinkSync(realTarget, linkInside);

    const upload = uploadHandler();
    mswServer.use(upload.handler, ...createPandaDocHandlers());
    testClient = await createTestClient({
      env: {
        PANDADOC_API_KEY: 'test-pandadoc-key',
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspace,
      },
    });

    try {
      const result = await testClient.callTool('upload_document', { file_path: linkInside });
      const json = result.json as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toMatch(/symlink|workspace|sandbox|realpath/i);
      expect(upload.getCallCount()).toBe(0);
    } finally {
      try { fs.unlinkSync(realTarget); } catch { /* noop */ }
    }
  });

  // ── VAL-PANDADOC-201 ────────────────────────────────────────────
  it('VAL-PANDADOC-201 — send_document description warns about silent: true', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const toolsResult = await testClient.client.listTools();
    const send = toolsResult.tools.find((t) => t.name === 'send_document');
    expect(send, 'send_document tool must be registered').toBeDefined();
    const description = send!.description ?? '';
    expect(description).toMatch(/silent.*(skip|suppress|no).*notification/i);
  });

  // ── VAL-PANDADOC-202 ────────────────────────────────────────────
  it('VAL-PANDADOC-202 — `silent` warning text co-located with send_document in source', async () => {
    const documentsTs = fs.readFileSync(
      path.resolve(__dirname, '../src/tools/documents.ts'),
      'utf-8',
    );
    // Slice from the send_document registration to the next registerTool block.
    const sendIdx = documentsTs.indexOf("'send_document'");
    expect(sendIdx).toBeGreaterThan(-1);
    const after = documentsTs.slice(sendIdx);
    const nextRegister = after.indexOf('registerTool', 1);
    const block = nextRegister > 0 ? after.slice(0, nextRegister) : after;
    expect(block).toMatch(/silent/);
  });

  // ── VAL-PANDADOC-203 ────────────────────────────────────────────
  it('VAL-PANDADOC-203 — a post-validation symlink swap is refused before a single byte is read (no upload)', async () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ws-')));
    const inFile = path.join(workspace, 'in.pdf');
    writePdf(inFile);
    const outside = path.join(
      fs.realpathSync(os.tmpdir()),
      `pd-race-outside-${process.pid}-${Date.now()}.pdf`,
    );
    fs.writeFileSync(outside, 'outside secret bytes — must never be uploaded');

    // Fault injection: emulate the local attacker who replaces the approved
    // leaf with an escaping symlink in the validation→open window — the swap
    // happens inside `open`, i.e. AFTER sandbox validation has approved the
    // real file. A plain `open(path, 'r')` would follow the symlink; the
    // fstat+stat compare would then pass because both observe the same
    // outside inode. O_NOFOLLOW (or, where unavailable, the post-open
    // re-resolution) must refuse instead.
    const originalOpen = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (p, flags) => {
      if (p === inFile) {
        fs.rmSync(inFile, { force: true });
        fs.symlinkSync(outside, inFile);
      }
      return originalOpen(p, flags);
    });

    const upload = uploadHandler();
    mswServer.use(upload.handler, ...createPandaDocHandlers());
    testClient = await createTestClient({
      env: {
        PANDADOC_API_KEY: 'test-pandadoc-key',
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspace,
      },
    });

    try {
      const result = await testClient.callTool('upload_document', { file_path: inFile });
      const json = result.json as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toMatch(/changed|workspace|sandbox/i);
      // The vulnerable implementation (plain open + fstat/stat compare)
      // reads the outside file through the descriptor and uploads it — this
      // count is the proof that zero outside bytes were read or sent.
      expect(upload.getCallCount()).toBe(0);
    } finally {
      try { fs.unlinkSync(outside); } catch { /* noop */ }
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── VAL-PANDADOC-204 ────────────────────────────────────────────
  it('VAL-PANDADOC-204 — a directory with a .pdf name is refused via fstat (no upload)', async () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ws-')));
    const dirAsFile = path.join(workspace, 'looks-like.pdf');
    fs.mkdirSync(dirAsFile);

    const upload = uploadHandler();
    mswServer.use(upload.handler, ...createPandaDocHandlers());
    testClient = await createTestClient({
      env: {
        PANDADOC_API_KEY: 'test-pandadoc-key',
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspace,
      },
    });

    const result = await testClient.callTool('upload_document', { file_path: dirAsFile });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/regular file/i);
    expect(upload.getCallCount()).toBe(0);
  });

  // ── VAL-PANDADOC-205 ────────────────────────────────────────────
  it('VAL-PANDADOC-205 — download canonicalises a symlinked TMPDIR and never overwrites', async () => {
    // Point TMPDIR at a SYMLINK to a real directory: the download must land
    // under the canonical target, not the lexical (attacker-chosen) alias.
    const realDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-dl-real-')));
    const linkPath = path.join(os.tmpdir(), `pd-dl-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(realDir, linkPath);
    vi.stubEnv('TMPDIR', linkPath);

    // Plant a file at the OLD deterministic path: a download must not touch it.
    const legacyPath = path.join(realDir, 'pandadoc_doc-1.pdf');
    fs.writeFileSync(legacyPath, 'sentinel');

    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    try {
      const first = await testClient.callTool('download_document', { document_id: 'doc-1' });
      const firstJson = first.json as { ok: boolean; file_path: string };
      expect(firstJson.ok).toBe(true);
      // Canonical containment: under the real directory, never the symlink alias.
      expect(firstJson.file_path.startsWith(realDir + path.sep)).toBe(true);
      expect(firstJson.file_path.startsWith(linkPath)).toBe(false);

      // A second download of the same document must NOT overwrite the first.
      const second = await testClient.callTool('download_document', { document_id: 'doc-1' });
      const secondJson = second.json as { ok: boolean; file_path: string };
      expect(secondJson.ok).toBe(true);
      expect(secondJson.file_path).not.toBe(firstJson.file_path);
      expect(fs.existsSync(firstJson.file_path)).toBe(true);
      expect(fs.readFileSync(firstJson.file_path, 'utf-8')).toBe('PDF_CONTENT_MOCK');
      expect(fs.readFileSync(secondJson.file_path, 'utf-8')).toBe('PDF_CONTENT_MOCK');

      // The planted legacy-name file is untouched.
      expect(fs.readFileSync(legacyPath, 'utf-8')).toBe('sentinel');

      fs.unlinkSync(firstJson.file_path);
      fs.unlinkSync(secondJson.file_path);
    } finally {
      try { fs.unlinkSync(linkPath); } catch { /* noop */ }
      fs.rmSync(realDir, { recursive: true, force: true });
    }
  });
});

describe('readUploadFile — race-resistant validate+read (fault injection)', () => {
  const ONE_KIB = 1024;
  let workspaceDir: string;
  let workspaceFile: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-race-')));
    workspaceFile = path.join(workspaceDir, 'in.pdf');
    writePdf(workspaceFile);
    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('refuses a leaf swapped for an escaping symlink before open — zero bytes read', async () => {
    const outside = path.join(
      fs.realpathSync(os.tmpdir()),
      `pd-race-outside-${process.pid}-${Date.now()}.pdf`,
    );
    fs.writeFileSync(outside, 'outside secret');
    let readCalls = 0;
    const swapToSymlink: typeof fs.promises.open = (async (p, flags) => {
      // Attacker replaces the validated file with an escaping symlink in the
      // validation→open window. O_NOFOLLOW turns the open itself into ELOOP;
      // where O_NOFOLLOW is unavailable, the post-open re-resolution still
      // refuses before the read loop starts.
      fs.rmSync(p as string, { force: true });
      fs.symlinkSync(outside, p as string);
      const handle = await fs.promises.open(p, flags);
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation((async (...args: unknown[]) => {
        readCalls += 1;
        return (originalRead as (...a: unknown[]) => unknown)(...args);
      }) as typeof handle.read);
      return handle;
    }) as typeof fs.promises.open;

    try {
      const result = await readUploadFile(workspaceFile, ONE_KIB, swapToSymlink);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('changed');
      expect(readCalls).toBe(0);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('refuses when the file is replaced (new inode) after open', async () => {
    const replaceAfterOpen: typeof fs.promises.open = (async (p, flags) => {
      const handle = await fs.promises.open(p, flags);
      fs.rmSync(p as string, { force: true });
      fs.writeFileSync(p as string, 'REPLACED CONTENT');
      return handle;
    }) as typeof fs.promises.open;

    const result = await readUploadFile(workspaceFile, ONE_KIB, replaceAfterOpen);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('changed');
  });

  it('refuses when an ancestor directory is swapped for an escaping symlink before open', async () => {
    const subdir = path.join(workspaceDir, 'sub');
    fs.mkdirSync(subdir);
    const innerFile = path.join(subdir, 'inner.pdf');
    writePdf(innerFile);

    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-race-ancestor-')));
    writePdf(path.join(outsideDir, 'inner.pdf'));

    const swapAncestor: typeof fs.promises.open = (async (p, flags) => {
      fs.rmSync(subdir, { recursive: true, force: true });
      fs.symlinkSync(outsideDir, subdir);
      return fs.promises.open(p, flags);
    }) as typeof fs.promises.open;

    try {
      const result = await readUploadFile(innerFile, ONE_KIB, swapAncestor);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('changed');
    } finally {
      fs.rmSync(subdir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('reads the originally-opened inode even if the path content grows after open', async () => {
    const appendAfterOpen: typeof fs.promises.open = (async (p, flags) => {
      const handle = await fs.promises.open(p, flags);
      fs.appendFileSync(workspaceFile, ' [appended]');
      return handle;
    }) as typeof fs.promises.open;

    const result = await readUploadFile(workspaceFile, ONE_KIB, appendAfterOpen);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.buffer.toString('utf8')).toContain('%PDF-1.4');
    }
  });
});

describe('download_document filename derivation is bounded', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('an over-long document_id cannot surface a raw ENAMETOOLONG', async () => {
    mswServer.use(
      http.get(`${BASE}/documents/:id/download`, () =>
        new HttpResponse(Buffer.from('PDF_CONTENT_MOCK'), {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        }),
      ),
    );
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const longId = 'x'.repeat(500);
    const result = await testClient.callTool('download_document', { document_id: longId });
    const json = result.json as { ok: boolean; file_path: string };
    expect(json.ok).toBe(true);
    // 'pandadoc_' (9) + id slice (<=100) + '_' + 12 hex + '.pdf' (4) = 126 max.
    expect(path.basename(json.file_path).length).toBeLessThanOrEqual(126);
    fs.unlinkSync(json.file_path);
  });
});
