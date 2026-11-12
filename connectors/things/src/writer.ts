/**
 * Changing Things, safely. Every change goes through the running Things app (its URL scheme, and
 * AppleScript for the Trash), never through SQL. Each one, holding a lock shared across processes
 * (./lock.ts), runs in three steps:
 *
 *   1. check: the request against a fresh snapshot of the database. Anything Things would reject
 *      is refused here, because a rejected URL command pops up an alert in front of the user (an
 *      unknown id, a wrong token, URLs switched off). Refused means nothing was sent.
 *   2. send: through the executor (./executor.ts), the only code that touches Things.
 *   3. verify: read fresh snapshots until the exact expected state reads back.
 *
 * The result is a receipt: `confirmed` with the item as it now reads, or `unconfirmed` (sent, but
 * not seen within the time allowed: re-read before retrying, since an append retried appends
 * twice). Updates also return the item as it was `before`, so a person can put it back.
 *
 * Rules that hold for every change (each one learned on a real database; the tests name them):
 * - The item is a to-do (a project, for status only), exists, is not in the Trash (itself or via
 *   its project), is not the template of a repeating to-do, and is not inside a repeating project.
 * - `expectTitle` (the title the caller last read) must match, so a wrong or stale id never changes
 *   the wrong item. Trash checks it again inside the AppleScript that deletes.
 * - Nothing is lost silently: notes are appended or prepended, never replaced; tags are only added;
 *   unknown tags are refused (Things would drop them without a word); a to-do is never moved out
 *   from under a heading (that can't be undone from here); text over Things' limits is refused,
 *   never cut.
 * - One copy of a repeating to-do takes only the changes measured safe on one (`copyPatch`).
 * - A closed item is reopened before it is scheduled or moved; nothing goes into a closed or
 *   repeating project; a project with open to-dos isn't completed (Things ignores that).
 * - The auth token is the one Things stores, read fresh each time; it never appears in a result,
 *   an error or a log line.
 */
import { isStorableDate, LAST_THINGS_DATE, localIsoDate } from './dates.js';
import { findThingsDbPath, SetupError } from './db.js';
import { LIMITS, redact, thingsUrl, type When } from './encode.js';
import { macExecutor, type ThingsExecutor } from './executor.js';
import { withLock, type LockOptions } from './lock.js';
import { ThingsReader, type Status, type Task } from './reader.js';
import { wrapUntrusted } from './untrusted-content.js';

export interface NewTodo {
  title: string;
  notes?: string;
  when?: When;
  /** YYYY-MM-DD */
  deadline?: string;
  /** Existing tag titles. */
  tags?: string[];
  checklist?: string[];
  projectId?: string;
  areaId?: string;
}

export interface TodoPatch {
  title?: string;
  prependNotes?: string;
  appendNotes?: string;
  when?: When;
  /** YYYY-MM-DD, or null to clear. */
  deadline?: string | null;
  addTags?: string[];
  appendChecklist?: string[];
  projectId?: string;
  areaId?: string;
}

export type Receipt =
  | { outcome: 'confirmed'; item: Task; before?: Task }
  | { outcome: 'unconfirmed'; reason: string; before?: Task };

export type AddReceipt =
  | (Extract<Receipt, { outcome: 'confirmed' }> & { created: true })
  | { outcome: 'existing'; item: Task }
  | (Extract<Receipt, { outcome: 'unconfirmed' }> & { created: 'unknown' });

export interface ThingsWriterOptions {
  /** Fresh read access for each check and poll. Defaults to a snapshot of the live database. */
  openReader?: () => Promise<ThingsReader>;
  executor?: ThingsExecutor;
  /** What the cross-process lock is keyed on. Defaults to the live database's path. */
  lockKey?: () => string;
  lock?: LockOptions;
  /** How long to wait for a change to show in the database. */
  timeoutMs?: number;
  pollMs?: number;
  now?: () => Date;
}

/** An item's text, marked as data, for messages that quote it. */
const quoted = (text: string): string => wrapUntrusted(text, 'things') ?? '';

