import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubSpotApiError, HubSpotClient } from '../src/api/hubspot-client.js';
import logger from '../src/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '../src');

const RAW_PII_MARKERS = [
  'jane.customer@example.com',
  'pat-na1-sensitive-token-fragment',
  '1234567890',
  'Customer note: please call my private mobile',
  'raw-hubspot-error-body',
];

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectCallWindow(lines: string[], startIndex: number): string {
  const window: string[] = [];
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 12); index += 1) {
    window.push(lines[index]);
    if (lines[index].includes(');')) break;
  }
  return window.join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('H2 logger redaction', () => {
  it('logs only the HubSpot API error projection from client failures', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      message: 'raw-hubspot-error-body jane.customer@example.com',
      category: 'VALIDATION_ERROR',
      errorCode: 'VALIDATION_ERROR',
      portalId: 1234567890,
      trace: 'pat-na1-sensitive-token-fragment',
      note: 'Customer note: please call my private mobile',
    }), {
      status: 400,
      statusText: 'Bad Request',
      headers: {
        'content-type': 'application/json',
        'x-hubspot-correlation-id': 'safe-correlation-id',
      },
    })));

    const client = new HubSpotClient('access-token');
    await expect(client.getObject('contacts', '123')).rejects.toMatchObject({
      name: 'HubSpotApiError',
      statusCode: 400,
      requestId: 'safe-correlation-id',
    });

    expect(errorSpy).toHaveBeenCalledWith(
      {
        operation: 'GET /crm/v3/objects/contacts/123',
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        category: 'VALIDATION_ERROR',
        requestId: 'safe-correlation-id',
      },
      'hubspot_api_error',
    );
    const serializedCalls = JSON.stringify(errorSpy.mock.calls);
    for (const marker of RAW_PII_MARKERS) {
      expect(serializedCalls).not.toContain(marker);
    }
  });

  it('does not keep known raw HubSpot error logging patterns in source', () => {
    const violations: string[] = [];
    const rawLoggerPattern =
      /logger\.(?:error|warn|info|debug)\([\s\S]*(?:errorDetails|error\.body|error\.response|JSON\.stringify\(error\)|\{\s*args,\s*error\s*\}|errors:\s*response\.errors)/;

    for (const file of collectTsFiles(SRC_DIR)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (!/logger\.(?:error|warn|info|debug)\(/.test(lines[index])) {
          continue;
        }
        const window = collectCallWindow(lines, index);
        if (rawLoggerPattern.test(window)) {
          violations.push(`${path.relative(SRC_DIR, file)}:${index + 1}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('redacts raw Error.details when a HubSpotApiError is logged directly', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new HubSpotApiError('raw-hubspot-error-body jane.customer@example.com', 500, {
      message: 'raw-hubspot-error-body jane.customer@example.com',
      trace: 'pat-na1-sensitive-token-fragment',
      portalId: 1234567890,
      note: 'Customer note: please call my private mobile',
    }, 'safe-request-id');

    logger.warn('Direct HubSpot error log', error);

    const serializedLines = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(serializedLines).toContain('safe-request-id');
    expect(serializedLines).toContain('"statusCode":500');
    expect(serializedLines).not.toContain('"message":');
    expect(serializedLines).not.toContain('"details":');
    for (const marker of RAW_PII_MARKERS) {
      expect(serializedLines).not.toContain(marker);
    }
  });

  it('preserves safe generic Error messages for operational debugging', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.warn('Generic runtime error', new Error('fetch failed: ENOTFOUND'));

    const serializedLines = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(serializedLines).toContain('"message":"fetch failed: ENOTFOUND"');
  });

  it('scrubs token-like substrings from generic Error messages', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.warn('Generic runtime error', new Error('your token sk-abc123def is invalid'));

    const serializedLines = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(serializedLines).not.toContain('sk-abc123def');
    expect(serializedLines).toContain('[REDACTED]');
  });
});
