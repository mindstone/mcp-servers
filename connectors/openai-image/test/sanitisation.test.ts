import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryClientPair,
  extractToolPayload,
  importConnectorModule,
} from './helpers.js';

const SENTINEL_API_KEY = 'sk-live-NEGATIVE-TEST-DO-NOT-USE';
const SENTINEL_PROMPT = 'NEGATIVE-TEST-PROMPT-DO-NOT-LOG';
const SENTINEL_PATH = '/tmp/NEGATIVE-TEST-PATH-DO-NOT-LOG/output.png';
const cleanupTargets: string[] = [];
const ERROR_CODES = [
  'NOT_CONFIGURED',
  'INVALID_API_KEY',
  'RATE_LIMITED',
  'CONTENT_POLICY',
  'WORKSPACE_FENCE_VIOLATION',
  'MODEL_UNAVAILABLE',
  'NETWORK_ERROR',
  'WRITE_FAILED',
] as const;

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

describe('sanitisation', () => {
  it('scrubs sensitive values from logs and structured error payloads', async () => {
    const capturedLogs: string[] = [];
    const capture = (args: unknown[]): void => {
      capturedLogs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };

    vi.spyOn(console, 'log').mockImplementation((...args) => capture(args));
    vi.spyOn(console, 'info').mockImplementation((...args) => capture(args));
    vi.spyOn(console, 'warn').mockImplementation((...args) => capture(args));
    vi.spyOn(console, 'error').mockImplementation((...args) => capture(args));
    vi.spyOn(console, 'debug').mockImplementation((...args) => capture(args));

    const connector = await importConnectorModule({
      OPENAI_API_KEY: SENTINEL_API_KEY,
      MCP_WORKSPACE_PATH: path.dirname(SENTINEL_PATH),
    });
    const loggerModule = await import('../src/logger.js');

    loggerModule.logger.error('[openai-image] prompt redaction probe', {
      prompt: SENTINEL_PROMPT,
    });

    for (const code of ERROR_CODES) {
      const result = await connector.withErrorHandling(async () => {
        throw new connector.OpenAIImageToolError(
          code,
          `${code} error with ${SENTINEL_API_KEY} at ${SENTINEL_PATH}`,
          `Resolve ${code} after checking ${SENTINEL_API_KEY} and ${SENTINEL_PATH}`,
        );
      });

      const payload = extractToolPayload(result);
      const payloadText = JSON.stringify(payload);
      expect(payloadText).not.toContain(SENTINEL_API_KEY);
      expect(payloadText).not.toContain(SENTINEL_PROMPT);
      expect(payloadText).not.toContain(SENTINEL_PATH);
    }

    const combinedLogs = capturedLogs.join('\n');
    expect(combinedLogs).not.toContain(SENTINEL_API_KEY);
    expect(combinedLogs).not.toContain(SENTINEL_PROMPT);
    expect(combinedLogs).not.toContain(SENTINEL_PATH);
    expect(combinedLogs).toContain('REDACTED-API-KEY');
  });

  it('keeps only the supplied path and workspace root in a fence error', async () => {
    const workspace = await fs.mkdtemp(path.join('/tmp', 'Acme-workspace-'));
    const outsideRoot = await fs.mkdtemp(path.join('/tmp', 'Acme-outside-'));
    cleanupTargets.push(workspace, outsideRoot);
    const outsideFile = path.join(outsideRoot, 'private.png');
    await fs.writeFile(outsideFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const suppliedPath = path.join(workspace, 'linked.png');
    await fs.symlink(outsideFile, suppliedPath);
    const canonicalOutsideRoot = await fs.realpath(outsideRoot);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-fence-message',
    });
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme fence message',
          image_paths: [suppliedPath],
        },
      })) as CallToolResult;
      const payload = extractToolPayload(result);
      const payloadText = JSON.stringify(payload);

      expect(payload.code).toBe('WORKSPACE_FENCE_VIOLATION');
      expect(payloadText).toContain(suppliedPath);
      expect(payloadText).toContain(workspace);
      expect(payloadText).not.toContain(canonicalOutsideRoot);
      expect(payloadText).not.toContain('/tmp/Acme-unrelated');
    } finally {
      await pair.close();
    }
  });
});