/**
 * Trash one to-do, re-checking its title inside the same AppleScript call that deletes it, so it
 * can't change in between. Things' Trash keeps it until the user empties the Trash.
 */
const TRASH_SCRIPT = `on run argv
  set theId to item 1 of argv
  set theTitle to item 2 of argv
  tell application "Things3"
    set t to to do id theId
    if (name of t) is not theTitle then return "refused: its title changed just now"
    try
      delete t
    on error
      move t to list "Trash"
    end try
    return "ok"
  end tell
end run`;

export class ThingsWriter {
  private readonly openReader: () => Promise<ThingsReader>;
  private readonly executor: ThingsExecutor;
  private readonly lockKey: () => string;
  private readonly lockOptions: LockOptions;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly now: () => Date;

  constructor(opts: ThingsWriterOptions = {}) {
    this.openReader = opts.openReader ?? (() => ThingsReader.open());
    this.executor = opts.executor ?? macExecutor;
    this.lockKey = opts.lockKey ?? (() => findThingsDbPath());
    this.lockOptions = opts.lock ?? {};
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.pollMs = opts.pollMs ?? 300;
    this.now = opts.now ?? (() => new Date());
  }

  todayIso(): string {
    return localIsoDate(this.now());
  }

  // --- Add ---

  /**
   * Add a to-do, unless an open one already has this title (a retried call, most often); then that
   * one comes back as `existing`. `allowDuplicate` adds a second one anyway.
   */
  addTodo(input: NewTodo, opts: { allowDuplicate?: boolean } = {}): Promise<AddReceipt> {
    return this.locked(async () => {
      checkNewTodo(input);
      const key = sameTitle(input.title);
      let before = new Set<string>();
      const existing = await this.withReader((r) => {
        this.writableDb(r);
        checkTagsExist(r, input.tags ?? []);
        openContainer(r, input);
        before = new Set(sameTitled(r, input.title).map((t) => t.uuid));
        return r.tasks({ type: 'to-do', status: 'incomplete', trashed: null, contextTrashed: null })
          .find((t) => !inTrash(r, t) && sameTitle(t.title) === key);
      });
      if (existing && !opts.allowDuplicate) return { outcome: 'existing', item: existing };

      const attributes = {
        title: input.title,
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.when && { when: input.when }),
        ...(input.deadline && { deadline: input.deadline }),
        ...(input.tags?.length && { tags: input.tags }),
        ...(input.checklist?.length && { 'checklist-items': input.checklist.map((title) => ({ type: 'checklist-item', attributes: { title } })) }),
        ...((input.projectId ?? input.areaId) && { 'list-id': input.projectId ?? input.areaId }),
      };
      const url = thingsUrl('json', { data: JSON.stringify([{ type: 'to-do', attributes }]) });
      // Creation times are stored in whole-ish seconds and the clock may lag a little: allow 2 s.
      const sentAt = this.now().getTime() / 1000 - 2;
      await this.sendUrl(url);
      const today = this.todayIso();
      const found = await this.poll((r) => {
        const fresh = sameTitled(r, input.title).filter((t) => !before.has(t.uuid));
        const created = r.createdAt(fresh.map((t) => t.uuid));
        const matching = fresh
          .map((t) => r.task(t.uuid)!)
          .filter((t) => (created.get(t.uuid) ?? 0) >= sentAt && newTodoProblems(t, input, today).length === 0);
        if (matching.length > 1) {
          return { stop: `Sent, but ${matching.length} matching to-dos appeared at once, so which one is new can't be told. Look for "${quoted(input.title)}" in Things before adding again.` };
        }
        return matching[0] ? { item: matching[0] } : { waiting: fresh.length ? newTodoProblems(r.task(fresh[0]!.uuid)!, input, today) : ['not created yet'] };
      });
      return found.outcome === 'confirmed' ? { ...found, created: true } : { ...found, created: 'unknown' };
    });
  }

  // --- Update ---

  updateTodo(uuid: string, given: TodoPatch, expectTitle: string): Promise<Receipt> {
    return this.locked(async () => {
      checkPatch(given);
      let patch = given;
      let before!: Task;
      let token!: string;
      await this.withReader((r) => {
        this.writableDb(r);
        before = writable(r, uuid, 'to-do');
        checkTitle(before, expectTitle);
        // Clearing a deadline that isn't there changes nothing; models send `deadline: null` to mean
        // "not given", and refusing it would block the move it came with.
        if (patch.deadline === null && !before.deadline) {
          const { deadline: _none, ...rest } = patch;
          if (Object.keys(rest).length === 0) throw new Error(`"${quoted(before.title)}" has no deadline, so there was nothing to clear. Nothing was changed.`);
          patch = rest;
        }
        if (before.repeating) patch = copyPatch(before, patch, this.todayIso());
        if ((patch.projectId !== undefined || patch.areaId !== undefined) && before.heading) {
          throw new Error(`"${quoted(before.title)}" is under a heading in its project, and moving it would lose that. Move it in Things instead. Nothing was changed.`);
        }
        const moving = patch.when !== undefined || patch.deadline !== undefined || patch.projectId !== undefined || patch.areaId !== undefined || patch.appendChecklist !== undefined;
        if (before.status !== 'incomplete' && moving) {
          throw new Error(`"${quoted(before.title)}" is ${before.status}. Reopen it first (things_set_status with "incomplete"), then schedule or move it. Nothing was changed.`);
        }
        checkTagsExist(r, patch.addTags ?? []);
        openContainer(r, patch);
        token = urlToken(r);
      });
      const expected = expectedAfter(before, patch, this.todayIso());
      if (typeof expected.notes === 'string' && expected.notes.length > LIMITS.notes) {
        throw new Error(`The notes would be ${expected.notes.length} characters, over Things' limit of ${LIMITS.notes}. Nothing was changed; shorten what you add.`);
      }
      const url = thingsUrl('update', {
        'auth-token': token,
        id: uuid,
        title: patch.title,
        'prepend-notes': patch.prependNotes,
        'append-notes': patch.appendNotes,
        when: patch.when,
        deadline: patch.deadline === undefined ? undefined : (patch.deadline ?? ''),
        'add-tags': patch.addTags?.join(','),
        'append-checklist-items': patch.appendChecklist?.join('\n'),
        'list-id': patch.projectId ?? patch.areaId,
      });
      await this.sendUrl(url, token);
      return { ...(await this.waitFor(uuid, (t) => differences(t, expected))), before };
    });
  }

  /** Complete, cancel or reopen a to-do, or a project. Asking for the state it is in already changes nothing. */
  setStatus(uuid: string, status: Status, expectTitle: string): Promise<Receipt & { unchanged?: true }> {
    return this.locked(async () => {
      let before!: Task;
      let token!: string;
      let unchanged = false;
      await this.withReader((r) => {
        this.writableDb(r);
        before = writable(r, uuid);
        checkTitle(before, expectTitle);
        if (before.status === status) {
          unchanged = true;
          return;
        }
        if (before.repeating && (before.type !== 'to-do' || before.status !== 'incomplete')) {
          throw new Error(`"${quoted(before.title)}" is one copy of a repeating ${before.type}; from here a copy can only be completed or cancelled while it is open. Change it in Things instead. Nothing was changed.`);
        }
        if (before.type === 'project' && status !== 'incomplete') {
          const open = r.tasks({ project: uuid, status: 'incomplete', contextTrashed: null });
          if (open.length) throw new Error(`Things ignores closing a project with open to-dos, and "${quoted(before.title)}" has ${open.length}. Complete or move them first. Nothing was changed.`);
        }
        token = urlToken(r);
      });
      if (unchanged) return { outcome: 'confirmed', item: before, unchanged: true };
      const reopening = status === 'incomplete';
      const url = thingsUrl(before.type === 'project' ? 'update-project' : 'update', {
        'auth-token': token,
        id: uuid,
        completed: status === 'completed' ? 'true' : reopening ? 'false' : undefined,
        canceled: status === 'canceled' ? 'true' : reopening && before.status === 'canceled' ? 'false' : undefined,
      });
      await this.sendUrl(url, token);
      return { ...(await this.waitFor(uuid, (t) => (t.status === status ? [] : [`status is ${t.status}`]))), before };
    });
  }

  // --- Trash ---

  /** Move a to-do to Things' Trash (the user can put it back from there until they empty it). */
  trash(uuid: string, expectTitle: string): Promise<Receipt & { unchanged?: true }> {
    return this.locked(async () => {
      let before!: Task;
      let already = false;
      await this.withReader((r) => {
        this.writableDb(r);
        const t = r.task(uuid);
        if (t?.type === 'to-do' && t.trashed) {
          checkTitle(t, expectTitle);
          before = t;
          already = true;
          return;
        }
        before = writable(r, uuid, 'to-do');
        checkTitle(before, expectTitle);
        if (before.repeating && before.status !== 'incomplete') {
          throw new Error(`"${quoted(before.title)}" is a closed copy of a repeating to-do; trash it in Things instead. Nothing was changed.`);
        }
      });
      if (already) return { outcome: 'confirmed', item: before, unchanged: true };
      const out = await this.executor.appleScript(TRASH_SCRIPT, [uuid, before.title]);
      if (out !== 'ok') throw new Error(`Things refused to trash it (${out}). Nothing was changed; re-read it and check it's the right one.`);
      return { ...(await this.waitFor(uuid, (t) => (t.trashed ? [] : ['not in the Trash yet']))), before };
    });
  }

  // --- Running and verifying ---

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(this.lockKey(), fn, this.lockOptions);
  }

  private async withReader<T>(fn: (r: ThingsReader) => T): Promise<T> {
    const r = await this.openReader();
    try {
      return fn(r);
    } finally {
      r.close();
    }
  }

  /** Writes only on a schema this code was checked against: a newer one might mean something else. */
  private writableDb(r: ThingsReader): void {
    if (r.trust.kind !== 'ok') {
      throw new SetupError(`This Things database is version ${r.trust.version}, newer than this server was checked against, so changes are refused until the server is updated. Reading still works.`);
    }
  }

  /** Send a URL command, once Things is sure to accept URL commands at all (else it shows an alert). */
  private async sendUrl(url: string, token?: string): Promise<void> {
    if (!(await this.executor.urlSchemeEnabled())) {
      throw new SetupError('"Enable Things URLs" is off in Things > Settings > General, so Things would show an alert. Turn it on, then retry. Nothing was changed.');
    }
    try {
      await this.executor.openUrl(url);
    } catch (e) {
      // A failed `open` quotes its whole command, token included.
      throw new Error(`Could not send the change to Things (${redact(String((e as Error).message ?? e), token)}). It probably wasn't made; re-read the item to check before retrying.`);
    }
  }

  private waitFor(uuid: string, problems: (t: Task) => string[]): Promise<Receipt> {
    return this.poll((r) => {
      const t = r.task(uuid);
      if (!t) return { waiting: ['missing'] };
      const p = problems(t);
      return p.length ? { waiting: p } : { item: t };
    });
  }

  /** Re-read fresh snapshots until `check` finds the item; `unconfirmed` on `stop` or timeout. */
  private async poll(check: (r: ThingsReader) => { item: Task } | { waiting: string[] } | { stop: string }): Promise<Receipt> {
    // A command to a Things that was closed waits for it to start: allow longer.
    const timeoutMs = (await this.executor.thingsRunning()) ? this.timeoutMs : this.timeoutMs * 3;
    const started = Date.now();
    let last: string[] = [];
    for (;;) {
      const res = await this.withReader(check);
      if ('item' in res) return { outcome: 'confirmed', item: res.item };
      if ('stop' in res) return { outcome: 'unconfirmed', reason: res.stop };
      last = res.waiting;
      if (Date.now() - started > timeoutMs) {
        return {
          outcome: 'unconfirmed',
          reason: `Sent to Things, but the change hadn't shown up after ${Math.round(timeoutMs / 1000)} s (${last.join('; ')}). Re-read the item before retrying: it may still arrive, and a retried append would append twice.`,
        };
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }
}

// --- Checks ---

function checkNewTodo(t: NewTodo): void {
  checkTitleText(t.title, 'title');
  checkDates(t);
  if (t.notes !== undefined && t.notes.length > LIMITS.notes) throw new Error(`notes are ${t.notes.length} characters, over Things' limit of ${LIMITS.notes}. Nothing was changed.`);
  if (t.checklist !== undefined) checkChecklist(t.checklist);
  if (t.tags !== undefined) checkTagNames(t.tags);
  if (t.projectId !== undefined && t.areaId !== undefined) throw new Error('Give a project or an area, not both. Nothing was changed.');
}

function checkPatch(p: TodoPatch): void {
  const given = Object.entries(p).filter(([, v]) => v !== undefined);
  if (given.length === 0) throw new Error('Nothing to change was given.');
  if (p.title !== undefined) checkTitleText(p.title, 'title');
  checkDates(p);
  if (p.prependNotes !== undefined && p.appendNotes !== undefined) throw new Error('Prepend or append notes, not both at once. Nothing was changed.');
  if (p.appendChecklist !== undefined) checkChecklist(p.appendChecklist);
  if (p.addTags !== undefined) checkTagNames(p.addTags);
  if (p.projectId !== undefined && p.areaId !== undefined) throw new Error('Give a project or an area, not both. Nothing was changed.');
}

/** Dates must be real, and ones Things can store; otherwise it drops them without a word. */
function checkDates(t: { when?: When; deadline?: string | null }): void {
  const dated = [['deadline', t.deadline], ['when', t.when !== undefined && /^\d/.test(t.when) ? t.when : undefined]] as const;
  for (const [what, v] of dated) {
    if (typeof v === 'string' && !isStorableDate(v)) {
      throw new Error(`The ${what} ${JSON.stringify(v)} isn't a date Things can store: use a real date, YYYY-MM-DD, no later than ${LAST_THINGS_DATE}. Nothing was changed.`);
    }
  }
}

function checkTitleText(s: string, what: string): void {
  if (!s.trim()) throw new Error(`The ${what} is empty. Nothing was changed.`);
  if (/[\r\n]/.test(s)) throw new Error(`The ${what} can't contain a line break. Nothing was changed.`);
  if (s.length > LIMITS.title) throw new Error(`The ${what} is over Things' limit of ${LIMITS.title} characters. Nothing was changed.`);
}

function checkChecklist(items: string[]): void {
  if (items.length > LIMITS.checklist) throw new Error(`Over Things' limit of ${LIMITS.checklist} checklist items. Nothing was changed.`);
  for (const i of items) checkTitleText(i, 'checklist item');
}

function checkTagNames(tags: string[]): void {
  for (const t of tags) if (t.includes(',')) throw new Error(`The tag "${quoted(t)}" contains a comma, which Things can't take here. Nothing was changed.`);
  if (new Set(tags).size !== tags.length) throw new Error('A tag is given twice. Nothing was changed.');
}

/** Things silently drops unknown tags, so refuse them up front rather than half-succeed. */
function checkTagsExist(r: ThingsReader, tags: string[]): void {
  const known = new Set(r.tagTitles());
  const unknown = tags.filter((t) => !known.has(t));
  if (unknown.length) {
    throw new Error(`No such tag in Things: ${unknown.map((t) => `"${quoted(t)}"`).join(', ')}. Things would silently drop it, so nothing was changed. Use an existing tag (things_get_overview lists them), or create the tag in Things first.`);
  }
}

function checkTitle(t: Task, expectTitle: string): void {
  if (expectTitle.trim() !== t.title.trim()) {
    throw new Error(`That item is titled "${quoted(t.title)}", not "${quoted(expectTitle)}". Nothing was changed. Re-read it and check it's the right item.`);
  }
}

/** The URL-scheme token Things stores. Without one, Things would show an alert. */
function urlToken(r: ThingsReader): string {
  const token = r.urlSchemeToken();
  if (!token) throw new SetupError('Things has no URL-scheme token yet. Turn on "Enable Things URLs" in Things > Settings > General, then retry. Nothing was changed.');
  return token;
}

/**
 * The item, if it may be changed; otherwise throw, saying why. It exists, is the right type, is not
 * in the Trash (itself or via its project), and is not a repeating template or inside a repeating
 * project (one copy of a repeating to-do is fine, within `copyPatch`).
 */
function writable(r: ThingsReader, uuid: string, kind?: 'to-do' | 'project'): Task {
  const task = r.task(uuid);
  if (!task) throw new Error(`No Things item has the id ${uuid}. Nothing was changed; ids come only from earlier results, so re-read the list.`);
  if (task.type === 'heading') throw new Error('That is a heading; headings can only be changed in Things. Nothing was changed.');
  if (kind && task.type !== kind) throw new Error(`That is a ${task.type}, not a ${kind}. Nothing was changed.`);
  if (task.repeating_template) throw new Error(`"${quoted(task.title)}" is the repeat itself, not one copy of it; change the repeat in Things. Nothing was changed.`);
  if (inTrash(r, task)) throw new Error(`"${quoted(task.title)}" is in the Trash. Nothing was changed.`);
  const headingProject = task.heading ? r.task(task.heading)?.project : undefined;
  const owner = task.project ?? headingProject;
  const ownerTask = owner ? r.task(owner) : undefined;
  if (ownerTask?.repeating) throw new Error(`"${quoted(task.title)}" is inside the repeating project "${quoted(ownerTask.title)}"; change it in Things. Nothing was changed.`);
  return task;
}

/** Where an item is being put, if anywhere: an open, non-repeating project not in the Trash, or an area. */
function openContainer(r: ThingsReader, target: { projectId?: string; areaId?: string }): void {
  if (target.projectId !== undefined) {
    const p = writable(r, target.projectId, 'project');
    if (p.repeating) throw new Error(`The project "${quoted(p.title)}" repeats; adding to it here isn't supported. Nothing was changed.`);
    if (p.status !== 'incomplete') throw new Error(`The project "${quoted(p.title)}" is ${p.status}; adding to it could reopen it. Nothing was changed.`);
  }
  if (target.areaId !== undefined && !r.areas().some((a) => a.uuid === target.areaId)) {
    throw new Error(`No Things area has the id ${target.areaId}. Nothing was changed.`);
  }
}

// --- What a change should leave behind ---

/** A title as the duplicate check compares it: "  Buy   MILK." is "buy milk". */
function sameTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
}

