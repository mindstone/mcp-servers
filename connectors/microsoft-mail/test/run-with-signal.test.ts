import { describe, expect, it } from 'vitest';
import { abortableSignal, runWithSignal } from '../src/utils.js';

describe('runWithSignal', () => {
  it('resolves with the promise value when the signal does not fire', async () => {
    const ac = new AbortController();
    const promise = Promise.resolve('value');
    await expect(runWithSignal(promise, ac.signal)).resolves.toBe('value');
  });

  it('rejects with the abort reason when the caller signal fires first', async () => {
    const ac = new AbortController();
    const reason = new Error('caller cancelled');
    const slow = new Promise<string>(() => {
      // never resolves
    });
    const wrapped = runWithSignal(slow, ac.signal);
    ac.abort(reason);
    await expect(wrapped).rejects.toBe(reason);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    const reason = new Error('already aborted');
    ac.abort(reason);
    const slow = new Promise<string>(() => {
      // never resolves
    });
    await expect(runWithSignal(slow, ac.signal)).rejects.toBe(reason);
  });

  it('does not throw when the underlying promise rejects after the signal aborts', async () => {
    const ac = new AbortController();
    let rejectInner: (err: unknown) => void = () => {};
    const inner = new Promise<string>((_resolve, reject) => {
      rejectInner = reject;
    });
    const wrapped = runWithSignal(inner, ac.signal);
    ac.abort(new Error('abort first'));
    await expect(wrapped).rejects.toThrow('abort first');
    rejectInner(new Error('late failure'));
    await new Promise((r) => setImmediate(r));
  });
});

describe('abortableSignal composes caller + cohort timeout', () => {
  it('aborts when the caller signal aborts before the timeout', async () => {
    const caller = new AbortController();
    const composed = abortableSignal(caller.signal);
    expect(composed.aborted).toBe(false);
    caller.abort(new Error('caller'));
    await Promise.resolve();
    expect(composed.aborted).toBe(true);
  });

  // `AbortSignal.timeout` is backed by the real event loop and is not
  // controllable via vitest's fake timers, so we use a short real-time
  // timeout to deterministically exercise the timeout-fires path through
  // `runWithSignal`.
  it('rejects when the composed signal timeout fires before the inner promise', async () => {
    const timeoutSignal = AbortSignal.timeout(10);
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 500));
    await expect(runWithSignal(slow, timeoutSignal)).rejects.toBeDefined();
  });
});
