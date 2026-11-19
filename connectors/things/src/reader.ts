/**
 * Read-only queries over the Things 3 database: a TypeScript port of the read side of the Python
 * `things.py` library (https://github.com/thingsapi/things.py, version 0.0.15, `things/api.py` and
 * `things/database.py`, MIT). Rows keep things.py's snake_case shape (`start_date`, `today_index`,
 * ...) so the two can be compared directly; ./format.ts decides what a model sees. Where this
 * deliberately differs from things.py, the comment says so. List orders were checked against the
 * app's own (AppleScript) order on a real database, Things 3.24, 2026-10.
 *
 * Differences that are improvements, not ports:
 * - Filters are bound parameters rather than string-escaped SQL.
 * - Fixed things.py bugs:
 *   - `contextTrashed: true` matched nothing (it ANDed the project and heading-project checks).
 *   - A project's `items` listed its headings' to-dos twice (flat, and under the heading).
 *   - `tag: false` works (things.py rejects it).
 *   - Sorting Today and the logbook tolerates null keys (things.py can raise TypeError).
 *   - Impossible dates such as `2026-02-30` are rejected (things.py packs them).
 * - By default `open()` reads a private snapshot rather than the live file (see db.ts).
 * - Extra fields: `evening`, `repeating` and `things_url` (see Task).
 * - `today()` puts This Evening items after the rest, as the app does; things.py ignores
 *   `startBucket`.
 * - "Today" is computed in JS from an injectable clock (`now`), so tests are deterministic. It is
 *   the same local calendar date SQLite's `date('now', 'localtime')` would give.
 */
import { isoToThingsDate, isValidIsoDate, localIsoDate } from './dates.js';
import { wrapUntrusted } from './untrusted-content.js';
import { loadDbFile, snapshotThingsDb, type Db, type Param, type SchemaTrust } from './db.js';

export type TaskType = 'to-do' | 'project' | 'heading';
export type Status = 'incomplete' | 'canceled' | 'completed';
export type Start = 'Inbox' | 'Anytime' | 'Someday';
/** `true`/`false`: has / lacks a date. `'future'`, `'past'` (includes today), or `[op]YYYY-MM-DD`. */
export type DateFilter = boolean | 'future' | 'past' | string;

export interface ChecklistItem {
  title: string;
  status: Status;
  stop_date: string | null;
  type: 'checklist-item';
  uuid: string;
  /** things.py reads this from the modification date too; ported as-is. */
  created: string | null;
  modified: string | null;
}

export interface Task {
  uuid: string;
  type: TaskType;
  trashed?: true;
  title: string;
  status: Status;
  area?: string;
  area_title?: string;
  project?: string;
  project_title?: string;
  heading?: string;
  heading_title?: string;
  notes: string | null;
  /** Tag titles. Absent when the task has none. */
  tags?: string[];
  start: Start;
  /** The items when loaded (by `task(uuid)`), else `true` meaning "has a checklist". Absent if none. */
  checklist?: ChecklistItem[] | true;
  start_date: string | null;
  deadline: string | null;
  stop_date: string | null;
  created: string | null;
  modified: string | null;
  index: number;
  today_index: number | null;
  /**
   * In the This Evening part of Today: `startBucket = 1` and starting today. An evening item whose
   * date has passed shows in the main Today list (checked against the app, 2026-10-02). Not in things.py.
   */
  evening: boolean;
  /**
   * When the item was last put into Today (`todayIndexReferenceDate`, falling back to its start
   * date or deadline). Today shows the most recent first, then by `today_index`. Not in things.py.
   */
  today_ref: string | null;
  /**
   * Part of a repeating to-do: a copy it generated, or the template itself (lists hide
   * templates, but `task(uuid)` returns them). Not in things.py.
   */
  repeating: boolean;
  /**
   * The template of a repeating to-do: the series itself, not one copy of it. Things crashes on
   * some updates to these (see ./writer.ts, `copyPatch`). Not in things.py.
   */
  repeating_template: boolean;
  /** Time of day of its reminder, `HH:MM`, on its start date. Absent if none. Not in things.py. */
  reminder_time?: string;
  /** Opens the item in Things. Not in things.py. */
  things_url: string;
}

export interface Area {
  uuid: string;
  type: 'area';
  title: string;
  tags?: string[];
}