/** To-dos with exactly this title, in any state. */
function sameTitled(r: ThingsReader, title: string): Task[] {
  return r.tasks({ type: 'to-do', status: null, trashed: null, contextTrashed: null, search: title }).filter((t) => t.title === title);
}

function inTrash(r: ThingsReader, t: Task): boolean {
  if (t.trashed) return true;
  const project = t.project ?? (t.heading ? r.task(t.heading)?.project : undefined);
  return Boolean(project && r.task(project)?.trashed);
}

/**
 * What may change on one copy of a repeating to-do: only what has been measured as safe on one. A
 * move to today, this evening or a later day, a deadline set, done or cancelled. Everything else is
 * refused until someone has tried it. "tomorrow" goes as its date, the form that was measured.
 * (Evidence: https://github.com/mikegreiling/things-api/blob/main/docs/lab/repx1-instance-semantics.md
 * and cnc1-template-mutations.md: the template, not a copy, is what Things crashes on.)
 */
export function copyPatch(t: Task, patch: TodoPatch, today: string): TodoPatch {
  const no = (what: string): never => {
    throw new Error(`"${quoted(t.title)}" is one copy of a repeating to-do, and ${what} is untried on one. A copy can be moved to today, this evening or a later day, given a deadline, completed, cancelled or trashed; do the rest in Things. Nothing was changed.`);
  };
  if (t.status !== 'incomplete') no('changing a closed one');
  const when = patch.when === 'tomorrow' ? addDays(today, 1) : patch.when;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === 'when' && typeof when === 'string' && (when === 'today' || when === 'evening' || (/^\d{4}-\d{2}-\d{2}$/.test(when) && when >= today))) continue;
    if (k === 'deadline' && typeof v === 'string') continue;
    no(`changing its ${k}${k === 'when' || k === 'deadline' ? ` to ${JSON.stringify(v)}` : ''}`);
  }
  return when === undefined || when === patch.when ? patch : { ...patch, when };
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return localIsoDate(new Date(y!, m! - 1, d! + n));
}

