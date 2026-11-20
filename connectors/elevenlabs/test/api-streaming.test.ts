import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js';
import { artifactProgress, buildStreamedResultMeta, type ProgressContext } from '../src/api-streaming.js';
import { writeWorkspaceArtifactStream } from '../src/tools/path-safety.js';
import { createRedactor } from '../src/api-sensitive.js';

vi.mock('fs', async original => ({ ...await original<typeof import('fs')>() }));
let workspace: string;
beforeEach(() => { workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stream-output-'))); vi.stubEnv('MCP_WORKSPACE_PATH', workspace); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(workspace, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const bytes = (value: string) => new TextEncoder().encode(value);
function controlled() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  return { body, controller, cancel };
}
function receiver(token: string | number = 0) {
  const notifications: ProgressNotification[] = [];
  let resolveFirst!: () => void; const first = new Promise<void>(resolve => { resolveFirst = resolve; });
  const sendNotification = vi.fn(async (notification: ProgressNotification) => {
    const stream = notification.params._meta?.['com.mindstone/stream'] as { ref: string; bytes: number } | undefined;
    if (stream) expect(fs.statSync(path.join(workspace, stream.ref)).size).toBeGreaterThanOrEqual(stream.bytes);
    notifications.push(notification); resolveFirst();
  });
  const context: ProgressContext = { progressToken: token, sendNotification };
  return { notifications, context, sendNotification, first };
}
const value = (notification: ProgressNotification) => notification.params._meta?.['com.mindstone/stream'];
async function flushed(check: () => void) { await vi.waitFor(check, { interval: 1 }); }

it('publishes readable bytes before EOF, preserves mode and bytes, and settles only after the receipt owner finishes', async () => {
  vi.useFakeTimers(); const source = controlled(); const receiverState = receiver('token');
  const progress = artifactProgress('audio/mpeg', receiverState.context);
  const result = writeWorkspaceArtifactStream('sample.mp3', source.body, signal(), progress);
  source.controller.enqueue(bytes('first'));
  await receiverState.first;
  expect(fs.readFileSync(path.join(workspace, 'sample.mp3'), 'utf8')).toBe('first');
  expect(source.body.locked).toBe(true);
  if (process.platform !== 'win32') expect(fs.statSync(path.join(workspace, 'sample.mp3')).mode & 0o777).toBe(0o600);
  source.controller.enqueue(bytes('last')); source.controller.close();
  expect(await result).toEqual({ file_path: path.join(workspace, 'sample.mp3'), size_bytes: 9 });
  expect(source.body.locked).toBe(false);
  await progress.finish('complete');
  expect(receiverState.notifications.map(value)).toEqual([
    { version: 1, ref: 'sample.mp3', bytes: 5, mime: 'audio/mpeg', state: 'running' },
    { version: 1, ref: 'sample.mp3', bytes: 9, mime: 'audio/mpeg', state: 'complete' },
  ]);
  expect(receiverState.notifications.map(item => item.params.progress)).toEqual([1, 2]);
  expect(receiverState.notifications.every(item => item.params.progressToken === 'token' && !('total' in item.params))).toBe(true);
});

it('coalesces high-rate counters at 250 ms with leading, trailing and immediate terminal notifications', async () => {
  vi.useFakeTimers(); const { context, notifications } = receiver();
  fs.writeFileSync(path.join(workspace, 'fast.mp3'), Buffer.alloc(10000));
  const progress = artifactProgress('audio/mpeg', context);
  const update = (n: number) => progress.update(path.join(workspace, 'fast.mp3'), n);
  await update(1);
  for (let n = 2; n <= 1000; n++) await update(n);
  expect(notifications).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(249); expect(notifications).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(value(notifications[1])).toMatchObject({ bytes: 1000, state: 'running' });
  await update(1001); await update(1002); await progress.finish('complete');
  expect(value(notifications[2])).toMatchObject({ bytes: 1002, state: 'complete' });
  await vi.runAllTimersAsync(); await update(1003); await progress.finish('incomplete');
  expect(notifications).toHaveLength(3); expect(vi.getTimerCount()).toBe(0);
  expect(notifications.map(item => item.params.progress)).toEqual([1, 2, 3]);
});

it('publishes slow input immediately without duplicate trailing notifications', async () => {
  vi.useFakeTimers(); const { context, notifications } = receiver();
  const file = path.join(workspace, 'slow.mp3'); fs.writeFileSync(file, 'abc');
  const progress = artifactProgress('audio/mpeg', context);
  for (let i = 1; i <= 3; i++) { await progress.update(file, i); await vi.advanceTimersByTimeAsync(400); }
  await progress.finish('complete'); expect(notifications).toHaveLength(4); expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])('counts short writes and retains exactly the published prefix on abort between writes (progress %s)', async enabled => {
  vi.useFakeTimers(); const { context, notifications } = receiver(); const progress = artifactProgress('audio/mpeg', enabled ? context : undefined);
  const abort = new AbortController(); const open = fs.promises.open;
  let close!: ReturnType<typeof vi.spyOn>;
  vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
    const file = await open(...args); const write = file.write.bind(file); close = vi.spyOn(file, 'close');
    vi.spyOn(file, 'write').mockImplementationOnce(async (buffer, offset, _length) => {
      const result = await write(buffer, offset, 2); abort.abort(); return result;
    }); return file;
  });
  const source = controlled(); source.controller.enqueue(bytes('abcdef'));
  const result = writeWorkspaceArtifactStream('short.mp3', source.body, abort.signal, progress);
  if (enabled) {
    await expect(result).rejects.toMatchObject({ retained_output: { file_path: path.join(workspace, 'short.mp3'), size_bytes: 2, media_type: 'audio/mpeg', state: 'incomplete' } });
    expect(fs.readFileSync(path.join(workspace, 'short.mp3'), 'utf8')).toBe('ab');
    expect(notifications.map(value)).toMatchObject([{ bytes: 2, state: 'running' }, { bytes: 2, state: 'incomplete' }]);
  } else { await expect(result).rejects.toThrow(); expect(fs.readdirSync(workspace)).toEqual([]); }
  expect(close).toHaveBeenCalled(); expect(source.cancel).toHaveBeenCalled(); expect(source.body.locked).toBe(false);
});

