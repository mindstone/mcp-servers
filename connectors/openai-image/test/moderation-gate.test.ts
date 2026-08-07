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

const extractErrorPayload = (
  result: CallToolResult,
): { ok: boolean; code?: string; error?: string; resolution?: string } => {
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

describe("moderation: 'low' is gated behind OPENAI_IMAGE_ALLOW_LOW_MODERATION (F-2)", () => {
  it("generate_image rejects moderation: 'low' without the env opt-in, before any API call", async () => {
    const workspace = await makeTempDir('mod-gate-deny');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-mod-gate-deny',
    });
    const fetchSpy = mockOpenAIImageResponses([]);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'Acme moderation downgrade',
          quality: 'medium',
          moderation: 'low',
        },
      })) as CallToolResult;

      const payload = extractErrorPayload(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(payload.resolution).toContain('OPENAI_IMAGE_ALLOW_LOW_MODERATION');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await pair.close();
    }
  });

  it("edit_image rejects moderation: 'low' without the env opt-in, before any API call", async () => {
    const workspace = await makeTempDir('mod-gate-deny-edit');
    const sourcePath = path.join(workspace, 'source.png');
    await fsp.writeFile(sourcePath, Buffer.alloc(256, 7));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-mod-gate-deny-edit',
    });
    const fetchSpy = mockOpenAIImageResponses([]);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme moderation downgrade',
          image_paths: [sourcePath],
          quality: 'medium',
          moderation: 'low',
        },
      })) as CallToolResult;

      const payload = extractErrorPayload(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await pair.close();
    }
  });

  it("generate_image forwards moderation: 'low' when the env opt-in is set", async () => {
    const workspace = await makeTempDir('mod-gate-allow');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-mod-gate-allow',
      OPENAI_IMAGE_ALLOW_LOW_MODERATION: '1',
    });
    const capturedBodies: unknown[] = [];
    mockOpenAIImageResponses(capturedBodies);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'Acme opted-in low moderation',
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

  it("edit_image forwards moderation: 'low' in the FormData when the env opt-in is set", async () => {
    const workspace = await makeTempDir('mod-gate-allow-edit');
    const sourcePath = path.join(workspace, 'source.png');
    await fsp.writeFile(sourcePath, Buffer.alloc(256, 7));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-mod-gate-allow-edit',
      OPENAI_IMAGE_ALLOW_LOW_MODERATION: 'true',
    });
    const capturedBodies: unknown[] = [];
    mockOpenAIImageResponses(capturedBodies);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme opted-in low moderation',
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

  it("generate_image defaults to moderation: 'auto' without the opt-in", async () => {
    const workspace = await makeTempDir('mod-gate-auto');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-mod-gate-auto',
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
