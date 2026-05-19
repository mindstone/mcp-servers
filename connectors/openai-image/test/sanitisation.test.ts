import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractToolPayload, importConnectorModule } from './helpers.js';

const SENTINEL_API_KEY = 'sk-live-NEGATIVE-TEST-DO-NOT-USE';
const SENTINEL_PROMPT = 'NEGATIVE-TEST-PROMPT-DO-NOT-LOG';
const SENTINEL_PATH = '/tmp/NEGATIVE-TEST-PATH-DO-NOT-LOG/output.png';
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
});
