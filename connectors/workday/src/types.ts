export const REQUEST_TIMEOUT_MS = 30_000;
export const USER_AGENT = 'MindstoneRebel/1.0 (Workday-MCP)';

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
