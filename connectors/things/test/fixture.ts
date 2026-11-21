/**
 * Synthetic Things databases for tests: the real schema (databaseVersion 29, the tables and columns
 * of a live Things 3.24 database, no data), filled with made-up rows the test describes. Built with
 * sql.js, so tests run on any Node and any OS.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import { isoToThingsDate } from '../src/dates.js';

export const FIXTURE_TOKEN = 'not-a-real-token';

const SCHEMA = `
CREATE TABLE Meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE TMArea (uuid TEXT PRIMARY KEY, title TEXT, visible INTEGER, "index" INTEGER, cachedTags BLOB, experimental BLOB);
CREATE TABLE TMTag (uuid TEXT PRIMARY KEY, title TEXT, shortcut TEXT, usedDate REAL, parent TEXT, "index" INTEGER, experimental BLOB);
CREATE TABLE TMSettings (uuid TEXT PRIMARY KEY, logInterval INTEGER, manualLogDate REAL, groupTodayByParent INTEGER, uriSchemeAuthenticationToken TEXT, experimental BLOB);
CREATE TABLE TMTaskTag (tasks TEXT NOT NULL, tags TEXT NOT NULL);
CREATE TABLE TMAreaTag (areas TEXT NOT NULL, tags TEXT NOT NULL);
CREATE TABLE TMChecklistItem (uuid TEXT PRIMARY KEY, userModificationDate REAL, creationDate REAL, title TEXT, status INTEGER, stopDate REAL, "index" INTEGER, task TEXT, leavesTombstone INTEGER, experimental BLOB);
CREATE TABLE TMTask (
  uuid TEXT PRIMARY KEY, leavesTombstone INTEGER, creationDate REAL, userModificationDate REAL, type INTEGER,
  status INTEGER, stopDate REAL, trashed INTEGER, title TEXT, notes TEXT, notesSync INTEGER, cachedTags BLOB,
  start INTEGER, startDate INTEGER, startBucket INTEGER, reminderTime INTEGER, lastReminderInteractionDate REAL,
  deadline INTEGER, deadlineSuppressionDate INTEGER, t2_deadlineOffset INTEGER, "index" INTEGER, todayIndex INTEGER,
  todayIndexReferenceDate INTEGER, area TEXT, project TEXT, heading TEXT, contact TEXT,
  untrashedLeafActionsCount INTEGER, openUntrashedLeafActionsCount INTEGER, checklistItemsCount INTEGER,
  openChecklistItemsCount INTEGER, rt1_repeatingTemplate TEXT, rt1_recurrenceRule BLOB,
  rt1_instanceCreationStartDate INTEGER, rt1_instanceCreationPaused INTEGER, rt1_instanceCreationCount INTEGER,
  rt1_afterCompletionReferenceDate INTEGER, rt1_nextInstanceStartDate INTEGER, experimental BLOB, repeater BLOB,
  repeaterMigrationDate REAL
);`;

const plistInt = (n: number): string => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<integer>${n}</integer>\n</plist>\n`;

export interface FixtureTask {
  uuid: string;
  title: string;
  type?: 'to-do' | 'project' | 'heading';
  status?: 'incomplete' | 'canceled' | 'completed';
  start?: 'Inbox' | 'Anytime' | 'Someday';
  startDate?: string;
  deadline?: string;
  stopDate?: string;
  created?: string;
  trashed?: boolean;
  notes?: string;
  index?: number;
  todayIndex?: number;
  evening?: boolean;
  /** One copy of a repeating to-do. */
  repeatingInstance?: boolean;
  /** The template of a repeating to-do (hidden from lists). */
  recurringTemplate?: boolean;
  area?: string;
  project?: string;
  heading?: string;
  tags?: string[];
  checklist?: string[];
}