/** How a `when` lands in the database (measured on a real database). */
export function whenFields(when: When, today: string): Pick<Task, 'start' | 'start_date' | 'evening'> {
  if (when === 'today') return { start: 'Anytime', start_date: today, evening: false };
  if (when === 'evening') return { start: 'Anytime', start_date: today, evening: true };
  if (when === 'tomorrow') return { start: 'Someday', start_date: addDays(today, 1), evening: false };
  if (when === 'anytime') return { start: 'Anytime', start_date: null, evening: false };
  if (when === 'someday') return { start: 'Someday', start_date: null, evening: false };
  return { start: when <= today ? 'Anytime' : 'Someday', start_date: when, evening: false };
}

type Expected = Partial<Pick<Task, 'title' | 'notes' | 'start' | 'start_date' | 'evening' | 'deadline' | 'project' | 'area' | 'status'>> & {
  tags?: string[];
  checklist?: string[];
};

/** The exact state an item should be in after `patch`, from its state before. */
function expectedAfter(before: Task, patch: TodoPatch, today: string): Expected {
  const e: Expected = {};
  const notes = before.notes ?? '';
  if (patch.title !== undefined) e.title = patch.title;
  if (patch.prependNotes !== undefined) e.notes = notes ? `${patch.prependNotes}\n${notes}` : patch.prependNotes;
  if (patch.appendNotes !== undefined) e.notes = notes ? `${notes}\n${patch.appendNotes}` : patch.appendNotes;
  if (patch.when !== undefined) Object.assign(e, whenFields(patch.when, today));
  if (patch.deadline !== undefined) e.deadline = patch.deadline;
  if (patch.addTags !== undefined) e.tags = [...new Set([...(before.tags ?? []), ...patch.addTags])];
  if (patch.appendChecklist !== undefined) e.checklist = [...checklistTitles(before), ...patch.appendChecklist];
  if (patch.projectId !== undefined) e.project = patch.projectId;
  if (patch.areaId !== undefined) Object.assign(e, { area: patch.areaId, project: null });
  return e;
}

