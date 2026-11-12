/**
 * Finding to-dos by words, in any order: "Peter call" finds "Call Peter about Friday", which a
 * substring search would miss. Best matches first: the whole query as (part of) the title, then
 * how many query words the title has, then how many the notes, project and area have.
 */
import type { Task, ThingsReader } from './reader.js';

/** Grammar words never say which item. */
const GRAMMAR = new Set(
  `a an the and or but of to for in on at by with from about into as is it its it's that this these those one ones
  i me my we us you your he she they them so then just now please can could would should will up out over again also all any some too there here`.split(/\s+/),
);

/**
 * One form per word, so "invoices" meets "invoice", "emailing" meets "email" and "replied" meets
 * "reply": plural endings, then -ing/-ed, then a final -e. Crude, but the same on both sides.
 */
export function normalise(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ied')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** The words of a query or an item's text, any script, without grammar words. */
export function searchWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[’']s\b/gu, '').split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || GRAMMAR.has(raw)) continue;
    out.add(normalise(raw));
  }
  return out;
}

function overlap(query: Set<string>, text: string): number {
  const have = searchWords(text);
  let n = 0;
  for (const w of query) if (have.has(w)) n++;
  return n;
}

/**
 * To-dos and projects matching `query`, best first. Items with every word (or the whole query as a
 * phrase) win; only when there are none do items with some of the words come back, `partial`.
 * Ties go to the title, then the rest of the text, then the most recently closed, then the app's order.
 */
export function rankedSearch(r: ThingsReader, query: string, includeCompleted: boolean): { items: Task[]; partial: boolean } {
  const words = searchWords(query);
  const q = query.trim().toLowerCase();
  const pool = r.tasks(includeCompleted ? { status: null } : {}).filter((t) => t.type !== 'heading');
  const scored = pool
    .map((t, i) => {
      const text = `${t.title} ${t.notes ?? ''} ${t.project_title ?? ''} ${t.area_title ?? ''}`;
      const title = overlap(words, t.title);
      const all = overlap(words, text);
      // The whole query as a phrase: in the title, or (for a query with a real word, not just "the") anywhere.
      const phrase = q === '' ? 0 : t.title.toLowerCase() === q ? 3 : t.title.toLowerCase().includes(q) ? 2 : words.size > 0 && text.toLowerCase().includes(q) ? 1 : 0;
      const every = phrase > 0 || (words.size > 0 && all === words.size);
      return { t, i, every, key: [phrase, title, all - title] as const };
    })
    .filter((x) => x.every || x.key[1] + x.key[2] > 0);
  const complete = scored.filter((x) => x.every);
  const chosen = complete.length ? complete : scored;
  chosen.sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2] || cmpDesc(a.t.stop_date, b.t.stop_date) || a.i - b.i);
  return { items: chosen.map((x) => x.t), partial: complete.length === 0 };
}

/** Most recent first; items never closed (null) after closed ones. */
function cmpDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}
