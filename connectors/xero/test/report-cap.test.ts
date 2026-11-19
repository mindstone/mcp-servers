import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MAX_REPORT_CHARS, formatReportRows } from "../src/helpers/format-report-rows.js";

describe("formatReportRows", () => {
  it("returns a report under the cap in full", () => {
    const rows = [{ rowType: "Row", cells: [{ value: "100.00" }] }];
    expect(formatReportRows(rows)).toBe(JSON.stringify(rows, null, 2));
  });

  it("cuts a report over the cap and says so", () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => ({
      rowType: "Row",
      cells: [{ value: `Account ${i}` }, { value: "1234.56" }],
    }));
    const full = JSON.stringify(rows, null, 2);
    expect(full.length).toBeGreaterThan(MAX_REPORT_CHARS);

    const text = formatReportRows(rows);

    expect(text.startsWith(full.slice(0, MAX_REPORT_CHARS))).toBe(true);
    expect(text).toContain(
      `[Report cut: showing the first 50,000 of ${full.length.toLocaleString("en-US")} characters.`,
    );
    expect(text).toContain("shorter date range or fewer periods");
    expect(text.length).toBeLessThan(MAX_REPORT_CHARS + 300);
  });

  it("treats missing rows as an empty report", () => {
    expect(formatReportRows(undefined)).toBe("[]");
  });
});

const REPORT_TOOLS = [
  "list-aged-payables-by-contact",
  "list-aged-receivables-by-contact",
  "list-bank-summary",
  "list-budget-summary",
  "list-executive-summary",
  "list-profit-and-loss",
  "list-report-balance-sheet",
  "list-trial-balance",
];

describe("report tools", () => {
  it.each(REPORT_TOOLS)("%s returns its rows through the cap", (name) => {
    const source = readFileSync(
      new URL(`../src/tools/list/${name}.tool.ts`, import.meta.url),
      "utf8",
    );
    expect(source).toContain("formatReportRows(");
    expect(source).not.toMatch(/JSON\.stringify\([^)]*rows/);
  });
});
