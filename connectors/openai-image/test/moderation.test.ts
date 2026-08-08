import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryClientPair,
  importConnectorModule,
  makeImageBase64,
} from './helpers.js';

const cleanupTargets: string[] = [];
const IMAGE_BASE64 = makeImageBase64('png');

const makeTempDir = async (label: string): Promise<string> => {
  const dir = await fsp.mkdtemp(path.join('/tmp', `Acme-${label}-`));
  cleanupTargets.push(dir);
  return dir;
};

const mockOpenAIImageResponses = (
  capturedBodies: unknown[],
): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    capturedBodies.push((init as RequestInit | undefined)?.body);
    return new Response(JSON.stringify({ data: [{ b64_json: IMAGE_BASE64 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

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

describe("moderation passes through like any other tool input (no opt-in gate)", () => {
  it("generate_image forwards moderation: 'low' by default", async () => {
    const workspace = await makeTempDir('mod-low-generate');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-mod-low-generate',
    });
    const capturedBodies: unknown[] = [];
    mockOpenAIImageResponses(capturedBodies);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'Acme low moderation',
          quality: 'medium',
          moderation: 'low',
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const body = JSON.parse(capturedBodies[0] as string) as Record<
        string,
        unknown
      >;
      expect(body.moderation).toBe('low');
    } finally {
      await pair.close();
    }
  });

  it("edit_image forwards moderation: 'low' in the FormData by default", async () => {
    const workspace = await makeTempDir('mod-low-edit');
    const sourcePath = path.join(workspace, 'source.png');
    await fsp.writeFile(sourcePath, Buffer.alloc(256, 7));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-mod-low-edit',
    });
    const capturedBodies: unknown[] = [];
    mockOpenAIImageResponses(capturedBodies);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme low moderation',
          image_paths: [sourcePath],
          quality: 'medium',
          moderation: 'low',
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const form = capturedBodies[0] as FormData;
      expect(form.get('moderation')).toBe('low');
    } finally {
      await pair.close();
    }
  });

  it("generate_image defaults to moderation: 'auto'", async () => {
    const workspace = await makeTempDir('mod-auto');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-mod-auto',
    });
    const capturedBodies: unknown[] = [];
    mockOpenAIImageResponses(capturedBodies);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: { prompt: 'Acme default moderation', quality: 'medium' },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const body = JSON.parse(capturedBodies[0] as string) as Record<
        string,
        unknown
      >;
      expect(body.moderation).toBe('auto');
    } finally {
      await pair.close();
    }
  });
});