export interface TaskFilters {
  type?: TaskType;
  /** Defaults to `'incomplete'`. Pass `null` for any status. */
  status?: Status | null;
  start?: Start;
  /** An area uuid, or `true`/`false` for has / lacks an area. */
  area?: string | boolean;
  /** A project uuid (matches tasks under the project's headings too), or `true`/`false`. */
  project?: string | boolean;
  heading?: string | boolean;
  /** A tag title, or `true`/`false` for has / lacks tags. */
  tag?: string | boolean;
  startDate?: DateFilter;
  deadline?: DateFilter;
  deadlineSuppressed?: boolean;
  /** Defaults to `false`. `null` for both. */
  trashed?: boolean | null;
  /** Whether the containing project (or heading's project) is trashed. Defaults to `false`; `null` for both. */
  contextTrashed?: boolean | null;
  /** Substring (SQL LIKE, so `%` and `_` are wildcards) of title, notes or area title. */
  search?: string;
  /** Completed or cancelled on these local calendar dates, inclusive: `['2026-10-01', '2026-10-02']`. */
  stoppedBetween?: [string, string];
  orderBy?: 'index' | 'todayIndex';
}

const TYPE_CODE: Record<TaskType, number> = { 'to-do': 0, project: 1, heading: 2 };
const STATUS_CODE: Record<Status, number> = { incomplete: 0, canceled: 2, completed: 3 };
const START_CODE: Record<Start, number> = { Inbox: 0, Anytime: 1, Someday: 2 };

/** Columns things.py drops from a row when NULL (`COLUMNS_TO_OMIT_IF_NONE`). */
const OMIT_IF_NULL = new Set(['area', 'area_title', 'checklist', 'heading', 'heading_title', 'project', 'project_title', 'trashed', 'tags', 'reminder_time']);
/** Columns things.py turns from 1 into `true` (`COLUMNS_TO_TRANSFORM_TO_BOOL`). */
const TO_BOOL = new Set(['checklist', 'tags', 'trashed']);

const DATE_FILTER = /^(=|==|<|<=|>|>=)?(\d{4}-\d{2}-\d{2})$/;

function thingsDateSql(col: string): string {
  return `CASE WHEN ${col} THEN printf('%d-%02d-%02d', (${col} & 134152192) >> 16, (${col} & 61440) >> 12, (${col} & 3968) >> 7) ELSE ${col} END`;
}