function differences(t: Task, e: Expected): string[] {
  const p: string[] = [];
  for (const k of ['title', 'notes', 'start', 'start_date', 'evening', 'deadline', 'project', 'area', 'status'] as const) {
    if (!(k in e)) continue;
    // Empty notes read back as "" or null.
    const have = k === 'notes' ? t.notes || null : (t[k] ?? null);
    const want = k === 'notes' ? e.notes || null : (e[k] ?? null);
    if (have === want) continue;
    // Notes by length only: they can be long and private.
    p.push(k === 'notes' ? `notes differ (${String(t.notes ?? '').length} characters, want ${String(e.notes ?? '').length})` : `${k} is ${JSON.stringify(have)}, want ${JSON.stringify(want)}`);
  }
  if (e.tags && !sameSet(t.tags ?? [], e.tags)) p.push(`tags differ (${(t.tags ?? []).length}, want ${e.tags.length})`);
  if (e.checklist && JSON.stringify(checklistTitles(t)) !== JSON.stringify(e.checklist)) p.push('checklist differs');
  return p;
}

function newTodoProblems(t: Task, input: NewTodo, today: string): string[] {
  return [
    ...(t.type === 'to-do' ? [] : [`type is ${t.type}`]),
    ...differences(t, {
      title: input.title,
      notes: input.notes ?? '',
      ...(input.when ? whenFields(input.when, today) : {}),
      deadline: input.deadline ?? null,
      tags: input.tags ?? [],
      ...(input.checklist && { checklist: input.checklist }),
      ...(input.projectId && { project: input.projectId }),
      ...(input.areaId && { area: input.areaId }),
      status: 'incomplete',
    }),
  ];
}

function checklistTitles(t: Task): string[] {
  return Array.isArray(t.checklist) ? t.checklist.map((c) => c.title) : [];
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');
}
