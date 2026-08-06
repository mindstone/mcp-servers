import { describe, expect, it } from 'vitest';

import { stringifyToolResult } from '../src/api.js';

describe('stringifyToolResult — truncation (adversarial re-review F3)', () => {
  const bigVendors = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `vendor_${index}`,
      note: 'x'.repeat(2_000),
    }));

  it('omits pageInfo and never directs the caller at a stale cursor when records are dropped', () => {
    const out = JSON.parse(stringifyToolResult({
      ok: true,
      vendors: bigVendors(20),
      count: 20,
      pageInfo: { endCursor: 'cursor-past-dropped-records', hasNextPage: true },
    })) as Record<string, unknown>;

    // Records were dropped and the truncation is flagged...
    expect(out.truncated).toBe(true);
    expect(out.original_count).toBe(20);
    expect(out.count as number).toBeLessThan(20);
    expect(out.vendors as unknown[]).toHaveLength(out.count as number);

    // ...but the cursor from the FULL page must not survive: it points past
    // the dropped records, so following it would skip them silently.
    expect('pageInfo' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('cursor-past-dropped-records');
    expect(out.truncation_hint).toContain('smaller page_size');
    expect(out.truncation_hint).not.toBe(
      'Response exceeded 25KB. Retry with a smaller page_size or use page_cursor to continue.',
    );
  });

  it('keeps pageInfo verbatim when the payload fits within the cap', () => {
    const out = JSON.parse(stringifyToolResult({
      ok: true,
      vendors: [{ id: 'vendor_1' }],
      count: 1,
      pageInfo: { endCursor: 'cursor-1', hasNextPage: true },
    })) as Record<string, unknown>;

    expect(out.truncated).toBeUndefined();
    expect(out.pageInfo).toEqual({ endCursor: 'cursor-1', hasNextPage: true });
  });

  it('falls back to the metadata-only response when no array field exists to trim', () => {
    const out = JSON.parse(stringifyToolResult({
      ok: true,
      blob: 'x'.repeat(30_000),
    })) as Record<string, unknown>;

    expect(out.truncated).toBe(true);
    expect(out.blob).toBeUndefined();
    expect(out.original_size_bytes).toBeGreaterThan(25 * 1024);
  });
});
