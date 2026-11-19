import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Logger utility with configurable logging behavior.
 * 
 * Supports two logging modes:
 * - normal: Uses appropriate console methods for each log level (error, warn, info, debug)
 * - strict: Routes all non-JSON-RPC messages to stderr for compatibility with tools like Claude desktop
 * 
 * Configure via:
 * - LOG_MODE environment variable:
 *   - LOG_MODE=normal (default) - Standard logging behavior
 *   - LOG_MODE=strict - All logs except JSON-RPC go to stderr
 * - LOG_FILE environment variable:
 *   - If set, logs will also be written to this file
 * 
 * For testing: The logger should be mocked in tests to prevent console noise.
 * See src/__helpers__/testSetup.ts for the mock implementation.
 */

type LogMode = 'normal' | 'strict';

const LOG_MODE = (process.env.LOG_MODE || 'normal') as LogMode;
const LOG_FILE = process.env.LOG_FILE;

// Ensure log directory exists if LOG_FILE is set
if (LOG_FILE) {
  const dir = dirname(LOG_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const isJsonRpc = (msg: any): boolean => {
  if (typeof msg !== 'string') return false;
  return msg.startsWith('{"jsonrpc":') || msg.startsWith('{"id":');
};

const MAX_RENDER_DEPTH = 6;

const renderError = (error: Error): string => error.stack || `${error.name}: ${error.message}`;

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const renderValue = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
  if (value instanceof Error) return renderError(value);
  if (typeof value !== 'object' || value === null) return value;
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_RENDER_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]';
  seen.add(value);
  const copy = Array.isArray(value)
    ? value.map((item) => renderValue(item, depth + 1, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, depth + 1, seen)]));
  seen.delete(value);
  return copy;
};

/**
 * Renders every `Error` in a log argument (top level, or nested at any depth
 * in plain objects and arrays) as a plain string (its stack, or `name: message`),
 * so console and the log file never print its cause chain or a gaxios error's
 * config, request, response or headers. Plain objects and arrays are copied;
 * every other value passes through unchanged.
 */
export const renderLogArg = (arg: unknown): unknown => renderValue(arg, 0, new WeakSet());

const renderArgs = (args: any[]): any[] => args.map(renderLogArg);

const writeToLogFile = (level: string, ...args: any[]) => {
  if (!LOG_FILE) return;
  try {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      typeof arg === 'string' ? arg : JSON.stringify(arg)
    ).join(' ');
    appendFileSync(LOG_FILE, `[${timestamp}] [${level.toUpperCase()}] ${message}\n`);
  } catch (error) {
    console.error('Failed to write to log file:', renderLogArg(error));
  }
};

const logger = {
  error: (...rawArgs: any[]) => {
    const args = renderArgs(rawArgs);
    console.error(...args);
    writeToLogFile('error', ...args);
  },
  warn: (...rawArgs: any[]) => {
    const args = renderArgs(rawArgs);
    if (LOG_MODE === 'strict' || isJsonRpc(args[0])) {
      console.error(...args);
    } else {
      console.warn(...args);
    }
    writeToLogFile('warn', ...args);
  },
  info: (...rawArgs: any[]) => {
    const args = renderArgs(rawArgs);
    if (LOG_MODE === 'strict' || isJsonRpc(args[0])) {
      console.error(...args);
    } else {
      console.info(...args);
    }
    writeToLogFile('info', ...args);
  },
  debug: (...rawArgs: any[]) => {
    if (!process.env.DEBUG) return;
    const args = renderArgs(rawArgs);
    if (LOG_MODE === 'strict' || isJsonRpc(args[0])) {
      console.error(...args);
    } else {
      console.debug(...args);
    }
    if (process.env.DEBUG) {
      writeToLogFile('debug', ...args);
    }
  }
};

export default logger;
