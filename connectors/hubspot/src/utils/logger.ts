type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Keys that may carry credentials or auth material — redacted before any
// log line is emitted, so a stray `logger.warn('...', tokenPayload)` cannot
// leak. Pattern is conservative: anything containing one of these substrings
// (case-insensitive) gets replaced with `[REDACTED]` in the JSON output.
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|authorization|api[_-]?key|bearer|cookie|session/i;

const MAX_GENERIC_ERROR_MESSAGE_LENGTH = 500;
const SENSITIVE_MESSAGE_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:sk|pat|oauth|token)[-_][A-Za-z0-9_-]{6,}\b/gi,
  /\bya29\.[A-Za-z0-9_-]+\b/gi,
];

function safeLogIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) return undefined;
  return value;
}

function truncateMessage(value: string, maxLength = MAX_GENERIC_ERROR_MESSAGE_LENGTH): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[truncated]`;
}

function scrubSensitiveMessageFragments(value: string): string {
  let scrubbed = value;
  for (const pattern of SENSITIVE_MESSAGE_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '[REDACTED]');
  }
  return scrubbed;
}

function topStackFrames(stack: unknown, frameCount = 2): string | undefined {
  if (typeof stack !== 'string' || stack.length === 0) {
    return undefined;
  }

  const lines = stack.split('\n');
  const firstLine = lines[0];
  const frames = lines.slice(1, frameCount + 1);
  return [firstLine, ...frames]
    .map((line) => truncateMessage(scrubSensitiveMessageFragments(line)))
    .join('\n');
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[REDACTED:depth]';
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) {
    const errorRecord = value as Error & {
      statusCode?: unknown;
      code?: unknown;
      requestId?: unknown;
      details?: unknown;
    };
    const safeCode = safeLogIdentifier(errorRecord.code);
    const safeRequestId = safeLogIdentifier(errorRecord.requestId);
    const sharedProjection = {
      name: value.name,
      ...(typeof errorRecord.statusCode === 'number' ? { statusCode: errorRecord.statusCode } : {}),
      ...(safeCode ? { code: safeCode } : {}),
      ...(safeRequestId ? { requestId: safeRequestId } : {}),
    };

    if ('details' in errorRecord) {
      return sharedProjection;
    }

    const safeMessage = truncateMessage(scrubSensitiveMessageFragments(value.message));
    const safeStack = topStackFrames(value.stack);
    return {
      ...sharedProjection,
      ...(safeMessage.length > 0 ? { message: safeMessage } : {}),
      ...(safeStack ? { stack: safeStack } : {}),
    };
  }
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