it.each(['read failure', 'abort after publication'])('retains output on %s and releases the reader and file', async mode => {
  vi.useFakeTimers(); const { context, notifications, first } = receiver(); const source = controlled(); const abort = new AbortController();
  const progress = artifactProgress('audio/mpeg', context);
  const result = writeWorkspaceArtifactStream('prefix.mp3', source.body, abort.signal, progress);
  const assertion = expect(result).rejects.toMatchObject({ retained_output: { size_bytes: 6, state: 'incomplete' } });
  source.controller.enqueue(bytes('prefix')); await first;
  if (mode === 'read failure') source.controller.error(new Error('raw provider secret')); else abort.abort();
  await assertion; expect(fs.readFileSync(path.join(workspace, 'prefix.mp3'), 'utf8')).toBe('prefix');
  expect(source.body.locked).toBe(false); expect(value(notifications.at(-1)!)).toMatchObject({ state: 'incomplete', bytes: 6 });
});

it.each(['pre-abort', 'read error', 'locked body', 'zero write'])('removes empty setup files on %s', async mode => {
  vi.useFakeTimers(); const { context, notifications, first } = receiver(); const source = controlled(); const abort = new AbortController();
  const lock = mode === 'locked body' ? source.body.getReader() : undefined;
  if (mode === 'pre-abort') abort.abort();
  if (mode === 'read error') source.controller.error(new Error('failed'));
  if (mode === 'zero write') {
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => { const file = await open(...args); vi.spyOn(file, 'write').mockResolvedValueOnce({ bytesWritten: 0, buffer: bytes('a') }); return file; });
    source.controller.enqueue(bytes('a'));
  }
  await expect(writeWorkspaceArtifactStream('empty.mp3', source.body, abort.signal, artifactProgress('audio/mpeg', context))).rejects.toThrow();
  lock?.releaseLock(); expect(fs.readdirSync(workspace)).toEqual([]); expect(notifications).toEqual([]);
});

