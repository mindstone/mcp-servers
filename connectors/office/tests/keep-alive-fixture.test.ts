import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createKeepAliveFixture } from './fixtures/keep-alive.js';

const override = vi.hoisted(() => ({ child: undefined as ChildProcess | undefined }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: () => override.child! };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); override.child = undefined; });

it.each(['timeout', 'early exit', 'invalid JSON'] as const)('managed fixture reaps its child on %s', async mode => {
  const fixture = await createKeepAliveFixture();
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const child = Object.assign(emitter, {
    pid: 900_001, stdout, stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn((signal: string) => {
      child.signalCode = signal;
      queueMicrotask(() => emitter.emit('exit', null, signal));
      return true;
    }),
  });
  override.child = child as unknown as ChildProcess;
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = expect(fixture.startManagedHelper()).rejects.toThrow(mode === 'timeout' ? 'did not become ready'
      : mode === 'early exit' ? 'exited before ready' : 'invalid JSON');
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(10_001);
    else if (mode === 'early exit') { child.exitCode = 3; emitter.emit('exit', 3); }
    else stdout.write('{broken\n');
    await pending;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    if (mode === 'early exit') expect(child.kill).not.toHaveBeenCalled();
    else expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  } finally {
    vi.useRealTimers();
    await fixture.cleanup();
  }
});