/** things.py `make_tasks_sql_query`. DISTINCT collapses the tag and checklist fan-out joins. */
function tasksSql(where: string, orderBy: string): string {
  return `
    SELECT DISTINCT
      TASK.uuid,
      CASE WHEN TASK.type = 0 THEN 'to-do' WHEN TASK.type = 1 THEN 'project' WHEN TASK.type = 2 THEN 'heading' END AS type,
      CASE WHEN TASK.trashed = 1 THEN 1 END AS trashed,
      TASK.title,
      CASE WHEN TASK.status = 0 THEN 'incomplete' WHEN TASK.status = 2 THEN 'canceled' WHEN TASK.status = 3 THEN 'completed' END AS status,
      CASE WHEN AREA.uuid IS NOT NULL THEN AREA.uuid END AS area,
      CASE WHEN AREA.uuid IS NOT NULL THEN AREA.title END AS area_title,
      CASE WHEN PROJECT.uuid IS NOT NULL THEN PROJECT.uuid END AS project,
      CASE WHEN PROJECT.uuid IS NOT NULL THEN PROJECT.title END AS project_title,
      CASE WHEN HEADING.uuid IS NOT NULL THEN HEADING.uuid END AS heading,
      CASE WHEN HEADING.uuid IS NOT NULL THEN HEADING.title END AS heading_title,
      TASK.notes,
      CASE WHEN TAG.uuid IS NOT NULL THEN 1 END AS tags,
      CASE WHEN TASK.start = 0 THEN 'Inbox' WHEN TASK.start = 1 THEN 'Anytime' WHEN TASK.start = 2 THEN 'Someday' END AS start,
      CASE WHEN CHECKLIST_ITEM.uuid IS NOT NULL THEN 1 END AS checklist,
      date(${thingsDateSql('TASK.startDate')}) AS start_date,
      date(${thingsDateSql('TASK.deadline')}) AS deadline,
      datetime(TASK.stopDate, 'unixepoch', 'localtime') AS stop_date,
      datetime(TASK.creationDate, 'unixepoch', 'localtime') AS created,
      datetime(TASK.userModificationDate, 'unixepoch', 'localtime') AS modified,
      TASK."index",
      TASK.todayIndex AS today_index,
      CASE WHEN TASK.startBucket = 1 THEN 1 ELSE 0 END AS evening,
      date(${thingsDateSql('COALESCE(TASK.todayIndexReferenceDate, TASK.startDate, TASK.deadline)')}) AS today_ref,
      CASE WHEN TASK.rt1_repeatingTemplate IS NOT NULL OR TASK.rt1_recurrenceRule IS NOT NULL THEN 1 ELSE 0 END AS repeating,
      CASE WHEN TASK.rt1_recurrenceRule IS NOT NULL THEN 1 ELSE 0 END AS repeating_template,
      CASE WHEN TASK.reminderTime IS NOT NULL
        THEN printf('%02d:%02d', TASK.reminderTime >> 26, (TASK.reminderTime >> 20) & 63) END AS reminder_time
    FROM TMTask AS TASK
    LEFT OUTER JOIN TMTask PROJECT ON TASK.project = PROJECT.uuid
    LEFT OUTER JOIN TMArea AREA ON TASK.area = AREA.uuid
    LEFT OUTER JOIN TMTask HEADING ON TASK.heading = HEADING.uuid
    LEFT OUTER JOIN TMTask PROJECT_OF_HEADING ON HEADING.project = PROJECT_OF_HEADING.uuid
    LEFT OUTER JOIN TMTaskTag TAGS ON TASK.uuid = TAGS.tasks
    LEFT OUTER JOIN TMTag TAG ON TAGS.tags = TAG.uuid
    LEFT OUTER JOIN TMChecklistItem CHECKLIST_ITEM ON TASK.uuid = CHECKLIST_ITEM.task
    WHERE ${where}
    ORDER BY ${orderBy}`;
}

/** Our fields beyond things.py's: 0/1 to booleans, and the Things link. */
function withExtras(t: Task, todayIso: string): Task {
  t.evening = (t.evening as unknown) === 1 && t.start_date === todayIso;
  t.repeating = (t.repeating as unknown) === 1;
  t.repeating_template = (t.repeating_template as unknown) === 1;
  t.things_url = `things:///show?id=${t.uuid}`;
  return t;
}

/** Turn a raw row into things.py's dict shape (`dict_factory`). */
function shapeRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null && OMIT_IF_NULL.has(key)) continue;
    out[key] = value && TO_BOOL.has(key) ? true : value;
  }
  return out as T;
}

/** Builds a WHERE clause from `AND`-ed fragments and their bound parameters. */
class Where {
  readonly parts: string[] = [];
  readonly params: Param[] = [];

  add(sql: string, ...params: Param[]): void {
    this.parts.push(sql);
    this.params.push(...params);
  }

  /** things.py `make_filter`: `true` is IS NOT NULL, `false` is IS NULL, anything else is equality. */
  eq(col: string, value: string | boolean | undefined): void {
    if (value === undefined) return;
    if (value === true) this.add(`${col} IS NOT NULL`);
    else if (value === false) this.add(`${col} IS NULL`);
    else this.add(`${col} = ?`, value);
  }

  /** things.py `make_truthy_filter`. */
  truthy(col: string, value: boolean | null): void {
    if (value === null) return;
    this.add(value ? `${col}` : `NOT IFNULL(${col}, 0)`);
  }

  toSql(): string {
    return this.parts.length ? this.parts.join(' AND ') : 'TRUE';
  }
}

function parseDateFilter(name: string, value: string): { op: string; iso: string } {
  const m = DATE_FILTER.exec(value);
  if (!m || !isValidIsoDate(m[2]!)) {
    throw new Error(`Invalid ${name} filter: ${JSON.stringify(value)}. Use true, false, 'future', 'past' or '[op]YYYY-MM-DD'.`);
  }
  return { op: m[1] ?? '==', iso: m[2]! };
}

export interface ThingsReaderOptions {
  /** Clock used for "today", "future" and "past". Defaults to the real time. */
  now?: () => Date;
}

