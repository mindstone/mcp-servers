import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mswServer } from '../helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY } from '../helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('Knowledge base tools — Retell AI', () => {
  let testClient: McpTestClient;
  const createdDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of createdDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    createdDirs.length = 0;
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  function makeWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retell-kb-test-'));
    createdDirs.push(dir);
    return dir;
  }

  it('list_knowledge_bases returns knowledge bases with ok:true', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({ name: 'list_knowledge_bases', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.knowledge_bases).toBeInstanceOf(Array);
    expect(parsed.count).toBe(1);
    // knowledge_base_name is external text → wrapped per AGENTS.md invariant #6 (FOX-3490).
    expect(parsed.knowledge_bases[0].knowledge_base_name).toBe(
      '<untrusted-content source="retell:list_knowledge_bases:knowledge_base_name">Support FAQ</untrusted-content>',
    );
  });

  it('get_knowledge_base wraps source titles/filenames but leaves URLs raw', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'get_knowledge_base',
      arguments: { knowledge_base_id: 'kb_test_123' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.knowledge_base_id).toBe('kb_test_123');
    const [textSrc, urlSrc, docSrc] = parsed.knowledge_base_sources;
    expect(textSrc.title).toBe(
      '<untrusted-content source="retell:get_knowledge_base:knowledge_base_sources.title">Refund policy</untrusted-content>',
    );
    expect(docSrc.filename).toBe(
      '<untrusted-content source="retell:get_knowledge_base:knowledge_base_sources.filename">policy.pdf</untrusted-content>',
    );
    // URLs are surfaced for the user, not prose — deliberately not enveloped.
    expect(urlSrc.url).toBe('https://example.com/faq');
  });

  it('get_knowledge_base returns structured error for 404', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'get_knowledge_base',
      arguments: { knowledge_base_id: 'nonexistent' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('HTTP_404');
  });

  it('create_knowledge_base sends texts and urls', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_knowledge_base',
      arguments: {
        knowledge_base_name: 'New KB',
        knowledge_base_texts: [{ title: 'Hours', text: 'We are open 9-5 on weekdays.' }],
        knowledge_base_urls: ['https://example.com/faq'],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.knowledge_base_id).toBe('kb_new_001');
    expect(parsed.status).toBe('in_progress');
    expect(parsed.knowledge_base_name).toBe(
      '<untrusted-content source="retell:create_knowledge_base:knowledge_base_name">New KB</untrusted-content>',
    );
  });

  it('create_knowledge_base uploads a workspace-sandboxed file', async () => {
    mswServer.use(...createRetellHandlers());
    const workspace = makeWorkspace();
    const filePath = path.join(workspace, 'faq.txt');
    fs.writeFileSync(filePath, 'Frequently asked questions about Acme Corp products.');
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '', MCP_WORKSPACE_PATH: workspace },
    });

    const result = await testClient.client.callTool({
      name: 'create_knowledge_base',
      arguments: {
        knowledge_base_name: 'File KB',
        file_paths: [filePath],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.uploaded_files).toEqual(['faq.txt']);
  });

  it('create_knowledge_base rejects a file outside the workspace sandbox', async () => {
    mswServer.use(...createRetellHandlers());
    const workspace = makeWorkspace();
    const outside = path.join(os.tmpdir(), `retell-kb-outside-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'outside the sandbox');
    try {
      testClient = await createTestClient({
        env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '', MCP_WORKSPACE_PATH: workspace },
      });

      const result = await testClient.client.callTool({
        name: 'create_knowledge_base',
        arguments: {
          knowledge_base_name: 'Escape KB',
          file_paths: [outside],
        },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text);

      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('FILE_OUTSIDE_WORKSPACE');
      expect(parsed.error).toMatch(/workspace sandbox/);
    } finally {
      try { fs.unlinkSync(outside); } catch { /* ignore */ }
    }
  });

  it('add_knowledge_base_sources adds texts to an existing knowledge base', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'add_knowledge_base_sources',
      arguments: {
        knowledge_base_id: 'kb_test_123',
        knowledge_base_texts: [{ title: 'Shipping', text: 'Orders ship within 2 business days.' }],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.knowledge_base_id).toBe('kb_test_123');
    expect(parsed.status).toBe('refreshing_in_progress');
  });

  it('add_knowledge_base_sources rejects a call with no sources', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'add_knowledge_base_sources',
      arguments: { knowledge_base_id: 'kb_test_123' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('NO_SOURCES');
  });
});
