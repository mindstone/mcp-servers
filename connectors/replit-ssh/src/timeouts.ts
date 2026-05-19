export const DEFAULT_REPLIT_SSH_REQUEST_TIMEOUT_MS = 60_000;
export const MAX_REPLIT_SSH_REQUEST_TIMEOUT_MS = 10 * 60_000;

function readTimeoutEnv(): number {
  const raw = process.env.REPLIT_SSH_REQUEST_TIMEOUT_MS;
  if (!raw) return DEFAULT_REPLIT_SSH_REQUEST_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_REPLIT_SSH_REQUEST_TIMEOUT_MS) {
    console.error(
      `[replit-ssh] REPLIT_SSH_REQUEST_TIMEOUT_MS=${raw} is invalid; falling back to ${DEFAULT_REPLIT_SSH_REQUEST_TIMEOUT_MS}ms.`,
    );
    return DEFAULT_REPLIT_SSH_REQUEST_TIMEOUT_MS;
  }
  return parsed;
}

export const REPLIT_SSH_REQUEST_TIMEOUT_MS = readTimeoutEnv();

export function composeRequestSignal(callerSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REPLIT_SSH_REQUEST_TIMEOUT_MS);
  if (!callerSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  const controller = new AbortController();
  const onAbort = (reason: unknown) => controller.abort(reason);
  if (callerSignal.aborted) controller.abort(callerSignal.reason);
  else callerSignal.addEventListener('abort', () => onAbort(callerSignal.reason), { once: true });
  if (timeoutSignal.aborted) controller.abort(timeoutSignal.reason);
  else timeoutSignal.addEventListener('abort', () => onAbort(timeoutSignal.reason), { once: true });
  return controller.signal;
}

export function isTimeoutAbort(signal: AbortSignal): boolean {
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === 'TimeoutError';
}

export function buildTimeoutError(): {
  ok: false;
  error: string;
  code: 'CONNECTION_TIMEOUT';
  action_required: string;
  next_step: string;
} {
  return {
    ok: false,
    error: `Request timed out after ${REPLIT_SSH_REQUEST_TIMEOUT_MS}ms.`,
    code: 'CONNECTION_TIMEOUT',
    action_required: 'Retry the operation; increase REPLIT_SSH_REQUEST_TIMEOUT_MS if the Repl is slow.',
    next_step: 'Retry the tool. If the Repl is consistently slow, set REPLIT_SSH_REQUEST_TIMEOUT_MS to a higher value.',
  };
}