export interface Fixture {
  areas?: { uuid: string; title: string; tags?: string[] }[];
  tags?: string[];
  tasks?: FixtureTask[];
  dbVersion?: number;
  /** Leave out the URL-scheme token, as before "Enable Things URLs" was ever turned on. */
  noToken?: boolean;
  /** Drop a column the queries need, as a future schema might. */
  dropColumn?: { table: string; column: string };
}

const unix = (iso: string): number => Date.parse(iso) / 1000;

/** Open a database file with sql.js, let `fn` change it, and write it back. */
export async function mutate<T>(path: string, fn: (db: Database) => T): Promise<T> {
  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync(path));
  try {
    const out = fn(db);
    writeFileSync(path, db.export());
    return out;
  } finally {
    db.close();
  }
}

/** Write a fixture database to a fresh temp dir and return its path. */
export async function makeFixtureDb(f: Fixture): Promise<string> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec(SCHEMA);
  if (f.dropColumn) db.exec(`ALTER TABLE ${f.dropColumn.table} DROP COLUMN ${f.dropColumn.column}`);
  db.run(`INSERT INTO Meta VALUES ('databaseVersion', ?)`, [plistInt(f.dbVersion ?? 29)]);
  db.run(`INSERT INTO TMSettings (uuid, uriSchemeAuthenticationToken) VALUES ('settings', ?)`, [f.noToken ? null : FIXTURE_TOKEN]);

  const tagUuid = (t: string): string => `tag-${t}`;
  (f.tags ?? []).forEach((t, i) => db.run(`INSERT INTO TMTag (uuid, title, "index") VALUES (?, ?, ?)`, [tagUuid(t), t, i]));
  (f.areas ?? []).forEach((a, i) => {
    db.run(`INSERT INTO TMArea (uuid, title, "index") VALUES (?, ?, ?)`, [a.uuid, a.title, i]);
    for (const t of a.tags ?? []) db.run(`INSERT INTO TMAreaTag VALUES (?, ?)`, [a.uuid, tagUuid(t)]);
  });

  const TYPE = { 'to-do': 0, project: 1, heading: 2 };
  const STATUS = { incomplete: 0, canceled: 2, completed: 3 };
  const START = { Inbox: 0, Anytime: 1, Someday: 2 };
  (f.tasks ?? []).forEach((t, i) => {
    db.run(
      `INSERT INTO TMTask (uuid, title, type, status, start, startDate, deadline, stopDate,
         creationDate, userModificationDate, trashed, notes, "index", todayIndex, area, project, heading,
         rt1_recurrenceRule, startBucket, rt1_repeatingTemplate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.uuid, t.title, TYPE[t.type ?? 'to-do'], STATUS[t.status ?? 'incomplete'], START[t.start ?? 'Anytime'],
        t.startDate ? isoToThingsDate(t.startDate) : null, t.deadline ? isoToThingsDate(t.deadline) : null,
        t.stopDate ? unix(t.stopDate) : null, unix(t.created ?? '2026-01-01T12:00:00Z'), unix(t.created ?? '2026-01-01T12:00:00Z'),
        t.trashed ? 1 : 0, t.notes ?? '', t.index ?? i, t.todayIndex ?? null, t.area ?? null, t.project ?? null, t.heading ?? null,
        t.recurringTemplate ? new Uint8Array([1]) : null, t.evening ? 1 : 0, t.repeatingInstance ? 'some-template-uuid' : null,
      ],
    );
    for (const tag of t.tags ?? []) db.run(`INSERT INTO TMTaskTag VALUES (?, ?)`, [t.uuid, tagUuid(tag)]);
    (t.checklist ?? []).forEach((title, j) =>
      db.run(`INSERT INTO TMChecklistItem (uuid, title, status, "index", task, userModificationDate) VALUES (?, ?, 0, ?, ?, ?)`, [`${t.uuid}-c${j}`, title, j, t.uuid, unix('2026-01-01T12:00:00Z')]),
    );
  });
  const path = join(mkdtempSync(join(tmpdir(), 'things-fixture-')), 'main.sqlite');
  writeFileSync(path, db.export());
  db.close();
  return path;
}
