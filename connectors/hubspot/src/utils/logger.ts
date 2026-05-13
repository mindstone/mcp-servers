type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Keys that may carry credentials or auth material — redacted before any
// log line is emitted, so a stray `logger.warn('...', tokenPayload)` cannot
// leak. Pattern is conservative: anything containing one of these substrings
// (case-insensitive) gets replaced with `[REDACTED]` in the JSON output.
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|authorization|api[_-]?key|bearer|cookie|session/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[REDACTED:depth]';
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? '[REDACTED]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function formatMessage(level: LogLevel, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  const dataStr =
    data === undefined ? '' : ` ${JSON.stringify(redactValue(data))}`;
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${dataStr}`;
}

function normalizeLogArgs(
  first: string | Record<string, unknown>,
  second?: unknown,
): { message: string; data?: unknown } {
  if (typeof first === 'string') {
    return { message: first, data: second };
  }

  return { message: typeof second === 'string' ? second : '', data: first };
}

type LogMethod = {
  (message: string, data?: unknown): void;
  (data: Record<string, unknown>, message: string): void;
};

interface Logger {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

const logger: Logger = {
  debug(first: string | Record<string, unknown>, second?: unknown): void {
    const { message, data } = normalizeLogArgs(first, second);
    console.error(formatMessage('debug', message, data));
  },

  info(first: string | Record<string, unknown>, second?: unknown): void {
    const { message, data } = normalizeLogArgs(first, second);
    console.error(formatMessage('info', message, data));
  },

  warn(first: string | Record<string, unknown>, second?: unknown): void {
    const { message, data } = normalizeLogArgs(first, second);
    console.error(formatMessage('warn', message, data));
  },

  error(first: string | Record<string, unknown>, second?: unknown): void {
    const { message, data } = normalizeLogArgs(first, second);
    console.error(formatMessage('error', message, data));
  }
};

export default logger;
