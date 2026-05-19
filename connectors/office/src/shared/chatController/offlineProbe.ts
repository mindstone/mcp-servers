export const DEFAULT_OFFLINE_PROBE_INTERVAL_MS = 5_000;
export const DEFAULT_OFFLINE_PROBE_MAX_ATTEMPTS = 12;

export type OfflineProbeTimerHandle = ReturnType<typeof setTimeout>;

export type SetOfflineProbeTimer = (
  callback: () => void,
  delayMs: number,
) => OfflineProbeTimerHandle;

export type ClearOfflineProbeTimer = (timer: OfflineProbeTimerHandle) => void;

export interface OfflineProbeLoop {
  readonly running: boolean;
  cancel(): void;
  currentAttempt(): number | null;
}

export function runOfflineProbeLoop(opts: {
  probe: () => boolean | Promise<boolean>;
  maxAttempts?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  onAttempt?: (attempt: number, reachable: boolean) => void;
  onOnline?: (attempt: number) => void;
  onGaveUp?: (attempt: number) => void;
  setTimer?: SetOfflineProbeTimer;
  clearTimer?: ClearOfflineProbeTimer;
}): OfflineProbeLoop {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_OFFLINE_PROBE_MAX_ATTEMPTS;
  const intervalMs = opts.intervalMs ?? DEFAULT_OFFLINE_PROBE_INTERVAL_MS;
  const setTimer = opts.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = opts.clearTimer ?? clearTimeout;

  let running = true;
  let timer: OfflineProbeTimerHandle | null = null;
  let attempt: number | null = null;
  let cancelled = false;

  const handleAbort = (): void => {
    cancel();
  };

  opts.signal?.addEventListener('abort', handleAbort, { once: true });

  void runAttempt(1);

  return {
    get running() {
      return running;
    },
    cancel,
    currentAttempt: () => attempt,
  };

  function cancel(): void {
    if (cancelled) return;
    cancelled = true;
    running = false;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    opts.signal?.removeEventListener('abort', handleAbort);
  }

  async function runAttempt(nextAttempt: number): Promise<void> {
    if (cancelled || opts.signal?.aborted) {
      cancel();
      return;
    }

    attempt = nextAttempt;

    let reachable = false;
    try {
      reachable = await opts.probe();
    } catch {
      reachable = false;
    }

    if (cancelled || opts.signal?.aborted) {
      cancel();
      return;
    }

    safeInvokeCallback(opts.onAttempt, nextAttempt, reachable);

    if (reachable) {
      cancel();
      safeInvokeCallback(opts.onOnline, nextAttempt);
      return;
    }

    if (nextAttempt >= maxAttempts) {
      cancel();
      safeInvokeCallback(opts.onGaveUp, nextAttempt);
      return;
    }

    timer = setTimer(() => {
      timer = null;
      void runAttempt(nextAttempt + 1);
    }, intervalMs);
  }
}

function safeInvokeCallback<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => void) | undefined,
  ...args: TArgs
): void {
  if (!callback) return;
  try {
    callback(...args);
  } catch {
    // Recovery callbacks must not escape the probe loop.
  }
}
