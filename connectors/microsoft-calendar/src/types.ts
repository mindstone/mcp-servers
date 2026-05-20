import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const SERVER_NAME = 'mcp-server-microsoft-calendar';
export const SERVER_VERSION = pkg.version;

export const MS_PACKAGE_ID_DEFAULT = 'Microsoft365Calendar';
export const AUTH_TOOL_NAME = 'authenticate_microsoft_account';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;

function resolveRequestTimeoutMs(): number {
  const raw = process.env.MICROSOFT_REQUEST_TIMEOUT_MS;
  if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_REQUEST_TIMEOUT_MS) {
    return parsed;
  }
  console.error(
    `[microsoft-calendar-mcp] MICROSOFT_REQUEST_TIMEOUT_MS=${raw} is invalid; falling back to ${DEFAULT_REQUEST_TIMEOUT_MS}ms.`,
  );
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

export const REQUEST_TIMEOUT_MS = resolveRequestTimeoutMs();

export function getMsPackageId(): string {
  return process.env.MS_MCP_PACKAGE_ID ?? MS_PACKAGE_ID_DEFAULT;
}
