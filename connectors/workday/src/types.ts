import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const REQUEST_TIMEOUT_MS = 30_000;
// Derived from package.json so the UA can never drift from the release version.
export const USER_AGENT = `mcp-server-workday/${pkg.version}`;

export interface BridgeState {
  port: number;
  token: string;
}

export class WorkdayError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'WorkdayError';
  }
}

// ── Allowlisted response fields ──

export const WORKER_LIST_FIELDS = ['id', 'descriptor', 'primaryWorkEmail', 'businessTitle', 'isManager'] as const;

export const WORKER_DETAIL_FIELDS = ['id', 'descriptor', 'primaryWorkEmail', 'businessTitle', 'isManager', 'yearsOfService', 'href'] as const;

export const NESTED_OBJECT_FIELDS = ['id', 'descriptor'] as const;

export const ORG_LIST_FIELDS = ['id', 'descriptor', 'type', 'isActive', 'href'] as const;

// Time-off entries: scalar scheduling fields only — comment/reason fields are
// free text authored in Workday and deliberately excluded from the allowlist.
export const TIME_OFF_FIELDS = ['id', 'descriptor', 'startDate', 'endDate', 'quantity', 'unitOfTime', 'status', 'href'] as const;

export const ABSENCE_MANAGEMENT_FAMILY = 'absenceManagement/v1';

// Workday versions its recruiting REST family by platform release (e.g.
// v41.2) and retires old versions over time; override via
// WORKDAY_RECRUITING_API_VERSION when a tenant exposes a different one.
export const RECRUITING_API_VERSION_DEFAULT = 'v41.2';

// Job requisitions: scalar status/openings fields only — description and
// other free-text fields are deliberately excluded from the allowlist.
export const JOB_REQUISITION_FIELDS = [
  'id',
  'descriptor',
  'title',
  'status',
  'recruitingStatus',
  'openings',
  'numberOfOpenings',
  'href',
] as const;

// ── Field allowlisting ──

export function pickFields<T extends readonly string[]>(
  obj: Record<string, unknown>,
  fields: T,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in obj) {
      result[field] = obj[field];
    }
  }
  return result;
}

// ── Pagination helper ──

export function paginationHint(total: number, offset: number, count: number): string {
  if (count >= total) return `Showing all ${total} results.`;
  const remaining = total - offset - count;
  return `Showing ${count} of ${total} total (offset=${offset}). ${remaining > 0 ? `Use offset=${offset + count} to see more.` : ''}`;
}