it('leaves legacy no-token read failure cleanup unchanged', async () => {
  const source = controlled(); const result = writeWorkspaceArtifactStream('legacy.mp3', source.body, signal());
  const assertion = expect(result).rejects.toThrow(); source.controller.enqueue(bytes('prefix'));
  await flushed(() => expect(fs.statSync(path.join(workspace, 'legacy.mp3')).size).toBe(6));
  source.controller.error(new Error('failure')); await assertion;
  expect(fs.readdirSync(workspace)).toEqual([]); expect(source.body.locked).toBe(false);
});

it('uses plain text/size progress in the temporary fallback without inventing a workspace ref', async () => {
  vi.useFakeTimers(); vi.stubEnv('MCP_WORKSPACE_PATH', ''); const { context, notifications } = receiver();
  const progress = artifactProgress('audio/mpeg', context);
  const name = `stream-${path.basename(workspace)}.mp3`;
  const source = controlled(); source.controller.enqueue(bytes('abc')); source.controller.close();
  const result = await writeWorkspaceArtifactStream(name, source.body, signal(), progress);
  try { await progress.finish('complete'); expect(notifications.map(item => item.params.message)).toEqual(['Saved 3 bytes (running).', 'Saved 3 bytes (complete).']); expect(notifications.every(item => !item.params._meta)).toBe(true); }
  finally { fs.unlinkSync(result.file_path); }
});

it('keeps previously published output and reports progress delivery failure without raw transport data', async () => {
  vi.useFakeTimers(); const { context, notifications, sendNotification } = receiver();
  const file = path.join(workspace, 'delivery.mp3'); fs.writeFileSync(file, 'abc');
  const progress = artifactProgress('audio/mpeg', context); await progress.update(file, 1);
  sendNotification.mockRejectedValue(new Error('raw transport secret'));
  await progress.update(file, 3); await vi.advanceTimersByTimeAsync(250);
  await expect(progress.finish('incomplete')).rejects.toMatchObject({ code: 'PROGRESS_DELIVERY_FAILED', message: 'Output progress could not be delivered.' });
  expect(progress.retained()).toMatchObject({ file_path: file, size_bytes: 3, state: 'incomplete' }); expect(notifications).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
});

it('uses the same sink for validated redacted metadata; malformed later records preserve published records', async () => {
  vi.useFakeTimers(); const { context, notifications, first } = receiver(); const redactor = createRedactor(['synthetic-private-value']);
  const schema = z.object({ text: z.string() }).strict();
  const transform = new TransformStream<unknown, Uint8Array>({ transform(record, sink) {
    sink.enqueue(bytes(JSON.stringify(redactor.redact(schema.parse(record))) + '\n'));
  } });
  const writer = transform.writable.getWriter();
  const result = writeWorkspaceArtifactStream('metadata.jsonl', transform.readable, signal(), artifactProgress('application/x-ndjson', context));
  const assertion = expect(result).rejects.toMatchObject({ retained_output: { state: 'incomplete', media_type: 'application/x-ndjson' } });
  await writer.write({ text: 'synthetic-private-value' }); await first;
  await expect(writer.write({ text: 42 })).rejects.toThrow(); await assertion;
  const saved = fs.readFileSync(path.join(workspace, 'metadata.jsonl'), 'utf8');
  expect(saved).not.toContain('synthetic-private-value'); expect(saved).not.toContain('42'); expect(JSON.parse(saved)).toHaveProperty('text');
  expect(transform.readable.locked).toBe(false);
});

