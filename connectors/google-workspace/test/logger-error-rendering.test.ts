import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-logger-'));
const logFile = path.join(dir, 'server.log');

function gaxiosLikeError(): Error {
  const inner = new Error('CAUSE_MARKER inner failure');
  const error = new Error('Request failed with status 403', { cause: inner }) as Error & Record<string, unknown>;
  error.config = { url: 'https://example.com', headers: { Authorization: 'Bearer HEADER_MARKER' } };
  error.response = { status: 403, data: { error: 'RESPONSE_DATA_MARKER' }, headers: { 'x-secret': 'HEADER_MARKER' } };
  return error;
}

function rendered(calls: unknown[][]): string {
  return calls.map((call) => format(...call)).join('\n');
}

describe('logger renders Error arguments as plain strings', () => {
  let logger: typeof import('../src/utils/logger.js').default;

  beforeAll(async () => {
    vi.stubEnv('LOG_FILE', logFile);
    vi.stubEnv('LOG_MODE', 'normal');
    vi.resetModules();
    logger = (await import('../src/utils/logger.js')).default;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['error', 'warn', 'info'] as const)('%s: keeps the message, drops cause, config and response', (level) => {
    const spies = (['error', 'warn', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    fs.rmSync(logFile, { force: true });

    logger[level]('Operation failed:', gaxiosLikeError());

    const calls = spies.flatMap((spy) => spy.mock.calls);
    expect(calls).toHaveLength(1);
    for (const arg of calls[0]) expect(arg).not.toBeInstanceOf(Error);
    const consoleText = rendered(calls);
    const fileText = fs.readFileSync(logFile, 'utf8');
    for (const text of [consoleText, fileText]) {
      expect(text).toContain('Operation failed:');
      expect(text).toContain('Request failed with status 403');
      expect(text).not.toContain('CAUSE_MARKER');
      expect(text).not.toContain('HEADER_MARKER');
      expect(text).not.toContain('RESPONSE_DATA_MARKER');
    }
  });

  it.each([
    ['nested object', () => ({ err: gaxiosLikeError(), messageId: 'm-1' })],
    ['array', () => ['first', gaxiosLikeError()]],
  ] as const)('warn: renders an Error nested in an %s', (_label, makeArg) => {
    const spies = (['error', 'warn', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    fs.rmSync(logFile, { force: true });

    logger.warn(makeArg(), 'Failed to get message');

    const calls = spies.flatMap((spy) => spy.mock.calls);
    expect(calls).toHaveLength(1);
    const consoleText = rendered(calls);
    const fileText = fs.readFileSync(logFile, 'utf8');
    for (const text of [consoleText, fileText]) {
      expect(text).toContain('Failed to get message');
      expect(text).toContain('Request failed with status 403');
      expect(text).not.toContain('CAUSE_MARKER');
      expect(text).not.toContain('HEADER_MARKER');
      expect(text).not.toContain('RESPONSE_DATA_MARKER');
    }
  });

  it('copies nested values without mutating the input and survives cycles', async () => {
    const { renderLogArg } = await import('../src/utils/logger.js');
    const error = gaxiosLikeError();
    const input: Record<string, unknown> = { err: error, meta: { id: 1, when: new Date(0) } };
    input.self = input;
    const output = renderLogArg(input) as Record<string, unknown>;
    expect(input.err).toBe(error);
    expect(typeof output.err).toBe('string');
    expect(output.self).toBe('[Circular]');
    expect((output.meta as Record<string, unknown>).when).toEqual(new Date(0));
  });

  it('renders an Error without a stack as name: message', async () => {
    const { renderLogArg } = await import('../src/utils/logger.js');
    const error = new TypeError('no stack here', { cause: new Error('CAUSE_MARKER') });
    error.stack = undefined;
    expect(renderLogArg(error)).toBe('TypeError: no stack here');
    expect(renderLogArg({ plain: 1 })).toEqual({ plain: 1 });
  });
});
