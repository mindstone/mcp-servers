/**
 * A stand-in for the Things app in tests: an executor that applies URL-scheme and trash commands to
 * a fixture database the way Things does (as measured against the real app). The writer's whole
 * check / send / verify pipeline runs against it without touching Things.
 *
 * `modals` records every alert real Things would have put in front of the user (a rejected URL
 * command: wrong token, unknown id, notes over the limit). Tests assert it stays empty.
 */
import { randomBytes } from 'node:crypto';
import type { Database } from 'sql.js';
import { isoToThingsDate, localIsoDate } from '../src/dates.js';
import { LIMITS } from '../src/encode.js';
import type { ThingsExecutor } from '../src/executor.js';
import { FIXTURE_TOKEN, mutate } from './fixture.js';

export interface SimulatorOptions {
  now: () => Date;
  /** Accept commands but do nothing, like a command Things silently drops. */
  ignoreCommands?: boolean;
  /** "Enable Things URLs" (default on). */
  urlsEnabled?: boolean;
  /** Run before each command is applied: e.g. to change the item under the writer's feet. */
  beforeApply?: (db: Database) => void;
}

const one = (db: Database, sql: string, params: (string | number | null)[] = []): Record<string, unknown> | undefined => {
  const s = db.prepare(sql);
  try {
    s.bind(params);
    return s.step() ? s.getAsObject() : undefined;
  } finally {
    s.free();
  }
};

export class ThingsSimulator implements ThingsExecutor {
  readonly calls: { kind: 'url' | 'applescript'; value: string; args?: string[] }[] = [];
  readonly modals: string[] = [];

  constructor(private readonly dbPath: string, private readonly opts: SimulatorOptions) {}

  async urlSchemeEnabled(): Promise<boolean> {
    return this.opts.urlsEnabled ?? true;
  }

  async thingsRunning(): Promise<boolean> {
    return true;
  }

  async openUrl(url: string): Promise<void> {
    this.calls.push({ kind: 'url', value: url });
    if (!(this.opts.urlsEnabled ?? true)) this.modals.push('Things URLs are disabled.');
    else await mutate(this.dbPath, (db) => {
      this.opts.beforeApply?.(db);
      if (!this.opts.ignoreCommands) this.applyUrl(db, url);
    });
  }

  /** Mirrors writer.ts TRASH_SCRIPT, including its in-call title check. */
  async appleScript(_script: string, args: string[]): Promise<string> {
    this.calls.push({ kind: 'applescript', value: 'trash', args });
    const [id, title] = args as [string, string];
    return mutate(this.dbPath, (db) => {
      this.opts.beforeApply?.(db);
      const row = one(db, `SELECT title FROM TMTask WHERE uuid = ? AND type = 0`, [id]);
      if (!row) throw new Error(`Can't get to do id "${id}"`); // an AppleScript error, not a modal
      if (row.title !== title) return 'refused: its title changed just now';
      if (!this.opts.ignoreCommands) db.run(`UPDATE TMTask SET trashed = 1 WHERE uuid = ?`, [id]);
      return 'ok';
    });
  }

