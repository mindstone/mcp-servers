/**
 * Finding the Things 3 database and reading a private snapshot of it.
 *
 * The database is the user's real data, and Things is usually running and writing to it (WAL
 * mode). Nothing here ever opens it for writing. The live file is touched only by
 * `/usr/bin/sqlite3 -readonly`, for the moment its online backup takes (about 50 ms for a 15 MB
 * database), which copies a consistent snapshot, WAL included, into a private temporary file.
 * That file is loaded into an in-memory SQLite (sql.js, WebAssembly) and deleted at once, so every
 * query runs against memory.
 *
 * Why this route: `node:sqlite` is missing from Node 20 (which some hosts bundle), a native addon
 * such as better-sqlite3 is fragile under `npx`, and macOS ships `/usr/bin/sqlite3`.
 *
 * Writes to Things never go through SQL: see ./writer.ts.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';

const run = promisify(execFile);

export const THINGS_GROUP_CONTAINER = join(homedir(), 'Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac');
const SQLITE3 = '/usr/bin/sqlite3';

/** Oldest `databaseVersion` understood (things.py asserts > 21). */
export const MIN_DB_VERSION = 22;
/**
 * Newest `databaseVersion` checked against real data (Things 3.24, 2026). A newer one may have
 * changed what columns mean: reads go on with a warning, and writes refuse, until someone re-checks
 * the queries and raises this.
 */
export const MAX_VERIFIED_DB_VERSION = 29;

export type Param = string | number | null;

/** The little the reader needs from a database: rows as plain objects. */
export interface Db {
  all(sql: string, params?: Param[]): Record<string, unknown>[];
  close(): void;
  /** Set when the database is loaded: whether its schema version is one that has been checked. */
  trust: SchemaTrust;
}

/** A failure the user has to fix outside the conversation (install, permission, setting). */
export class SetupError extends Error {}

const FULL_DISK_ACCESS =
  'macOS is blocking access to the Things database. Give the app this MCP server runs in ' +
  '(Claude, Terminal, your editor, Rebel...) Full Disk Access in System Settings > Privacy & Security > Full Disk Access, then restart that app.';

/**
 * Path of the live Things database. `THINGSDB` overrides it (as in things.py). Fails loudly if there
 * is not exactly one `ThingsData-*` folder, rather than guessing.
 */
export function findThingsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.THINGSDB?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new SetupError(`THINGSDB must be an absolute path; got ${JSON.stringify(override)}.`);
    if (!existsSync(override)) throw new SetupError(`THINGSDB points at ${override}, which does not exist.`);
    return override;
  }
  if (process.platform !== 'darwin') throw new SetupError('Things 3 is a macOS app; this server only runs on macOS.');
  let entries: string[];
  try {
    entries = readdirSync(THINGS_GROUP_CONTAINER);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new SetupError('Things 3 does not seem to be installed (no Things data folder found). Install and open Things 3, then retry.');
    if (code === 'EPERM' || code === 'EACCES') throw new SetupError(FULL_DISK_ACCESS);
    throw e;
  }
  const candidates = entries
    .filter((d) => d.startsWith('ThingsData-'))
    .map((d) => join(THINGS_GROUP_CONTAINER, d, 'Things Database.thingsdatabase', 'main.sqlite'))
    .filter((p) => existsSync(p));
  if (candidates.length === 0) throw new SetupError('No Things database found. Open Things 3 once so it creates one, then retry.');
  if (candidates.length > 1) {
    throw new SetupError(`Found ${candidates.length} Things databases: ${candidates.join(', ')}. Set THINGSDB to the one to use.`);
  }
  return candidates[0]!;
}

let sqlJs: Promise<SqlJsStatic> | undefined;
function engine(): Promise<SqlJsStatic> {
  sqlJs ??= initSqlJs();
  return sqlJs;
}

/** Wrap a sql.js database as a `Db`. */
function wrap(db: Database): Omit<Db, 'trust'> {
  return {
    all(sql, params = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params as SqlValue[]);
        const rows: Record<string, unknown>[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    },
    close: () => db.close(),
  };
}

/** Load a database file into memory and check its schema version. The file is only read. */
export async function loadDbFile(path: string): Promise<Db> {
  const SQL = await engine();
  const db = wrap(new SQL.Database(readFileSync(path)));
  try {
    return { ...db, trust: checkSchema({ ...db, trust: { kind: 'ok', version: 0 } }) };
  } catch (e) {
    db.close();
    throw e;
  }
}

/**
 * A consistent snapshot of the live database, in memory. The live file is opened read-only by
 * `sqlite3` for the backup only; the temporary copy is deleted before this returns.
 */
