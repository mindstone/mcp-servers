import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryClientPair,
  extractToolPayload,
  importConnectorModule,
} from './helpers.js';

const cleanupTargets: string[] = [];
const IMAGE_BASE64 = Buffer.alloc(128, 2).toString('base64');

const makeTempDir = async (label: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join('/tmp', `Acme-${label}-`));
  cleanupTargets.push(dir);
  return dir;
};

const mockOpenAIImageResponse = (): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return new Response(
      JSON.stringify({ data: [{ b64_json: IMAGE_BASE64 }] }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });

const createLinkedOutputFixture = async (): Promise<{
  workspace: string;
  outputRoot: string;
  outputDir: string;
}> => {
  const workspace = await makeTempDir('workspace');
  const outputRoot = await makeTempDir('output-root');
  const linkedChiefOfStaff = path.join(outputRoot, 'Chief-of-Staff');
  await fs.mkdir(linkedChiefOfStaff, { recursive: true });
  await fs.symlink(linkedChiefOfStaff, path.join(workspace, 'Chief-of-Staff'));
  return {
    workspace,
    outputRoot,
    outputDir: path.join(linkedChiefOfStaff, 'generated-images'),
  };
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (cleanupTargets.length > 0) {
    const target = cleanupTargets.pop();
    if (target) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
});

describe('generated-image output containment', () => {
  it('writes through a workspace symlink whose target is in a declared root', async () => {
    const fixture = await createLinkedOutputFixture();
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: fixture.workspace,
      MCP_ALLOWED_SYMLINK_ROOTS: JSON.stringify([fixture.outputRoot]),
      OPENAI_API_KEY: 'sk-test-Acme-declared-output',
    });
    mockOpenAIImageResponse();
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: { prompt: 'Acme declared output', quality: 'medium' },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const savedFiles = await fs.readdir(fixture.outputDir);
      expect(savedFiles).toHaveLength(1);
    } finally {
      await pair.close();
    }
  });

  it('rejects an undeclared output target before creating or writing a file', async () => {
    const fixture = await createLinkedOutputFixture();
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: fixture.workspace,
      MCP_ALLOWED_SYMLINK_ROOTS: JSON.stringify([]),
      OPENAI_API_KEY: 'sk-test-Acme-undeclared-output',
    });
    mockOpenAIImageResponse();
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: { prompt: 'Acme undeclared output', quality: 'medium' },
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      if (result.isError) {
        const payload = extractToolPayload(result);
        expect(payload.code).toBe('WORKSPACE_FENCE_VIOLATION');
      }
      await expect(fs.readdir(fixture.outputDir)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await pair.close();
    }
  });
});
