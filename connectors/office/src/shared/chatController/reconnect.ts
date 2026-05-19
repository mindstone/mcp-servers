export const DEFAULT_RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

export interface ReconnectAttemptStop {
  retry: false;
  error?: unknown;
}

export type ReconnectAttemptResult = void | ReconnectAttemptStop;

export type RunReconnectAttempt = (
  attempt: number,
) =>
  | ReconnectAttemptResult
  | Promise<ReconnectAttemptResult>;

export type ReconnectTimerHandle = ReturnType<typeof setTimeout>;

export type SetReconnectTimer = (
  callback: () => void,
  delayMs: number,
) => ReconnectTimerHandle;

export type ClearReconnectTimer = (timer: ReconnectTimerHandle) => void;

export interface ReconnectLadder {
  readonly disposed: boolean;
  start(runAttempt: RunReconnectAttempt): void;
  cancel(): void;
  currentAttempt(): number | null;
}

export function createReconnectLadder(opts: {
  backoffMs?: readonly number[];
  clock?: () => number;
  setTimer?: SetReconnectTimer;
  clearTimer?: ClearReconnectTimer;
  onAttemptScheduled?: (attempt: number, nextAttemptAtMs: number) => void;
  onGiveUp?: (error?: unknown) => void;
} = {}): ReconnectLadder {
  const backoffMs = opts.backoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
  const clock = opts.clock ?? Date.now;
  const setTimer = opts.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = opts.clearTimer ?? clearTimeout;

  let attempt: number | null = null;
  let timer: ReconnectTimerHandle | null = null;
  let disposed = true;
  let runToken = 0;

  const cancel = (): void => {
    runToken += 1;
    disposeRun();
  };

  const start = (runAttempt: RunReconnectAttempt): void => {
    cancel();
    disposed = false;

    const activeToken = runToken;
    scheduleAttempt(activeToken, runAttempt, 1, 0);
  };

  return {
    get disposed() {
      return disposed;
    },
    start,
    cancel,
    currentAttempt: () => attempt,
  };

  function scheduleAttempt(
    activeToken: number,
    runAttempt: RunReconnectAttempt,
    nextAttempt: number,
    delayMs: number,
  ): void {
    if (activeToken !== runToken) return;

    attempt = nextAttempt;
    safeInvokeCallback(opts.onAttemptScheduled, nextAttempt, clock() + delayMs);

    if (delayMs === 0) {
      runAttemptNow(activeToken, runAttempt, nextAttempt);
      return;
    }

    timer = setTimer(() => {
      timer = null;
      runAttemptNow(activeToken, runAttempt, nextAttempt);
    }, delayMs);
  }

  function runAttemptNow(
    activeToken: number,
    runAttempt: RunReconnectAttempt,
    attemptNumber: number,
  ): void {
    if (activeToken !== runToken) return;

    let result: ReconnectAttemptResult | Promise<ReconnectAttemptResult>;
    try {
      result = runAttempt(attemptNumber);
    } catch (error) {
      handleFailure(activeToken, runAttempt, attemptNumber, error);
      return;
    }

    void Promise.resolve(result)
      .then((value) => {
        if (activeToken !== runToken) return;
        if (value && value.retry === false) {
          disposeRun();
          safeInvokeCallback(opts.onGiveUp, value.error);
          return;
        }

        disposeRun();
      })
      .catch((error) => {
        handleFailure(activeToken, runAttempt, attemptNumber, error);
      });
  }

  function handleFailure(
    activeToken: number,
    runAttempt: RunReconnectAttempt,
    attemptNumber: number,
    error: unknown,
  ): void {
    if (activeToken !== runToken) return;

    const nextDelayMs = backoffMs[attemptNumber - 1];
    if (nextDelayMs === undefined) {
      disposeRun();
      safeInvokeCallback(opts.onGiveUp, error);
      return;
    }

    scheduleAttempt(activeToken, runAttempt, attemptNumber + 1, nextDelayMs);
  }

  function disposeRun(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    attempt = null;
    disposed = true;
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
    // Reconnect callbacks are best-effort and must not recurse/fail the ladder.
  }
}
