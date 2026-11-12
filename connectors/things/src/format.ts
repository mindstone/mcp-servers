/**
 * What a model sees. Compact, so long lists stay affordable: only fields worth attention, ids for
 * follow-up calls, and everything the user wrote (titles, notes, checklists, tags, project and area
 * names) inside one `<untrusted-content source="things">` envelope per result. It is the user's own
 * data, but it often holds text pasted from email or the web, so it is data, never instructions.
 *
 * A result's text is a line of plain JSON metadata (counts, paging, today's date, warnings), then
 * the enveloped JSON payload.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { schemaWarning } from './db.js';
import { localIsoDate } from './dates.js';
import type { Area, Task, ThingsReader } from './reader.js';
import { wrapUntrusted } from './untrusted-content.js';

/** How much of an item's notes a list shows; `things_get_item` gives them whole. */
export const NOTES_PREVIEW = 200;

/** Where an item sits in time, in the words of Things' own lists. */
export function whenOf(t: Task, today: string): string | undefined {
  if (t.type === 'heading') return undefined;
  if (t.evening) return 'this evening';
  if (t.start_date) return t.start_date <= today ? 'today' : t.start_date;
  return t.start === 'Inbox' ? 'inbox' : t.start === 'Someday' ? 'someday' : 'anytime';
}

/** Project titles for to-dos under a heading, which carry only the heading. */
export function projectOf(r: ThingsReader, cache = new Map<string, string | undefined>()): (t: Task) => string | undefined {
  return (t) => {
    if (t.project_title || !t.heading) return t.project_title;
    if (!cache.has(t.heading)) cache.set(t.heading, r.task(t.heading)?.project_title);
    return cache.get(t.heading);
  };
}

/** One item, briefly. `full` adds whole notes, the checklist, dates and a link. */
export function brief(t: Task, today: string, project: (t: Task) => string | undefined, full = false): Record<string, unknown> {
  const notes = t.notes ?? '';
  const checklist = Array.isArray(t.checklist) ? t.checklist : [];
  const out: Record<string, unknown> = {
    id: t.uuid,
    title: t.title,
    type: t.type === 'to-do' ? undefined : t.type,
    status: t.status === 'incomplete' ? undefined : t.status,
    when: t.status === 'incomplete' ? whenOf(t, today) : undefined,
    deadline: t.deadline ?? undefined,
    reminder: t.reminder_time,
    project: project(t),
    heading: t.heading_title,
    area: t.area_title,
    tags: t.tags?.length ? t.tags : undefined,
    notes: !notes ? undefined : full || notes.length <= NOTES_PREVIEW ? notes : `${notes.slice(0, NOTES_PREVIEW)}… (${notes.length} characters; things_get_item has them all)`,
    checklist: !checklist.length
      ? t.checklist === true && !full ? 'has a checklist' : undefined
      : full
        ? checklist.map((c) => `${c.status === 'incomplete' ? '[ ]' : c.status === 'completed' ? '[x]' : '[-]'} ${c.title}`)
        : `${checklist.filter((c) => c.status !== 'incomplete').length}/${checklist.length} done`,
    repeating: t.repeating ? true : undefined,
    closed: t.status !== 'incomplete' && t.stop_date ? t.stop_date : undefined,
    in_trash: t.trashed ? true : undefined,
    ...(full && { created: t.created, modified: t.modified, link: t.things_url }),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export function briefArea(a: Area): Record<string, unknown> {
  return { id: a.uuid, title: a.title, ...(a.tags?.length && { tags: a.tags }) };
}

/** A successful result: metadata in the clear, the user's data enveloped. */
export function result(meta: Record<string, unknown>, data: unknown, r?: ThingsReader, now = new Date()): CallToolResult {
  const warning = r ? schemaWarning(r.trust) : undefined;
  const weekday = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const head = { todays_date: localIsoDate(now), weekday, ...meta, ...(warning && { warning }) };
  return { content: [{ type: 'text', text: `${JSON.stringify(head)}\n${wrapUntrusted(JSON.stringify(data), 'things')}` }] };
}

/** A failed call, as an error result the model can act on. Messages quote items only enveloped. */
export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Drop the `items` beyond one page, and say how to get the rest. */
export function page<T>(items: T[], limit: number, offset: number): { shown: T[]; meta: Record<string, unknown> } {
  const shown = items.slice(offset, offset + limit);
  const next = offset + shown.length;
  return {
    shown,
    meta: {
      total: items.length,
      ...(offset > 0 && { offset }),
      shown: shown.length,
      ...(next < items.length && { more: `${items.length - next} more: call again with offset ${next}, or narrow the request.` }),
    },
  };
}
