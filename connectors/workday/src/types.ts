import { createRequire } from 'node:module';
import { z } from 'zod';
import { wrapUntrustedJsonStrings } from './untrusted-content.js';

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

// Locations/jobs: identity and classification fields only — address lines and
// other free-text fields are deliberately excluded from the allowlists.
export const LOCATION_FIELDS = ['id', 'descriptor', 'name', 'inactive', 'isActive', 'href'] as const;

export const JOB_FIELDS = ['id', 'descriptor', 'businessTitle', 'jobType', 'href'] as const;

export const PAYROLL_FAMILY = 'payroll/v2';

// ── Shared input schemas (fail-closed) ──
//
// Validated by the MCP SDK before the handler runs, so a malformed value
// never reaches the network. IDs must be non-blank after trimming; pagination
// must be an integer inside a bounded range — fractional or negative values
// are rejected, not silently rewritten.

export const workerIdSchema = z
  .string()
  .trim()
  .min(1, 'worker_id must not be empty')
  .max(256, 'worker_id is too long');

export const searchQuerySchema = z.string().max(512, 'search is too long');

export const paginationLimitSchema = z.number().int().min(1).max(100);

export const paginationOffsetSchema = z.number().int().min(0).max(1_000_000);

// ── Field allowlisting ──

// Every allowlisted value is vendor-controlled data (AGENTS.md security
// invariant #6), so the envelope decision is a DENY-list, not an allowlist:
// every string reachable in a picked value is wrapped in an
// `<untrusted-content>` envelope, recursively through arrays and objects, and
// only identity fields stay raw. A string-typed value the connector did not
// anticipate (e.g. the vendor sends `startDate` as free text, or a normally
// scalar field arrives as an array/object) is therefore enveloped rather than
// leaked — adding a field to an allowlist can never silently create a raw
// text surface.
//
// The identity field (`id`) stays raw by design — the model round-trips it
// back into subsequent tool calls as a path parameter, so enveloping it would
// corrupt tool chaining. `href` is NOT raw: no registered tool accepts an
// href/URL argument, so there is no round-trip rationale for exempting it.
const RAW_IDENTITY_FIELDS: ReadonlySet<string> = new Set(['id']);

export function pickFields<T extends readonly string[]>(
  obj: Record<string, unknown>,
  fields: T,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in obj) {
      const value = obj[field];
      result[field] = RAW_IDENTITY_FIELDS.has(field)
        ? value
        : wrapUntrustedJsonStrings(value, 'workday');
    }
  }
  return result;
}

// ── Pagination helper ──

// Vendor-reported `total` is vendor-controlled data like any other response
// field: a non-numeric, fractional, or negative value would be interpolated
// raw into `paginationHint` output (or corrupt the search scan-exhaustion
// check). Validate the shape and fall back to the page length when it is
// missing or malformed. The max keeps absurd integer-valued floats (1e21 is
// an "integer" to Number.isInteger) out of the hint.
const vendorTotalSchema = z.number().int().nonnegative().max(1_000_000_000);

export function parseVendorTotal(rawTotal: unknown): number | null {
  const parsed = vendorTotalSchema.safeParse(rawTotal);
  return parsed.success ? parsed.data : null;
}

export function sanitizeVendorTotal(rawTotal: unknown, pageLength: number): number {
  return parseVendorTotal(rawTotal) ?? pageLength;
}

export function paginationHint(total: number, offset: number, count: number): string {
  if (count >= total) return `Showing all ${total} results.`;
  const remaining = total - offset - count;
  return `Showing ${count} of ${total} total (offset=${offset}). ${remaining > 0 ? `Use offset=${offset + count} to see more.` : ''}`;
}
