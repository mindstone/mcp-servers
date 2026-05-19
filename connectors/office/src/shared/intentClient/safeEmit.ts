import type { DiagnosticEvent, DiagnosticSink } from './diagnostics.js';

/**
 * Wrap potentially user-provided callbacks so they cannot crash client flows.
 */
export function safeInvoke<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => unknown) | undefined,
  ...args: TArgs
): void {
  if (!callback) return;
  try {
    const maybePromise = callback(...args);
    if (isPromiseLike(maybePromise)) {
      void maybePromise.catch(() => {
        // Intentionally swallowed: diagnostics/hooks are best-effort.
      });
    }
  } catch {
    // Intentionally swallowed: diagnostics/hooks are best-effort.
  }
}

export function safeEmit(
  sink: DiagnosticSink | undefined,
  event: DiagnosticEvent,
): void {
  safeInvoke((nextEvent: DiagnosticEvent) => sink?.emit(nextEvent), event);
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
