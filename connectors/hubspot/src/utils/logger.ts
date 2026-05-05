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

const logger = {
  debug(message: string, data?: unknown): void {
    console.error(formatMessage('debug', message, data));
  },

  info(message: string, data?: unknown): void {
    console.error(formatMessage('info', message, data));
  },

  warn(message: string, data?: unknown): void {
    console.error(formatMessage('warn', message, data));
  },

  error(message: string, data?: unknown): void {
    console.error(formatMessage('error', message, data));
  }
};

export default logger;
