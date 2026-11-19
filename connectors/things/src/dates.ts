/**
 * Things stores `startDate` and `deadline` as a packed integer, bits YYYYYYYYYYYMMMMDDDDD0000000
 * (year << 16 | month << 12 | day << 7). 2021-03-28 is 132464128. `creationDate`,
 * `userModificationDate` and `stopDate` are REAL Unix seconds (UTC). Ported from things.py 0.0.15
 * `database.py`.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isoToThingsDate(iso: string): number {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new Error(`Not an ISO date (YYYY-MM-DD): ${JSON.stringify(iso)}`);
  return (Number(m[1]) << 16) | (Number(m[2]) << 12) | (Number(m[3]) << 7);
}

/** The local calendar date of `now`, as YYYY-MM-DD (SQLite's `date('now', 'localtime')`). */
export function localIsoDate(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isValidIsoDate(iso: string): boolean {
  const m = ISO_DATE.exec(iso);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * The last date Things can store: dates are packed with an 11-bit year, so a later one is silently
 * not applied (measured on a real database: a deadline of 2099 never read back).
 */
export const LAST_THINGS_DATE = '2047-12-31';

/** A real date that Things can store. */
export function isStorableDate(iso: string): boolean {
  return isValidIsoDate(iso) && iso <= LAST_THINGS_DATE;
}
