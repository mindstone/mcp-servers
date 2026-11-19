# Things 3 connector (`connectors/things`)

A local stdio MCP server for [Things 3](https://culturedcode.com/things/) on macOS: read the user's
lists, projects and areas, and (opt-in) add, update, complete and trash to-dos. It works in any MCP
host (Claude Desktop, Claude Code, Codex, Rebel).

## Where it comes from

It ports the read layer and the write safety rules of an earlier private prototype, which had run
against a real Things database for weeks. That prototype's read layer was itself a TypeScript port of the
read side of [things.py](https://github.com/thingsapi/things.py). Everything app-specific is dropped
(provenance tags, signposts, approval cards, a ledger). What is kept is what makes it safe on
precious data.

## Decisions

1. **Reads: snapshot, then query in memory.** `/usr/bin/sqlite3 -readonly <live> ".backup <tmp>"`
   takes a consistent online backup (about 50 ms for a 15 MB database; the WAL is included), and the
   snapshot is loaded into [sql.js](https://github.com/sql-js/sql.js) (SQLite compiled to WASM) and
   deleted. The live file is open only for the backup, read-only, and never written.
   - Why not `node:sqlite`: Rebel runs connectors on its bundled Node 20, which has no `node:sqlite`
     (checked: `ERR_UNKNOWN_BUILTIN_MODULE`). Why not `better-sqlite3`: a native addon, fragile
     under `npx` and Electron. Why not the `sqlite3` CLI for every query: no real parameter binding,
     and one process per query. `sql.js` is one runtime dependency (MIT, about 700 KB of WASM, no
     install scripts).
   - The schema version (`Meta.databaseVersion`) must be inside the verified range (22-29), or reads
     refuse with a message saying so, rather than misreading a changed schema.
2. **Writes: the Things URL scheme, plus AppleScript for Trash. Never SQL.** The URL-scheme auth token is read from
   the database (`TMSettings`) and never logged or returned. Every tool is offered, each
   with exact hints, and the host decides which need the user's approval; `THINGS_READ_ONLY=1`
   offers the reads alone.
3. **Never send a command Things would reject.** A rejected URL command pops a modal alert in front
   of the user. So every write is validated first against a fresh snapshot: dates real, tags existing,
   project or area existing and open, item existing, not trashed, not a repeating template, the
   "Enable Things URLs" setting on, the token present.
4. **Changing an existing item needs `current_title`**, the title as the model last read it.
   A mismatch refuses, so a wrong or stale uuid never changes the wrong item. Trash re-checks the
   title inside the same AppleScript call that deletes.
5. **Nothing that loses data silently.** Notes are only appended or prepended, never replaced. Tags
   are only added. Trash is to-dos only (a project takes its to-dos with it), and goes to Things'
   Trash, which the user can restore from. Emptying the trash, and deleting outright, are not offered.
6. **Read-back verification.** After each write, poll fresh snapshots until the exact expected state
   reads back (about 10 s at most). Otherwise say the command was sent but not confirmed, which is
   different from refused-and-unchanged.
7. **New to-dos are found without marking them.** Before adding, note the uuids with that title;
   after, the new one is the uuid that wasn't there. An open to-do with the same title is not
   re-added (a retried call), unless `allow_duplicate`.
8. **Untrusted content.** Everything read from Things is the user's data but may hold text pasted
   from email or the web. Each result's item data goes in one `<untrusted-content source="things">`
   envelope (the shared helper), with counts and hints outside it.
9. **Tool surface** (prefixed `things_`, each with annotations, `openWorldHint: false`):
   - reads: `things_get_list` (inbox, today, upcoming, anytime, someday, deadlines, logbook, with
     tag / project / area filters and a limit), `things_search`, `things_get_item`,
     `things_get_project`, `things_get_overview` (areas, projects, tags);
   - writes: `things_add_todo`, `things_update_todo`, `things_set_status`, `things_trash`.
   - Results are compact JSON in a text block (no client we checked reads `structuredContent`);
     lists cap at a limit and say how many more there are and how to narrow.
10. **Distribution.** npm (`npx -y @mindstone/mcp-server-things`) for every host: Rebel, Claude
    Desktop, Claude Code and Codex. An `.mcpb` bundle for Claude Desktop is deferred (see below).
    Adding it to Rebel's catalog is a separate change in the Rebel repo.

## After review (two independent reviews of this plan, one from each model family)

Both reviews agreed on the shape (a fresh connector, CLI backup plus sql.js) and on most fixes.
What changed:

- **A cross-process lock** (a lock directory keyed to the live database) is held from validation
  through dispatch to verification, so two hosts' servers can't both pass the duplicate check or
  validate against the same state.
- **Write results are receipts**: `confirmed` (read back exactly), or `unconfirmed` (sent, not yet
  seen: re-read before retrying, since an append retried would append twice), with the item's state
  `before` the change, so a person can put it back. Refusals are errors, and change nothing. No
  durable ledger: the receipts are the record.
- **Finding a new to-do (decision 7) is tightened, not replaced by a nonce.** Under the lock, a
  candidate must be a uuid that wasn't there before, match every field sent, and have been created
  within the dispatch window. Zero or several candidates is `unconfirmed`, and no uuid is picked.
  The one review that preferred a nonce in the notes was weighed against the nonce's own cost (a
  second, notes-replacing write, and a visible marker if that fails). The remaining gap, an
  identical to-do made on another device syncing in within the same second or two, is accepted.
- **Every write guard the prototype had is kept**, and tested:
  - to-dos only, for update, status and trash; projects only for status;
  - not trashed (itself or via its project), not a repeating template, not inside a repeating
    project; a repeating copy takes only the measured writes (a move to today, this evening or a
    later day, a deadline set, completed, cancelled, trashed);
  - no move out from under a heading; no scheduling or moving a closed item; nothing added to a
    closed or repeating project; a project with open to-dos can't be completed;
  - titles one line and within Things' limit; tags existing and comma-free; one notes operation per
    update, and the resulting notes within Things' limit; `deadline: null` on an item with no
    deadline dropped, not refused; empty strings, empty arrays and nulls count as not given.
- **Every tool is offered; the host decides who approves.** Decided 2026-11-12:

  > Okay, let's add writes and deletes as tools. I don't know, don't we have some kind of metadata
  > that says whether or not something's read only? And that way then presumably the harness, you
  > know, Claude or Rebel could surface that to the user and maybe only make the read only ones
  > allowed or treat them differently somehow. But I definitely want to include all the
  > functionality in the MCP.

  So the earlier opt-in switches (`THINGS_ALLOW_WRITES`, `THINGS_ALLOW_TRASH`) are gone. Each tool
  carries exact `readOnlyHint` / `destructiveHint` values (a test pins all nine), Claude Code and
  Claude Desktop ask per tool until allowed, and Rebel gates on `readOnlyHint`. Trash keeps its other
  guards: a description that says "only when the user asked to delete this one", `current_title`,
  and a title re-checked inside the AppleScript that deletes. `THINGS_READ_ONLY=1` is the opt-out.
- **The schema ceiling no longer locks everyone out.** A newer `databaseVersion` still reads, with a
  warning in every result, as long as every column the queries use is there; writes refuse until
  the server is updated.
- **Untrusted text is wrapped on every path**, errors included; the token is redacted from every
  error and log line.
- **Snapshots**: a private (0700) temporary directory, removed in `finally`; a 15 s timeout on
  `sqlite3`; distinct messages for "not installed", "permission denied" and "several databases".
- **Tools**: `things_get_area` is dropped (the overview lists areas; `things_get_list` filters by
  area). Lists and search take `offset` for paging. Every write is `destructiveHint` except add, and
  adds and appends are not idempotent. Results carry today's local date.
- **Deferred**: the `.mcpb` bundle (no precedent in this repo's release tooling yet).

## After the code reviews (the same two reviewers, on the finished code)

- **`THINGSDB` turns changes off.** Both found that a copy could pass the checks for a change that
  then went to the real Things.
- **The lock is a kernel file lock** (flock, taken by `/usr/bin/lockf` in a child process that
  holds it until we let go) on a file in `~/Library/Caches/mcp-server-things`, not the temp folder,
  which differs from host to host. The first fix, a lock directory with stale-owner takeover, still
  let two writers in (a confirming review reproduced it); with the kernel lock there is no takeover
  to get wrong: the system frees it the instant its holder exits, and never displaces a live one.
- **Finding a new to-do** now expects every default too (the Inbox, no checklist, no project or
  area unless given, not in the Trash, made no later than now).
- **After sending, every failure is `unconfirmed`**, including a failed read while checking, so a
  model never reads "error" as "nothing happened".
- **Unknown arguments refuse the call**, instead of being dropped; the server checks them itself,
  so an unknown name is quoted inside an envelope.
- **A failed send or AppleScript call is `unconfirmed`** (it may have reached Things), except a
  macOS permission refusal, which means nothing ran.
- **No user text outside an envelope**, in diagnostics or executor errors.
- **For models**: the duplicate check is scoped to where the to-do would go (the Inbox only for an
  Inbox add); headings in a project are kept apart by id, not name; search prefers items
  with every word and says when it falls back; Upcoming is soonest first; the weekday comes with the
  date; `tonight` is accepted; `things_get_project` is paged; read-only instructions say how changes
  are turned on.
- Each of these has a test, shown failing on the code before the fix
  (`test/review-fixes.test.ts`).

## Tests

- Unit tests against a generated fixture database (the real schema's tables and columns, made-up
  data), and a fake executor that records URL and AppleScript commands.
- Over the protocol with the SDK's in-memory transport: tools listed, writes hidden by default,
  errors returned as `isError` results, and the exact hints on all nine tools.
- A live smoke test, opt-in (`THINGS_LIVE=1`), that reads the real database; and a live write test
  (`THINGS_LIVE_WRITES=1`) that adds one uniquely named to-do, updates it, completes it and
  trashes it, touching nothing else.

## Not in v1

Creating projects, headings and checklists beyond appending items; removing tags; replacing notes;
moving a to-do to a heading; reminders.

## Where it stands (2026-11-16)

- **The change moved from PR [#244](https://github.com/mindstone/mcp-servers/pull/244) to the
  Mindstone Rebel repo.** This repo's `main` now takes only the export from Rebel's `mcp-servers/`
  folder, so #244 could never merge; the same change lands there and reaches `main` by the export.
  Every `things` check passes (build-and-test, STATUS drift, envelope coverage, server.json).
- **Merging does not publish to npm.** `release.yml` skips a package that is new in the pushed
  range, so the first npm publish of `@mindstone/mcp-server-things` stays a manual maintainer step.
  Until it is done, a later change under `connectors/things/` turns `release.yml` red (an
  unpublished current version with no Release-Gate trailer): it publishes nothing, but fails
  loudly. Do the first publish before changing the connector again.
- **Release hygiene fails, but not for this change.** It fails on `packages/mcp-app-compose`
  (src changed after its last version bump), on `main` as well.
- **CI found one real bug, fixed:** on Linux `flock(1)` passed the locked file to the command it ran,
  so a child outliving `flock` kept the lock. `flock -o` keeps it with `flock` alone, as `lockf` does
  on macOS.
- **Next:** land the Rebel PR (re-run `npm test` and the repo's `check-*` scripts for
  `things` after any change); after merge, the first npm publish of `@mindstone/mcp-server-things`,
  then a Rebel catalogue entry (`catalog-entry.json`, `catalogId: bundled-things`, darwin only).
  Later, not yet asked for: an `.mcpb` bundle for Claude Desktop.
- **Live tests** (`npm run test:live`, `test:live-writes`) need a Mac with Things; a Linux box cannot
  run them. Writes in them touch only one self-created test to-do; never change anything else in a
  real Things database.
