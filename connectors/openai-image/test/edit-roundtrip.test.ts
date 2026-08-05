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
const IMAGE_BASE64 = makeImageBase64('png');

const makeTempDir = async (label: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join('/tmp', `Acme-${label}-`));
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

describe('generate-to-edit round trip through a linked output folder', () => {
  it('edits an image generated through an in-workspace symlink into a declared root', async () => {
    const workspace = await makeTempDir('workspace');
    const declaredRoot = await makeTempDir('declared-root');
    const linkedChiefOfStaff = path.join(declaredRoot, 'Chief-of-Staff');
    await fs.mkdir(linkedChiefOfStaff, { recursive: true });
    await fs.symlink(
      linkedChiefOfStaff,
      path.join(workspace, 'Chief-of-Staff'),
    );

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      MCP_ALLOWED_SYMLINK_ROOTS: JSON.stringify([declaredRoot]),
      OPENAI_API_KEY: 'sk-test-Acme-roundtrip',
    });
    const fetchSpy = mockOpenAIImageResponses();
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const generateResult = (await pair.client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'Acme round-trip source',
          quality: 'medium',
        },
      })) as CallToolResult;
      expect(generateResult.isError).not.toBe(true);
      const generatedPath = extractSavedPath(generateResult);

      const editResult = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Add an Acme blue border',
          image_paths: [generatedPath],
          quality: 'medium',
        },
      })) as CallToolResult;

      expect(editResult.isError).not.toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(await fs.stat(generatedPath)).toBeDefined();
    } finally {
      await pair.close();
    }
  });
});
