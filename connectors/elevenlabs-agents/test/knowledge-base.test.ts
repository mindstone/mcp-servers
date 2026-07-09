import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createDeleteKnowledgeBaseCapturingHandler,
  createElevenLabsAgentsHandlers,
  createKnowledgeBaseFileCapturingHandler,
  createKnowledgeBaseTextCapturingHandler,
  createKnowledgeBaseUrlCapturingHandler,
  MOCK_API_KEY,
} from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { OVERSIZED_KB_PADDING } from './fixtures/elevenlabs-agents-data.js';

describe('knowledge-base tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists documents and truncates large document content on get', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const listed = await testClient.callTool('list_knowledge_base_docs', { page_size: 1 });
    expect(listed.isError).toBeFalsy();
    expect(listed.json.count).toBe(1);
    expect(listed.json.next_cursor).toBe('cursor_docs_2');
    expect(listed.json.documents[0].documentation_id).toBe('doc_test_123');
    expect(listed.json.documents[0].id).toBeUndefined();
    expect(listed.json.documents[0].type).toBe('text');

    const single = await testClient.callTool('get_knowledge_base_doc', {
      documentation_id: listed.json.documents[0].documentation_id,
    });
    expect(single.isError).toBeFalsy();
    expect(single.json.document.documentation_id).toBe('doc_test_123');
    expect(single.json.document.content_truncated).toBe(true);
    expect(single.json.document.content_original_bytes).toBeGreaterThan(50_000);
    expect(single.json.document.content_returned_bytes).toBeLessThanOrEqual(50_000);
    expect(Buffer.byteLength(OVERSIZED_KB_PADDING, 'utf8')).toBeGreaterThan(50_000);
  });

  it('envelopes extracted_inner_html on URL document metadata without inline content', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const single = await testClient.callTool('get_knowledge_base_doc', {
      documentation_id: 'doc_url_test_123',
    });
    expect(single.isError).toBeFalsy();
    expect(single.json.document.documentation_id).toBe('doc_url_test_123');
    expect(single.json.document.type).toBe('url');
    expect(typeof single.json.document.extracted_inner_html).toBe('string');
    expect(single.json.document.extracted_inner_html).toContain('<untrusted-content');
    expect(typeof single.json.document.content).toBe('string');
    expect(single.json.document.content).toContain('<untrusted-content');
  });

  it('adds a knowledge-base document in text mode', async () => {
    const { handler, captured } = createKnowledgeBaseTextCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('add_knowledge_base_document', {
      mode: 'text',
      text: 'Refunds are processed within 3 business days.',
      name: 'Refund policy',
      parent_folder_id: 'folder_support',
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      text: 'Refunds are processed within 3 business days.',
      name: 'Refund policy',
      parent_folder_id: 'folder_support',
    });
    expect(result.json.document.documentation_id).toBe('doc_created_text_123');
  });

  it('adds a knowledge-base document in file mode via the sandboxed file-input helper', async () => {
    const { handler, captured } = createKnowledgeBaseFileCapturingHandler();
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elevenlabs-agents-kb-'));
    const filePath = path.join(workspaceDir, 'kb-upload.txt');
    fs.writeFileSync(filePath, 'Stage 7 KB upload fixture', 'utf8');

    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    try {
      const result = await testClient.callTool('add_knowledge_base_document', {
        mode: 'file',
        file_path: filePath,
        name: 'Release checklist',
        parent_folder_id: 'folder_ops',
      });

      expect(result.isError).toBeFalsy();
      expect(captured).toEqual({
        file_name: 'kb-upload.txt',
        file_text: 'Stage 7 KB upload fixture',
        name: 'Release checklist',
        parent_folder_id: 'folder_ops',
      });
      expect(result.json.document.documentation_id).toBe('doc_created_file_123');
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it('adds a knowledge-base document in url mode', async () => {
    const { handler, captured } = createKnowledgeBaseUrlCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('add_knowledge_base_document', {
      mode: 'url',
      url: 'https://example.com',
      name: 'Public docs',
      enable_auto_sync: true,
      auto_remove: true,
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      url: 'https://example.com',
      name: 'Public docs',
      enable_auto_sync: true,
      auto_remove: true,
    });
    expect(result.json.document.documentation_id).toBe('doc_created_url_123');
  });

  it('deletes a knowledge-base document with the optional force flag', async () => {
    const { handler, captured } = createDeleteKnowledgeBaseCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('delete_knowledge_base_document', {
      documentation_id: 'doc_test_123',
      force: true,
    });

    expect(result.isError).toBeFalsy();
    expect(captured.force).toBe('true');
    expect(result.json).toMatchObject({
      ok: true,
      documentation_id: 'doc_test_123',
      force: true,
    });
  });
});
