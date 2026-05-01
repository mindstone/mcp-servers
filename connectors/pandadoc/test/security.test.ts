import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mswServer } from './helpers/setup.js';
import { createPandaDocHandlers } from './helpers/pandadoc-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

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
  it('VAL-PANDADOC-203 — realpathSync wired into upload path (static)', async () => {
    const documentsTs = fs.readFileSync(
      path.resolve(__dirname, '../src/tools/documents.ts'),
      'utf-8',
    );
    expect(documentsTs).toMatch(/realpathSync/);
  });
});