  private applyUrl(db: Database, url: string): void {
    const m = /^things:\/\/\/([a-z-]+)\?(.*)$/.exec(url);
    if (!m) throw new Error(`Bad URL ${url}`);
    const params = Object.fromEntries(
      m[2]!.split('&').map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i), decodeURIComponent(kv.slice(i + 1))];
      }),
    ) as Record<string, string>;
    if (m[1] === 'json') {
      const items = JSON.parse(params.data!) as { type: string; attributes: Record<string, unknown> }[];
      if (items.some((x) => this.overLimit(x.attributes.notes as string | undefined))) return;
      for (const item of items) this.create(db, item);
      return;
    }
    if (params['auth-token'] !== FIXTURE_TOKEN) {
      this.modals.push('The provided authentication token is incorrect.');
      return;
    }
    const row = one(db, `SELECT type FROM TMTask WHERE uuid = ?`, [params.id!]);
    if (!row || (m[1] === 'update-project') !== (row.type === 1)) {
      this.modals.push(`Cannot update ${m[1] === 'update-project' ? 'project' : 'to-do'} with ID "${params.id}" because it does not exist.`);
      return;
    }
    this.update(db, params);
  }

  private create(db: Database, item: { type: string; attributes: Record<string, unknown> }): void {
    const a = item.attributes;
    const uuid = randomBytes(11).toString('hex');
    const now = this.opts.now().getTime() / 1000;
    const listId = a['list-id'] as string | undefined;
    const isArea = listId !== undefined && one(db, `SELECT 1 FROM TMArea WHERE uuid = ?`, [listId]) !== undefined;
    const [start, startDate, bucket] = this.when((a.when as string | undefined) ?? (listId ? 'anytime' : 'inbox'));
    db.run(
      `INSERT INTO TMTask (uuid, title, notes, type, status, trashed, start, startDate, startBucket, deadline, project, area,
         creationDate, userModificationDate, "index", todayIndex, todayIndexReferenceDate)
       VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [uuid, a.title as string, (a.notes as string) ?? '', start, startDate, bucket, a.deadline ? isoToThingsDate(a.deadline as string) : null,
        isArea ? null : (listId ?? null), isArea ? listId! : null, now, now, startDate],
    );
    this.addTags(db, uuid, (a.tags as string[] | undefined) ?? []);
    ((a['checklist-items'] as { attributes: { title: string } }[] | undefined) ?? []).forEach((c, i) =>
      db.run(`INSERT INTO TMChecklistItem (uuid, title, status, "index", task) VALUES (?, ?, 0, ?, ?)`, [`${uuid}-c${i}`, c.attributes.title, i, uuid]),
    );
  }

  private overLimit(notes: string | undefined): boolean {
    if ((notes?.length ?? 0) <= LIMITS.notes) return false;
    this.modals.push(`Notes are ${notes!.length} characters, over the ${LIMITS.notes} limit.`);
    return true;
  }

  private update(db: Database, p: Record<string, string>): void {
    const id = p.id!;
    const set = (col: string, v: string | number | null): void => void db.run(`UPDATE TMTask SET ${col} = ? WHERE uuid = ?`, [v, id]);
    const notes = String(one(db, `SELECT notes FROM TMTask WHERE uuid = ?`, [id])?.notes ?? '');
    const next = p['prepend-notes'] !== undefined ? `${p['prepend-notes']}\n${notes}` : p['append-notes'] !== undefined ? `${notes}\n${p['append-notes']}` : undefined;
    if (this.overLimit(next)) return;
    if (p.title !== undefined) set('title', p.title);
    if (next !== undefined) set('notes', next);
    if (p.when !== undefined) {
      const [start, startDate, bucket] = this.when(p.when);
      set('start', start);
      set('startDate', startDate);
      set('startBucket', bucket);
    }
    // Things packs dates with an 11-bit year: a later one is silently not applied (measured live).
    if (p.deadline !== undefined && !(p.deadline > '2047-12-31')) set('deadline', p.deadline ? isoToThingsDate(p.deadline) : null);
    if (p['add-tags'] !== undefined) this.addTags(db, id, p['add-tags'].split(','));
    if (p['append-checklist-items'] !== undefined) {
      p['append-checklist-items'].split('\n').forEach((title, i) =>
        db.run(`INSERT INTO TMChecklistItem (uuid, title, status, "index", task) VALUES (?, ?, 0, ?, ?)`, [`${id}-a${Date.now()}${i}`, title, 1000 + i, id]),
      );
    }
    if (p['list-id'] !== undefined) {
      if (one(db, `SELECT 1 FROM TMArea WHERE uuid = ?`, [p['list-id']])) {
        set('area', p['list-id']);
        set('project', null);
      } else {
        set('project', p['list-id']);
        set('area', null);
      }
    }
    if (p.canceled === 'true') set('status', 2);
    else if (p.completed === 'true') set('status', 3);
    else if (p.completed === 'false' || p.canceled === 'false') set('status', 0);
  }

  /** [start, startDate, startBucket] for a `when`. */
  private when(when: string): [number, number | null, number] {
    const n = this.opts.now();
    const today = localIsoDate(n);
    const tomorrow = localIsoDate(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1));
    if (when === 'inbox') return [0, null, 0];
    if (when === 'today') return [1, isoToThingsDate(today), 0];
    if (when === 'evening') return [1, isoToThingsDate(today), 1];
    if (when === 'tomorrow') return [2, isoToThingsDate(tomorrow), 0];
    if (when === 'anytime') return [1, null, 0];
    if (when === 'someday') return [2, null, 0];
    return [when <= today ? 1 : 2, isoToThingsDate(when), 0];
  }

  /** Unknown tags are dropped silently, as Things does. */
  private addTags(db: Database, id: string, titles: string[]): void {
    for (const title of titles) {
      const tag = one(db, `SELECT uuid FROM TMTag WHERE title = ?`, [title]);
      if (tag) db.run(`INSERT INTO TMTaskTag (tasks, tags) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM TMTaskTag WHERE tasks = ? AND tags = ?)`, [id, tag.uuid as string, id, tag.uuid as string]);
    }
  }
}
