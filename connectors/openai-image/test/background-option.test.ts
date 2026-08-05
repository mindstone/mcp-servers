import * as fs from 'node:fs/promises';
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
  const dir = await fs.mkdtemp(path.join('/tmp', `Acme-${label}-`));
  cleanupTargets.push(dir);
  return dir;
};

interface CapturedRequest {
  url: string;
  body: unknown;
}

const mockOpenAIImageResponses = (
  captured: CapturedRequest[],
): ReturnType<typeof vi.spyOn> =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      captured.push({
        url: String(input),
        body: (init as RequestInit | undefined)?.body,
      });
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
      await fs.rm(target, { recursive: true, force: true });
    }
  }
});

describe('background option with transparency model gate', () => {
  it('sends background transparent to a transparency-capable model', async () => {
    const workspace = await makeTempDir('bg-supported');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-bg-supported',
      OPENAI_IMAGE_MODEL: 'gpt-image-1.5',
    });
    const captured: CapturedRequest[] = [];
    mockOpenAIImageResponses(captured);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'Acme logo cutout',
          quality: 'medium',
          background: 'transparent',
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const body = JSON.parse(captured[0]?.body as string) as Record<
        string,
        unknown
      >;
      expect(body.background).toBe('transparent');
    } finally {
      await pair.close();
    }
  });

  it('rejects background transparent on gpt-image-2 before any API call', async () => {
    const workspace = await makeTempDir('bg-gated');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-bg-gated',
    });
    const captured: CapturedRequest[] = [];
    mockOpenAIImageResponses(captured);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'Acme logo cutout',
          background: 'transparent',
        },
      })) as CallToolResult;

      const payload = extractErrorPayload(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(payload.error).toContain('gpt-image-2');
      expect(payload.resolution).toContain('gpt-image-1.5');
      expect(captured).toHaveLength(0);
    } finally {
      await pair.close();
    }
  });

  it('rejects background transparent with jpeg output before any API call', async () => {
    const workspace = await makeTempDir('bg-jpeg');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-bg-jpeg',
      OPENAI_IMAGE_MODEL: 'gpt-image-1.5',
    });
    const captured: CapturedRequest[] = [];
    mockOpenAIImageResponses(captured);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'Acme logo cutout',
          background: 'transparent',
          output_format: 'jpeg',
        },
      })) as CallToolResult;

      const payload = extractErrorPayload(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(captured).toHaveLength(0);
    } finally {
      await pair.close();
    }
  });

  it('sends background opaque on gpt-image-2 (only transparent is gated)', async () => {
    const workspace = await makeTempDir('bg-opaque');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-bg-opaque',
    });
    const captured: CapturedRequest[] = [];
    mockOpenAIImageResponses(captured);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'Acme product shot',
          quality: 'medium',
          background: 'opaque',
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const body = JSON.parse(captured[0]?.body as string) as Record<
        string,
        unknown
      >;
      expect(body.background).toBe('opaque');
    } finally {
      await pair.close();
    }
  });

  it('passes background transparent through for unknown model overrides', async () => {
    const workspace = await makeTempDir('bg-unknown-model');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-bg-unknown',
      OPENAI_IMAGE_MODEL: 'gpt-image-future',
    });
    const captured: CapturedRequest[] = [];
    mockOpenAIImageResponses(captured);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'Acme logo cutout',
          quality: 'medium',
          background: 'transparent',
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const body = JSON.parse(captured[0]?.body as string) as Record<
        string,
        unknown
      >;
      expect(body.background).toBe('transparent');
    } finally {
      await pair.close();
    }
  });

  it('forwards background on edit_image multipart form', async () => {
    const workspace = await makeTempDir('bg-edit');
    const sourcePath = path.join(workspace, 'source.png');
    await fs.writeFile(sourcePath, Buffer.alloc(256, 7));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-bg-edit',
      OPENAI_IMAGE_MODEL: 'gpt-image-1.5',
    });
    const captured: CapturedRequest[] = [];
    mockOpenAIImageResponses(captured);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Remove the Acme backdrop',
          image_paths: [sourcePath],
          quality: 'medium',
          background: 'transparent',
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const form = captured[0]?.body as FormData;
      expect(form.get('background')).toBe('transparent');
    } finally {
      await pair.close();
    }
  });
});