export async function snapshotThingsDb(source: string = findThingsDbPath()): Promise<Db> {
  const dir = mkdtempSync(join(tmpdir(), 'things-mcp-'));
  try {
    const dest = join(dir, 'snapshot.sqlite');
    // The destination goes inside a dot-command, so it must need no quoting; ours never does.
    if (!/^[\w/.-]+$/.test(dest)) throw new Error(`Unexpected characters in the temporary path ${dest}.`);
    try {
      // `--` so a source path can never be read as an option.
      await run(SQLITE3, ['-readonly', '-bail', '--', source, `.backup '${dest}'`], { timeout: 15_000 });
    } catch (e) {
      const stderr = String((e as { stderr?: unknown }).stderr ?? (e as Error).message);
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new SetupError(`${SQLITE3} is missing; it ships with macOS.`);
      if (/authori[sz]ation denied|operation not permitted|unable to open/i.test(stderr)) throw new SetupError(FULL_DISK_ACCESS);
      throw new Error(`Could not read the Things database: ${stderr.trim()}`);
    }
    return await loadDbFile(dest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `Meta.databaseVersion` is an XML plist holding a single <integer>. */
export function readDbVersion(db: Db): number {
  const [row] = db.all(`SELECT value FROM Meta WHERE key = 'databaseVersion'`);
  const m = typeof row?.value === 'string' ? /<integer>(\d+)<\/integer>/.exec(row.value) : null;
  if (!m) throw new Error('This does not look like a Things 3 database (no databaseVersion).');
  return Number(m[1]);
}

/**
 * How far this database can be trusted: `ok`, or `unverified` for a schema newer than any checked
 * (reads go on, with a warning; writes refuse). Older than understood, or missing columns the
 * queries need, throws.
 */
export type SchemaTrust = { kind: 'ok'; version: number } | { kind: 'unverified'; version: number };

/** Columns the queries rely on; a schema change that drops one is refused rather than misread. */
const NEEDED_COLUMNS: Record<string, string[]> = {
  TMTask: ['uuid', 'type', 'trashed', 'title', 'status', 'area', 'project', 'heading', 'notes', 'start', 'startDate', 'deadline',
    'stopDate', 'creationDate', 'userModificationDate', 'index', 'todayIndex', 'startBucket', 'todayIndexReferenceDate',
    'rt1_repeatingTemplate', 'rt1_recurrenceRule', 'reminderTime', 'deadlineSuppressionDate'],
  TMArea: ['uuid', 'title', 'index'],
  TMTag: ['uuid', 'title', 'shortcut', 'index'],
  TMTaskTag: ['tasks', 'tags'],
  TMAreaTag: ['areas', 'tags'],
  TMChecklistItem: ['uuid', 'title', 'status', 'stopDate', 'task', 'index', 'userModificationDate'],
  TMSettings: ['uriSchemeAuthenticationToken'],
};

export function checkSchema(db: Db): SchemaTrust {
  const version = readDbVersion(db);
  if (version < MIN_DB_VERSION) {
    throw new SetupError(`This Things database is version ${version}, older than this server understands (${MIN_DB_VERSION} or later). Update Things 3.`);
  }
  for (const [table, columns] of Object.entries(NEEDED_COLUMNS)) {
    const have = new Set(db.all(`SELECT name FROM pragma_table_info(?)`, [table]).map((r) => r.name as string));
    const missing = columns.filter((c) => !have.has(c));
    if (missing.length) {
      throw new SetupError(`This Things database (version ${version}) has changed shape: ${table} lacks ${missing.join(', ')}. Update the MCP server, or report it.`);
    }
  }
  // Repeating to-do templates are hidden by `rt1_recurrenceRule IS NULL` (as in things.py). Things
  // 3.23 added a `repeater` column; as of version 29 it is unused. If templates start being marked
  // only by `repeater` they would leak into lists, so refuse instead of misreading.
  const hasRepeater = db.all(`SELECT 1 FROM pragma_table_info('TMTask') WHERE name = 'repeater'`).length > 0;
  if (hasRepeater) {
    const [row] = db.all(`SELECT COUNT(*) AS n FROM TMTask WHERE repeater IS NOT NULL AND rt1_recurrenceRule IS NULL`);
    if (Number(row?.n ?? 0) > 0) {
      throw new SetupError('This Things version marks repeating to-dos in a way this server does not understand yet. Update the MCP server, or report it.');
    }
  }
  return version > MAX_VERIFIED_DB_VERSION ? { kind: 'unverified', version } : { kind: 'ok', version };
}

/** What a read result carries when the schema is newer than any checked. */
export function schemaWarning(trust: SchemaTrust): string | undefined {
  return trust.kind === 'unverified'
    ? `This Things database is version ${trust.version}, newer than this server has been checked against (up to ${MAX_VERIFIED_DB_VERSION}). Reads may be slightly off; changes are refused until the server is updated.`
    : undefined;
}
