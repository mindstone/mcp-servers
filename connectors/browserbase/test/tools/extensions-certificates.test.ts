import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import {
  createBrowserbaseHandlers,
  MOCK_API_KEY,
  EXTENSION_ID,
  CERTIFICATE_ID,
} from '../helpers/browserbase-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('Extension + certificate tools — Browserbase', () => {
  let testClient: McpTestClient;
  let workspace: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    workspace = '';
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  const makeClient = async () => {
    mswServer.use(...createBrowserbaseHandlers());
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-uploads-'));
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '', MCP_WORKSPACE_PATH: workspace },
    });
    return testClient;
  };

  it('upload_extension posts the zip as multipart and wraps the returned fileName', async () => {
    const client = await makeClient();
    const zipPath = path.join(workspace, 'acme-helper.zip');
    fs.writeFileSync(zipPath, 'mock-zip-bytes');

    const result = await client.callTool('upload_extension', { file_path: zipPath });
    const parsed = result.json as { ok: boolean; id: string; fileName: string; message: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe(EXTENSION_ID);
    expect(parsed.fileName).toBe(
      '<untrusted-content source="browserbase:upload_extension:extension.fileName">acme-helper.zip</untrusted-content>',
    );
    expect(parsed.message).toContain('cannot be listed');
  });

  it('upload_extension rejects files outside the workspace sandbox', async () => {
    const client = await makeClient();
    const result = await client.callTool('upload_extension', { file_path: '/etc/hostname' });
    expect(result.isError).toBe(true);
    expect((result.json as { code: string }).code).toBe('FILE_OUTSIDE_WORKSPACE');
  });

  it('get_extension / delete_extension happy paths; get 404 maps to NOT_FOUND', async () => {
    const client = await makeClient();

    const got = await client.callTool('get_extension', { extension_id: EXTENSION_ID });
    expect((got.json as { ok: boolean; id: string }).id).toBe(EXTENSION_ID);

    const deleted = await client.callTool('delete_extension', { extension_id: EXTENSION_ID });
    expect((deleted.json as { ok: boolean }).ok).toBe(true);

    const missing = await client.callTool('get_extension', { extension_id: 'nonexistent' });
    expect(missing.isError).toBe(true);
    expect((missing.json as { code: string }).code).toBe('NOT_FOUND');
  });

  it('upload_certificate posts the file and returns its id', async () => {
    const client = await makeClient();
    const certPath = path.join(workspace, 'acme-ca.pem');
    fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nmock\n-----END CERTIFICATE-----\n');

    const result = await client.callTool('upload_certificate', { file_path: certPath });
    const parsed = result.json as { ok: boolean; id: string; message: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe(CERTIFICATE_ID);
    expect(parsed.message).toContain('proxy_settings.ca_certificates');
  });

  it('list_certificates / get_certificate / delete_certificate happy paths', async () => {
    const client = await makeClient();

    const list = await client.callTool('list_certificates', {});
    const listJson = list.json as { ok: boolean; certificates: Array<{ id: string }>; count: number };
    expect(listJson.ok).toBe(true);
    expect(listJson.count).toBe(1);
    expect(listJson.certificates[0].id).toBe(CERTIFICATE_ID);

    const got = await client.callTool('get_certificate', { certificate_id: CERTIFICATE_ID });
    expect((got.json as { ok: boolean; id: string }).id).toBe(CERTIFICATE_ID);

    const deleted = await client.callTool('delete_certificate', { certificate_id: CERTIFICATE_ID });
    expect((deleted.json as { ok: boolean }).ok).toBe(true);
  });

  it('delete_certificate 404 maps to NOT_FOUND', async () => {
    const client = await makeClient();
    const result = await client.callTool('delete_certificate', { certificate_id: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect((result.json as { code: string }).code).toBe('NOT_FOUND');
  });
});