/**
 * Read-only access to a Things database. Each statement runs in its own short read transaction,
 * so this never holds a lock that would stop Things checkpointing its WAL.
 */
export class ThingsReader {
  private readonly now: () => Date;

  private constructor(
    private readonly db: Db,
    opts: ThingsReaderOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * The default: a fresh in-memory snapshot of the live database (or `THINGSDB`); see ./db.ts.
   * Call `close()` when done.
   */
  static async open(opts: ThingsReaderOptions & { source?: string } = {}): Promise<ThingsReader> {
    return new ThingsReader(await snapshotThingsDb(opts.source), opts);
  }

  /** Read a database file (a fixture or a copy) into memory; the file itself is only read. */
  static async openFile(path: string, opts: ThingsReaderOptions = {}): Promise<ThingsReader> {
    return new ThingsReader(await loadDbFile(path), opts);
  }

  /** Whether the database's schema version is one this code was checked against (./db.ts). */
  get trust(): SchemaTrust {
    return this.db.trust;
  }

  close(): void {
    this.db.close();
  }

  private all<T>(sql: string, params: Param[] = []): T[] {
    return this.db.all(sql, params).map((r) => shapeRow<T>(r));
  }

  private todayIso(): string {
    return localIsoDate(this.now());
  }

  private thingsDateFilter(w: Where, col: string, name: string, value: DateFilter | undefined): void {
    if (value === undefined) return;
    if (typeof value === 'boolean') return w.eq(col, value);
    if (value === 'future' || value === 'past') {
      return w.add(`${col} ${value === 'future' ? '>' : '<='} ?`, isoToThingsDate(this.todayIso()));
    }
    const { op, iso } = parseDateFilter(name, value);
    w.add(`${col} ${op} ?`, isoToThingsDate(iso));
  }

  /** things.py `tasks()`. Incomplete, untrashed, non-repeating-template tasks by default. */
  tasks(f: TaskFilters = {}): Task[] {
    if (f.tag !== undefined && typeof f.tag === 'string' && !this.tagTitles().includes(f.tag)) {
      throw new Error(`There is no tag "${wrapUntrusted(f.tag, 'things')}" in Things.`);
    }
    const status = f.status === undefined ? 'incomplete' : f.status;
    const trashed = f.trashed === undefined ? false : f.trashed;
    const contextTrashed = f.contextTrashed === undefined ? false : f.contextTrashed;

    const w = new Where();
    w.add('TASK.rt1_recurrenceRule IS NULL');
    if (trashed !== null) w.add('TASK.trashed = ?', trashed ? 1 : 0);
    // Deliberate fix: things.py ANDs these two for `true` too, which no task can satisfy.
    if (contextTrashed === true) w.add('(IFNULL(PROJECT.trashed, 0) OR IFNULL(PROJECT_OF_HEADING.trashed, 0))');
    else if (contextTrashed === false) {
      w.truthy('PROJECT.trashed', false);
      w.truthy('PROJECT_OF_HEADING.trashed', false);
    }
    if (f.type) w.add('TASK.type = ?', TYPE_CODE[f.type]);
    if (f.start) w.add('TASK.start = ?', START_CODE[f.start]);
    if (status) w.add('TASK.status = ?', STATUS_CODE[status]);
    w.eq('TASK.area', f.area);
    if (f.project !== undefined) {
      // A task under a heading is not itself assigned to the project, so match the heading's project too.
      const p = new Where();
      p.eq('TASK.project', f.project);
      p.eq('PROJECT_OF_HEADING.uuid', f.project);
      w.add(`(${p.parts.join(' OR ')})`, ...p.params);
    }
    w.eq('TASK.heading', f.heading);
    w.eq('TASK.deadlineSuppressionDate', f.deadlineSuppressed);
    w.eq('TAG.title', f.tag);
    this.thingsDateFilter(w, 'TASK.startDate', 'startDate', f.startDate);
    this.thingsDateFilter(w, 'TASK.deadline', 'deadline', f.deadline);
    if (f.stoppedBetween) {
      const [from, to] = f.stoppedBetween;
      for (const d of [from, to]) if (!isValidIsoDate(d)) throw new Error(`Invalid stoppedBetween date: ${JSON.stringify(d)}`);
      w.add(`date(TASK.stopDate, 'unixepoch', 'localtime') BETWEEN ? AND ?`, from, to);
    }
    if (f.search) {
      const like = `%${f.search}%`;
      w.add(`(TASK.title LIKE ? OR TASK.notes LIKE ? OR AREA.title LIKE ?)`, like, like, like);
    }

    const order = f.orderBy === 'todayIndex' ? 'TASK.todayIndex' : 'TASK."index"';
    const rows = this.all<Task>(tasksSql(w.toSql(), order), w.params).map((t) => withExtras(t, this.todayIso()));
    for (const t of rows) if (t.tags) t.tags = this.tagsOfTask(t.uuid);
    return rows;
  }

  /** One task by uuid, whatever its status or trash state, with its tags and checklist loaded. Undefined if missing. */
  task(uuid: string): Task | undefined {
    const [t] = this.all<Task>(tasksSql('TASK.uuid = ?', 'TASK."index"'), [uuid]).map((t) => withExtras(t, this.todayIso()));
    if (t?.tags) t.tags = this.tagsOfTask(t.uuid);
    if (t?.checklist) t.checklist = this.checklistItems(t.uuid);
    return t;
  }

  /**
   * When each item was made, as Unix seconds: the real instant, which `created` (a local-time
   * string without an offset, as things.py gives it) is not. Not in things.py.
   */
  createdAt(uuids: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (let i = 0; i < uuids.length; i += 500) {
      const some = uuids.slice(i, i + 500);
      for (const r of this.db.all(`SELECT uuid, creationDate FROM TMTask WHERE uuid IN (${some.map(() => '?').join(', ')})`, some)) {
        if (typeof r.creationDate === 'number') out.set(r.uuid as string, r.creationDate);
      }
    }
    return out;
  }

  // --- Sidebar lists, as in things.py ---

  inbox(f: TaskFilters = {}): Task[] {
    return this.tasks({ ...f, start: 'Inbox' });
  }

  /**
   * What Today would show if Things were opened now, in the app's order: the main list, then This
   * Evening; within each, the most recently added-to-Today first (`today_ref`), then `today_index`.
   * Checked against the app's own order (AppleScript `to dos of list "Today"`) on 2026-10-02: all 83
   * items matched. Approximate for items the app hasn't yet promoted (yellow dots, newly overdue
   * deadlines): the live data had none, so their position is unverified.
   *
   * The database only updates Today when the app runs, so like things.py this adds the "yellow dot"
   * predictions: scheduled to-dos whose start date has arrived, and overdue deadlines. Repeating
   * to-dos are not predicted. `includeDone` adds what the app still shows after you tick it off:
   * items completed or cancelled today that the logbook hasn't swept up yet.
   */
  today(f: TaskFilters & { includeDone?: boolean } = {}): Task[] {
    const { includeDone, ...rest } = f;
    const regular = this.tasks({ ...rest, startDate: true, start: 'Anytime', orderBy: 'todayIndex' });
    const unconfirmedScheduled = this.tasks({ ...rest, startDate: 'past', start: 'Someday', orderBy: 'todayIndex' });
    const unconfirmedOverdue = this.tasks({ ...rest, startDate: false, deadline: 'past', deadlineSuppressed: false });
    const today = this.todayIso();
    const done = includeDone
      ? this.tasks({ ...rest, status: null, startDate: true, start: 'Anytime', stoppedBetween: [today, today] }).filter(
          (t) => t.status !== 'incomplete',
        )
      : [];
    return [...done, ...regular, ...unconfirmedScheduled, ...unconfirmedOverdue].sort(
      (a, b) =>
        Number(a.evening) - Number(b.evening) ||
        -cmp(a.today_ref, b.today_ref) ||
        cmp(a.today_index, b.today_index) ||
        cmp(a.start_date, b.start_date),
    );
  }

  /** Scheduled for after today, optionally only up to `until` (YYYY-MM-DD, inclusive). */
  upcoming(f: TaskFilters & { until?: string } = {}): Task[] {
    const { until, ...rest } = f;
    if (until !== undefined && !isValidIsoDate(until)) throw new Error(`Invalid until date: ${JSON.stringify(until)}`);
    // Soonest first, as the app shows it; the user's own order within a day. (things.py leaves it in index order.)
    const all = stableSortBy(this.tasks({ ...rest, startDate: 'future', start: 'Someday' }), (t) => t.start_date, 'asc');
    return until === undefined ? all : all.filter((t) => t.start_date !== null && t.start_date <= until);
  }

  /**
   * To-dos and projects completed on these local calendar dates (inclusive), most recent first.
   * `includeCanceled` adds cancelled ones, as the logbook shows them.
   */
  completedBetween(fromIso: string, toIso: string, f: TaskFilters & { includeCanceled?: boolean } = {}): Task[] {
    const { includeCanceled, ...rest } = f;
    const done = this.tasks({ ...rest, status: includeCanceled ? null : 'completed', stoppedBetween: [fromIso, toIso] });
    return stableSortBy(done.filter((t) => t.status !== 'incomplete'), (t) => t.stop_date, 'desc');
  }

  anytime(f: TaskFilters = {}): Task[] {
    return this.tasks({ ...f, start: 'Anytime' });
  }

  someday(f: TaskFilters = {}): Task[] {
    return this.tasks({ ...f, startDate: false, start: 'Someday' });
  }

  deadlines(f: TaskFilters = {}): Task[] {
    return stableSortBy(this.tasks({ ...f, deadline: true }), (t) => t.deadline, 'asc');
  }

  todos(f: TaskFilters = {}): Task[] {
    return this.tasks({ ...f, type: 'to-do' });
  }

  projects(f: TaskFilters = {}): Task[] {
    return this.tasks({ ...f, type: 'project' });
  }

  // --- Finding projects and areas by name, and their contents ---

  /**
   * A project by uuid, or by name: an exact (case-insensitive) title wins, otherwise a single
   * substring match. Open, untrashed projects only, unless found by uuid. Throws, listing the
   * candidates, when nothing or more than one thing matches, rather than guessing.
   */
  resolveProject(nameOrUuid: string): Task {
    const byId = this.task(nameOrUuid);
    if (byId) {
      if (byId.type !== 'project') throw new Error(`${nameOrUuid} is a ${byId.type}, not a project.`);
      return byId;
    }
    return pickByName('project', nameOrUuid, this.projects());
  }

  /** An area by uuid or name, by the same rules as `resolveProject`. */
  resolveArea(nameOrUuid: string): Area {
    const all = this.areas();
    return all.find((a) => a.uuid === nameOrUuid) ?? pickByName('area', nameOrUuid, all);
  }

  /**
   * Everything in a project, as the project view lays it out: to-dos without a heading, then each
   * heading with its to-dos. Within each, in the app's order (`projectViewOrder`); headings by
   * `index`, which is unverified (not yet checked against a project with headings). Open items only
   * unless `status` says otherwise. Repeating templates, which the app also lists, are left out.
   */
  projectContents(nameOrUuid: string, opts: { status?: Status | null } = {}): ProjectContents {
    const project = this.resolveProject(nameOrUuid);
    const status = opts.status === undefined ? 'incomplete' : opts.status;
    const children = this.tasks({ project: project.uuid, status, contextTrashed: null });
    return {
      project,
      todos: projectViewOrder(children.filter((t) => t.type === 'to-do' && !t.heading)),
      headings: this.tasks({ project: project.uuid, type: 'heading', status: null, contextTrashed: null }).map((heading) => ({
        heading,
        todos: projectViewOrder(children.filter((t) => t.heading === heading.uuid)),
      })),
    };
  }

  /**
   * The URL-scheme auth token Things stores in its settings, needed for updates. A secret: never log
   * it. Undefined if URL updates are not enabled in Things.
   */
  urlSchemeToken(): string | undefined {
    const [row] = this.db.all(`SELECT uriSchemeAuthenticationToken AS t FROM TMSettings LIMIT 1`);
    return typeof row?.t === 'string' && row.t ? row.t : undefined;
  }

  // --- Areas, tags, checklists ---

  areas(opts: { tag?: string | boolean | undefined } = {}): Area[] {
    if (typeof opts.tag === 'string' && !this.tagTitles().includes(opts.tag)) {
      throw new Error(`There is no tag "${wrapUntrusted(opts.tag, 'things')}" in Things.`);
    }
    const w = new Where();
    w.eq('TAG.title', opts.tag);
    const areas = this.all<Area>(
      `SELECT DISTINCT AREA.uuid, 'area' AS type, AREA.title,
         CASE WHEN AREA_TAG.areas IS NOT NULL THEN 1 END AS tags
       FROM TMArea AS AREA
       LEFT OUTER JOIN TMAreaTag AREA_TAG ON AREA_TAG.areas = AREA.uuid
       LEFT OUTER JOIN TMTag TAG ON TAG.uuid = AREA_TAG.tags
       WHERE ${w.toSql()}
       ORDER BY AREA."index"`,
      w.params,
    );
    for (const a of areas) {
      if (a.tags) a.tags = this.db.all(
        `SELECT TAG.title FROM TMAreaTag AS AREA_TAG LEFT OUTER JOIN TMTag TAG ON TAG.uuid = AREA_TAG.tags
         WHERE AREA_TAG.areas = ? ORDER BY TAG."index"`,
        [a.uuid],
      ).map((r) => r.title as string);
    }
    return areas;
  }

  tagTitles(): string[] {
    return this.db.all(`SELECT title FROM TMTag ORDER BY "index"`).map((r) => r.title as string);
  }

  tagsOfTask(uuid: string): string[] {
    return this.db
      .all(
        `SELECT TAG.title FROM TMTaskTag AS TASK_TAG LEFT OUTER JOIN TMTag TAG ON TAG.uuid = TASK_TAG.tags
         WHERE TASK_TAG.tasks = ? ORDER BY TAG."index"`,
        [uuid],
      )
      .map((r) => r.title as string);
  }

  checklistItems(todoUuid: string): ChecklistItem[] {
    return this.all<ChecklistItem>(
      `SELECT
         title,
         CASE WHEN status = 0 THEN 'incomplete' WHEN status = 2 THEN 'canceled' WHEN status = 3 THEN 'completed' END AS status,
         date(stopDate, 'unixepoch', 'localtime') AS stop_date,
         'checklist-item' AS type,
         uuid,
         datetime(userModificationDate, 'unixepoch', 'localtime') AS created,
         datetime(userModificationDate, 'unixepoch', 'localtime') AS modified
       FROM TMChecklistItem WHERE task = ? ORDER BY "index"`,
      [todoUuid],
    );
  }
}

export interface ProjectContents {
  project: Task;
  /** To-dos directly in the project, not under a heading. */
  todos: Task[];
  headings: { heading: Task; todos: Task[] }[];
}

/**
 * The order a project (or heading) shows its to-dos in: Anytime items by `index`, then scheduled
 * ones by start date, then Someday ones by `index`. Checked against the app (AppleScript `to dos
 * of project`) on 2026-10-02.
 */
export function projectViewOrder(todos: Task[]): Task[] {
  const section = (t: Task): number => (t.start !== 'Someday' ? 0 : t.start_date ? 1 : 2);
  return [...todos].sort(
    (a, b) =>
      section(a) - section(b) ||
      (section(a) === 1 ? cmp(a.start_date, b.start_date) : 0) ||
      cmp(a.index, b.index),
  );
}

function pickByName<T extends { title: string; uuid: string }>(kind: string, name: string, all: T[]): T {
  const needle = name.trim().toLowerCase();
  if (!needle) throw new Error(`No ${kind} name given.`);
  const exact = all.filter((x) => x.title.trim().toLowerCase() === needle);
  const matches = exact.length ? exact : all.filter((x) => x.title.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0]!;
  // Titles are the user's data: quoted only inside an untrusted-content envelope.
  const q = (s: string): string => wrapUntrusted(s, 'things') ?? '';
  const list = (xs: T[]): string => xs.map((x) => `"${q(x.title)}" (id ${x.uuid})`).join(', ');
  if (matches.length === 0) throw new Error(`No open ${kind} matches "${q(name)}". things_get_overview lists them.`);
  throw new Error(`"${q(name)}" matches ${matches.length} ${kind}s: ${list(matches)}. Use a full title or an id.`);
}

/** Ascending compare with nulls first (things.py would raise on a None/str tie; we don't). */
function cmp(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function stableSortBy<T>(xs: T[], key: (x: T) => string | number | null, dir: 'asc' | 'desc'): T[] {
  return [...xs].sort((a, b) => (dir === 'asc' ? 1 : -1) * cmp(key(a), key(b)));
}
