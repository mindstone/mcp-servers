import * as path from 'node:path';

const API_KEY_PATTERN = /\bsk-(?:ant-|proj-)?[A-Za-z0-9][A-Za-z0-9_-]*\b/gu;
const PATH_TERMINATORS = new Set([
  '\n',
  '\r',
  '\t',
  '"',
  "'",
  '`',
  ')',
  '(',
  '[',
  ']',
  '{',
  '}',
  '<',
  '>',
  '|',
  ',',
  ';',
]);

const getWorkspacePathFromEnv = (): string | undefined => {
  const value = process.env.MCP_WORKSPACE_PATH?.trim();
  return value ? path.resolve(value) : undefined;
};

const scrubWorkspacePathVariant = (
  source: string,
  workspacePathVariant: string,
): string => {
  if (!workspacePathVariant) {
    return source;
  }

  let output = source;
  let startIndex = output.indexOf(workspacePathVariant);
  const workspaceBase = path.basename(workspacePathVariant);

  while (startIndex !== -1) {
    let endIndex = startIndex + workspacePathVariant.length;

    while (endIndex < output.length) {
      const char = output[endIndex];
      if (
        PATH_TERMINATORS.has(char) ||
        (char === ' ' && output[endIndex - 1] !== '\\')
      ) {
        break;
      }
      endIndex += 1;
    }

    const rawMatch = output.slice(startIndex, endIndex).replace(/[\\/]+$/u, '');
    const basename = path.basename(rawMatch);
    const replacement =
      basename && basename !== workspaceBase
        ? `<workspace>/${basename}`
        : '<workspace>';

    output = `${output.slice(0, startIndex)}${replacement}${output.slice(endIndex)}`;
    startIndex = output.indexOf(workspacePathVariant, startIndex + replacement.length);
  }

  return output;
};

const scrubWorkspacePaths = (source: string): string => {
  const workspacePath = getWorkspacePathFromEnv();
  if (!workspacePath) {
    return source;
  }

  const variants = [...new Set([
    workspacePath,
    workspacePath.replace(/\\/gu, '/'),
    workspacePath.replace(/\//gu, '\\'),
  ])];

  return variants.reduce(scrubWorkspacePathVariant, source);
};

const scrubString = (source: string): string => {
  let output = source;

  const configuredApiKey = process.env.OPENAI_API_KEY?.trim();
  if (configuredApiKey) {
    output = output.split(configuredApiKey).join('REDACTED-API-KEY');
  }

  output = output.replace(API_KEY_PATTERN, 'REDACTED-API-KEY');
  output = scrubWorkspacePaths(output);
  return output;
};

const scrubUnknown = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === 'string') {
    return scrubString(value);
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'undefined'
  ) {
    return value;
  }

  if (typeof value === 'function') {
    return '[Function]';
  }

  if (value instanceof Error) {
    return {
      name: scrubString(value.name),
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubUnknown(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const scrubbed: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /prompt/iu.test(key)) {
        scrubbed[key] = 'REDACTED-PROMPT';
        continue;
      }
      scrubbed[key] = scrubUnknown(item, seen);
    }
    return scrubbed;
  }

  return scrubString(String(value));
};

export const redactSensitiveInLogs = (value: unknown): unknown =>
  scrubUnknown(value, new WeakSet<object>());

const emit = (
  level: 'debug' | 'info' | 'log' | 'warn' | 'error',
  ...args: unknown[]
): void => {
  const scrubbedArgs = args.map((arg) => redactSensitiveInLogs(arg));
  switch (level) {
    case 'debug':
      console.debug(...scrubbedArgs);
      return;
    case 'info':
      console.info(...scrubbedArgs);
      return;
    case 'warn':
      console.warn(...scrubbedArgs);
      return;
    case 'error':
      console.error(...scrubbedArgs);
      return;
    default:
      console.log(...scrubbedArgs);
  }
};

export const logger = {
  debug: (...args: unknown[]): void => emit('debug', ...args),
  info: (...args: unknown[]): void => emit('info', ...args),
  log: (...args: unknown[]): void => emit('log', ...args),
  warn: (...args: unknown[]): void => emit('warn', ...args),
  error: (...args: unknown[]): void => emit('error', ...args),
};
