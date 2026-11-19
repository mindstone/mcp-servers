/** Report text past this many characters is cut, so a large report cannot swamp the AI. */
export const MAX_REPORT_CHARS = 50_000;

/** A report's rows as JSON, cut at MAX_REPORT_CHARS with the cut stated. */
export function formatReportRows(rows: unknown): string {
  const text = JSON.stringify(rows ?? [], null, 2);
  if (text.length <= MAX_REPORT_CHARS) return text;
  return (
    text.slice(0, MAX_REPORT_CHARS) +
    `\n\n[Report cut: showing the first ${MAX_REPORT_CHARS.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters. ` +
    "Ask for a shorter date range or fewer periods to see the rest.]"
  );
}