it('matches the serialized standalone v1 fixture', async () => {
  const rows = JSON.parse(fs.readFileSync(new URL('./fixtures/streamed-result-v1.json', import.meta.url), 'utf8'));
  for (const row of rows) { const { version: _version, ...input } = row; expect(buildStreamedResultMeta(input)).toEqual({ 'com.mindstone/stream': row }); }
});

it('uses portable refs when the configured workspace is a symlink alias', async () => {
  const alias = workspace + '-alias'; fs.symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    vi.stubEnv('MCP_WORKSPACE_PATH', alias); const { context, notifications } = receiver();
    const progress = artifactProgress('audio/mpeg', context);
    const source = controlled(); source.controller.enqueue(bytes('abc')); source.controller.close();
    await writeWorkspaceArtifactStream('alias.mp3', source.body, signal(), progress); await progress.finish('complete');
    expect(value(notifications[0])).toMatchObject({ ref: 'alias.mp3' });
  } finally { fs.unlinkSync(alias); }
});

it('completes all short writes and counts the exact final bytes', async () => {
  vi.useFakeTimers(); const { context, notifications } = receiver(); const open = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
    const handle = await open(...args); const write = handle.write.bind(handle);
    vi.spyOn(handle, 'write').mockImplementation(async (buffer, offset, length) => write(buffer, offset, Math.min(2, length)));
    return handle;
  });
  const source = controlled(); source.controller.enqueue(bytes('abcdef')); source.controller.close();
  const progress = artifactProgress('audio/mpeg', context);
  const result = await writeWorkspaceArtifactStream('short-success.mp3', source.body, signal(), progress); await progress.finish('complete');
  expect(result.size_bytes).toBe(6); expect(fs.readFileSync(result.file_path, 'utf8')).toBe('abcdef');
  expect(notifications.map(value)).toMatchObject([{ bytes: 2 }, { bytes: 6, state: 'complete' }]);
});

it('does not delete an existing output or follow a planted symlink', async () => {
  const existing = path.join(workspace, 'existing.mp3'); fs.writeFileSync(existing, 'original');
  const alias = path.join(workspace, 'planted.mp3'); fs.symlinkSync(existing, alias);
  for (const name of ['existing.mp3', 'planted.mp3']) {
    const source = controlled(); source.controller.close();
    await expect(writeWorkspaceArtifactStream(name, source.body, signal())).rejects.toMatchObject({ code: 'OUTPUT_FILE_EXISTS' });
  }
  expect(fs.readFileSync(existing, 'utf8')).toBe('original');
});

it.each([false, true])('aborts a stalled notification without publishing it (earlier publication %s)', async earlier => {
  const abort = new AbortController(); const source = controlled();
  let stalled!: () => void; const sending = new Promise<void>(resolve => { stalled = resolve; });
  let release!: () => void;
  const send = vi.fn(async () => {
    if (earlier && send.mock.calls.length === 1) return;
    stalled(); await new Promise<void>(resolve => { release = resolve; });
  });
  const progress = artifactProgress('audio/mpeg', { progressToken: 0, sendNotification: send });
  const result = writeWorkspaceArtifactStream('stalled.mp3', source.body, abort.signal, progress);
  const assertion = expect(result).rejects.toMatchObject({ code: 'PROGRESS_DELIVERY_FAILED', retained_output: earlier ? { size_bytes: 6 } : undefined });
  source.controller.enqueue(bytes('abc'));
  if (earlier) {
    await vi.waitFor(() => expect(progress.retained()).toMatchObject({ size_bytes: 3 }));
    source.controller.enqueue(bytes('def'));
  }
  await sending; abort.abort(); await assertion;
  expect(source.body.locked).toBe(false); expect(source.cancel).toHaveBeenCalled();
  expect(fs.existsSync(path.join(workspace, 'stalled.mp3'))).toBe(earlier);
  release(); await Promise.resolve(); expect(!!progress.retained()).toBe(earlier);
});
