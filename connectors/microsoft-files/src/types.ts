import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const SERVER_NAME = 'mcp-server-microsoft-files';
export const SERVER_VERSION = pkg.version;

/**
 * Thrown by files tool functions when a request is rejected by business
 * rules that can only be evaluated AFTER an upstream Graph call (e.g.
 * `read_text_file` rejecting a folder or a binary file).
 *
 * Caught in `utils.ts` (`buildErrorResponse`) and converted into the cohort
 * `{ ok: false, error, action_required, next_step }` recovery-guidance
 * envelope so the host can surface the friendly guidance verbatim.
 *
 * Lives in types.ts (not files.ts) so files.ts can import from client.ts
 * without closing an import cycle through utils.ts.
 */
export class FilesBusinessError extends Error {
  readonly nextStep: string;

  constructor(message: string, nextStep: string) {
    super(message);
    this.name = 'FilesBusinessError';
    this.nextStep = nextStep;
  }
}

export const MS_PACKAGE_ID_DEFAULT = 'Microsoft365Files';
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
    `[microsoft-files-mcp] MICROSOFT_REQUEST_TIMEOUT_MS=${raw} is invalid; falling back to ${DEFAULT_REQUEST_TIMEOUT_MS}ms.`,
  );
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

export const REQUEST_TIMEOUT_MS = resolveRequestTimeoutMs();

export function getMsPackageId(): string {
  return process.env.MS_MCP_PACKAGE_ID ?? MS_PACKAGE_ID_DEFAULT;
}
