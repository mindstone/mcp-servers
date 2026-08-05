import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryClientPair,
  importConnectorModule,
  makeImageBase64,
} from './helpers.js';

const cleanupTargets: string[] = [];

const makeTempDir = async (label: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join('/tmp', `Acme-${label}-`));
  cleanupTargets.push(dir);
  return dir;
};

interface CapturedRequest {
  url: string;
  body: unknown;
}

// The connector verifies that upstream bytes match the requested format, so
// the mock must answer with correctly-signed payloads per output_format.
const requestedOutputFormat = (body: unknown): 'png' | 'jpeg' | 'webp' => {
  let format: unknown;
  if (typeof body === 'string') {
    format = (JSON.parse(body) as { output_format?: unknown }).output_format;
  } else if (body instanceof FormData) {
    format = body.get('output_format');
  }
  return format === 'jpeg' || format === 'webp' ? format : 'png';
};

const mockOpenAIImageResponses = (
  captured: CapturedRequest[],
): ReturnType<typeof vi.spyOn> =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const body = (init as RequestInit | undefined)?.body;
      captured.push({
        url: String(input),
        body,
      });
      return new Response(
        JSON.stringify({
          data: [{ b64_json: makeImageBase64(requestedOutputFormat(body)) }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

const extractSavedPath = (result: CallToolResult): string => {
  const text = result.content.find(
    (block): block is { type: 'text'; text: string } => block.type === 'text',
  );
  if (!text) {
    throw new Error('Expected a text result containing the saved image path.');
  }

  const savedPath = text.text
    .split('\n')
    .find((line) => line.startsWith('  '))
    ?.trim();
  if (!savedPath) {
    throw new Error('Expected the generated image result to include a saved path.');
  }
  return savedPath;
};

const extractInlineMimeType = (result: CallToolResult): string => {
  const image = result.content.find(
    (block): block is { type: 'image'; data: string; mimeType: string } =>
      block.type === 'image',
  );
  if (!image) {
    throw new Error('Expected an inline image content block.');
  }
  return image.mimeType;
};

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

describe('output_format and output_compression options', () => {
  it('keeps png defaults: no format fields sent, .png filename, png inline mime', async () => {
    const workspace = await makeTempDir('fmt-default');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-format-default',
    });
    const captured: CapturedRequest[] = [];
    mockOpenAIImageResponses(captured);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: { prompt: 'Acme default format', quality: 'medium' },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const body = JSON.parse(captured[0]?.body as string) as Record<
        string,
        unknown
      >;
      expect(body).not.toHaveProperty('output_format');
      expect(body).not.toHaveProperty('output_compression');
      expect(extractSavedPath(result)).toMatch(/\.png$/u);
      expect(extractInlineMimeType(result)).toBe('image/png');
    } finally {
      await pair.close();
    }
  });

  it('sends webp format and compression, saves .webp, returns webp inline mime', async () => {
    const workspace = await makeTempDir('fmt-webp');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-format-webp',
    });
    const captured: CapturedRequest[] = [];
    mockOpenAIImageResponses(captured);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'Acme webp asset',
          quality: 'medium',
          output_format: 'webp',
          output_compression: 60,
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const body = JSON.parse(captured[0]?.body as string) as Record<
        string,
        unknown
      >;
      expect(body.output_format).toBe('webp');
      expect(body.output_compression).toBe(60);
      expect(extractSavedPath(result)).toMatch(/\.webp$/u);
      expect(extractInlineMimeType(result)).toBe('image/webp');
    } finally {
      await pair.close();
    }
  });

  it('saves jpeg output with a .jpg extension and jpeg inline mime', async () => {
    const workspace = await makeTempDir('fmt-jpeg');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-format-jpeg',
    });
    const captured: CapturedRequest[] = [];
    mockOpenAIImageResponses(captured);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'Acme jpeg asset',
          quality: 'medium',
          output_format: 'jpeg',
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      expect(extractSavedPath(result)).toMatch(/\.jpg$/u);
      expect(extractInlineMimeType(result)).toBe('image/jpeg');
    } finally {
      await pair.close();
    }
  });

  it('rejects output_compression with png output before any API call', async () => {
    const workspace = await makeTempDir('fmt-png-compression');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-format-png-compression',
    });
    const captured: CapturedRequest[] = [];
    mockOpenAIImageResponses(captured);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'Acme invalid combination',
          output_format: 'png',
          output_compression: 50,
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

  it('forwards output_format and output_compression on edit_image multipart form', async () => {
    const workspace = await makeTempDir('fmt-edit');
    const sourcePath = path.join(workspace, 'source.png');
    await fs.writeFile(sourcePath, Buffer.alloc(256, 7));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-format-edit',
    });
    const captured: CapturedRequest[] = [];
    mockOpenAIImageResponses(captured);
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme recolor',
          image_paths: [sourcePath],
          quality: 'medium',
          output_format: 'webp',
          output_compression: 80,
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const form = captured[0]?.body as FormData;
      expect(form.get('output_format')).toBe('webp');
      expect(form.get('output_compression')).toBe('80');
      expect(extractSavedPath(result)).toMatch(/\.webp$/u);
    } finally {
      await pair.close();
    }
  });
});
