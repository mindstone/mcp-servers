import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryClientPair,
  importConnectorModule,
} from './helpers.js';

const cleanupTargets: string[] = [];
const IMAGE_BASE64 = Buffer.alloc(128, 1).toString('base64');

const makeTempDir = async (label: string): Promise<string> => {
  const dir = await fsp.mkdtemp(path.join('/tmp', `Acme-${label}-`));
  cleanupTargets.push(dir);
  return dir;
};

const mockOpenAIImageResponses = (): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return new Response(
      JSON.stringify({ data: [{ b64_json: IMAGE_BASE64 }] }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });

const extractErrorPayload = (
  result: CallToolResult,
): { ok: boolean; code?: string; error?: string } => {
  expect(result.isError).toBe(true);
  const text = result.content.find(
    (block): block is { type: 'text'; text: string } => block.type === 'text',
  );
  if (!text) {
    throw new Error('Expected a text error payload.');
  }
  return JSON.parse(text.text) as { ok: boolean; code?: string };
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (cleanupTargets.length > 0) {
    const target = cleanupTargets.pop();
    if (target) {
      await fsp.rm(target, { recursive: true, force: true });
    }
  }
});

describe('edit-image file loading is open-then-validate (MED-1)', () => {
  it('reads a legitimate workspace image through the descriptor path', async () => {
    const workspace = await makeTempDir('toctou-happy');
    const sourcePath = path.join(workspace, 'source.png');
    await fsp.writeFile(sourcePath, Buffer.alloc(256, 7));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-toctou-happy',
    });
    const fetchSpy = mockOpenAIImageResponses();
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme recolor',
          image_paths: [sourcePath],
          quality: 'medium',
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await pair.close();
    }
  });

  it('reads through an in-workspace symlink (same inode as the fence-validated target)', async () => {
    const workspace = await makeTempDir('toctou-symlink');
    const targetPath = path.join(workspace, 'real.png');
    const linkPath = path.join(workspace, 'linked.png');
    await fsp.writeFile(targetPath, Buffer.alloc(256, 7));
    await fsp.symlink(targetPath, linkPath);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-toctou-symlink',
    });
    const fetchSpy = mockOpenAIImageResponses();
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme recolor',
          image_paths: [linkPath],
          quality: 'medium',
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await pair.close();
    }
  });

  it('rejects when the file opened is not the inode the fence validated', async () => {
    const workspace = await makeTempDir('toctou-swap');
    const sourcePath = path.join(workspace, 'source.png');
    const impostorPath = path.join(workspace, 'impostor.png');
    await fsp.writeFile(sourcePath, Buffer.alloc(256, 7));
    await fsp.writeFile(impostorPath, Buffer.alloc(256, 9));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-toctou-swap',
    });
    const fetchSpy = mockOpenAIImageResponses();

    // Simulate a local race: the path is swapped between the fence's realpath
    // validation and the open, so the descriptor points at a different inode.
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(((
      _target: fs.PathLike,
      flags?: fs.OpenMode,
      mode?: fs.Mode,
    ) => realOpen(impostorPath, flags, mode)) as typeof fs.promises.open);

    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme recolor',
          image_paths: [sourcePath],
          quality: 'medium',
        },
      })) as CallToolResult;

      const payload = extractErrorPayload(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('WORKSPACE_FENCE_VIOLATION');
      expect(payload.error).toContain('changed while it was being verified');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await pair.close();
    }
  });
});
