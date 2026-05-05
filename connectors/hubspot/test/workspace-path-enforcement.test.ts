import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('workspace path enforcement', () => {
  it('rejects upload_hubspot_file when file path is outside MCP_WORKSPACE_PATH', async () => {
    const workspaceDir = createTempDir('hubspot-workspace-');
    const outsideDir = createTempDir('hubspot-outside-');
    const outsideFile = join(outsideDir, 'outside.txt');
    writeFileSync(outsideFile, 'outside');

    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
    const { handleUploadFile } = await import('../src/tools/file-handlers.js');

    await expect(handleUploadFile({ filePath: outsideFile })).rejects.toThrow(/PATH_OUTSIDE_WORKSPACE/);
  });

  it('allows upload_hubspot_file when file path is inside MCP_WORKSPACE_PATH', async () => {
    const workspaceDir = createTempDir('hubspot-workspace-');
    const nestedDir = join(workspaceDir, 'nested');
    mkdirSync(nestedDir, { recursive: true });
    const insideFile = join(nestedDir, 'inside.txt');
    writeFileSync(insideFile, 'inside');

    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
    vi.doMock('../src/api/hubspot-client.js', () => ({
      getHubSpotClientAsync: vi.fn(async () => ({
        uploadFile: vi.fn(async () => ({
          id: 'file-1',
          name: 'inside.txt',
          path: '/uploads/inside.txt',
          url: 'https://files.example.com/inside.txt',
          size: 6,
          access: 'PRIVATE'
        }))
      })),
      HubSpotApiError: class HubSpotApiError extends Error {
        statusCode: number;
        details?: unknown;
        constructor(message: string, statusCode: number, details?: unknown) {
          super(message);
          this.statusCode = statusCode;
          this.details = details;
        }
      }
    }));

    const { handleUploadFile } = await import('../src/tools/file-handlers.js');
    const result = await handleUploadFile({ filePath: insideFile });

    expect(result.id).toBe('file-1');
  });

  it('rejects attach_file_to_record when file path is outside MCP_WORKSPACE_PATH', async () => {
    const workspaceDir = createTempDir('hubspot-workspace-');
    const outsideDir = createTempDir('hubspot-outside-');
    const outsideFile = join(outsideDir, 'outside.txt');
    writeFileSync(outsideFile, 'outside');

    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
    const { handleAttachFileToRecord } = await import('../src/tools/file-handlers.js');

    await expect(handleAttachFileToRecord({
      filePath: outsideFile,
      associations: { contactIds: ['101'] }
    })).rejects.toThrow(/PATH_OUTSIDE_WORKSPACE/);
  });

  it('rejects import_hubspot_file_from_url when MCP_WORKSPACE_PATH is unset', async () => {
    const { handleImportFileFromUrl } = await import('../src/tools/file-handlers.js');
    await expect(handleImportFileFromUrl({ url: 'https://example.com/file.pdf' })).rejects.toThrow(
      /WORKSPACE_PATH_REQUIRED/
    );
  });
});
