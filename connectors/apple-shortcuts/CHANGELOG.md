# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

## [0.2.1] - 2026-08-10

### Changed

- Close N2-N4: redacted Error logging in the logger, precise ENOENT cleanup gating, and  argv terminator placement.

### Fixed
- Cleanup-failure warnings now log the actual cause instead of `"{}"`: `logger.warn` serialized `Error` objects through `JSON.stringify`, which drops their message. The temp-file/dir cleanup warnings carry the errno (falling back to the message for non-fs errors) so the temporary input path never reaches log files.
- A failed temp-input write no longer raises a spurious "input may be at rest" cleanup warning: the `finally` unlink treats ENOENT as benign only when the write never created the file (nothing is at rest). A temp file that vanishes after a successful write still warns, since it may have been moved rather than deleted.
- `apple_shortcuts_run` and `apple_shortcuts_view` now insert a `--` end-of-options separator before the shortcut name on the `shortcuts` CLI argv (after all options, immediately before the name), so a name beginning with `-` can never be reinterpreted as a flag.

- Re-synced the vendored `<untrusted-content>` envelope helper with the canonical hardened reference: attribute-bearing close-tag variants (`</untrusted-content foo>`) and spoofed open tags inside wrapped content are now escaped, closing an envelope-breakout gap an LLM parser could read as an envelope boundary.

## [0.2.0] - 2026-08-07

### Changed

- Apple Shortcuts connector: canonical result envelopes, untrusted-content fencing, timeout+kill controls; new view action.

### Added
- New tool `apple_shortcuts_view`: opens a named shortcut in the Shortcuts app editor (`shortcuts view`) so the user can review what it does before running it.
- `APPLE_SHORTCUTS_TIMEOUT_MS` (default `120000`): `shortcuts` CLI invocations that exceed the timeout are terminated (SIGTERM, then SIGKILL after a 5s grace period) and reported as errors, instead of blocking the tool call forever when a shortcut opens a GUI dialog.
- Protocol-level smoke tests via the shared `@mindstone/mcp-test-harness`, plus timeout behavior tests.

### Security
- Shortcut stdout and listed shortcut names are now wrapped in `<untrusted-content>` envelopes (AGENTS.md invariant #6); CLI stderr in error results is enveloped too. Previously this output reached the model unwrapped.
- Re-synced the vendored `untrusted-content` envelope helper with the canonical reference (it had drifted in comments and helper surface while claiming to be byte-for-byte identical) and added direct adversarial unit tests covering exact/uppercase/space/tab/newline/CR close-tag breakout variants and idempotency.
- Shortcut names echoed in `apple_shortcuts_run` / `apple_shortcuts_view` confirmation, error, and timeout messages are now wrapped in `<untrusted-content>` envelopes. A name picked up from the list output is attacker-controllable text and previously reached the model outside the trust boundary.
- `apple_shortcuts_run` is now annotated `destructiveHint: true` (AGENTS.md invariant #7). A shortcut executes with the logged-in user's permissions and can send messages, delete files, make purchases, control devices, or call remote APIs; the tool previously declared itself non-destructive.
- Timeout warnings no longer log the full `shortcuts` argv (which contains the user-authored shortcut name and the temporary input path), and the invalid-`APPLE_SHORTCUTS_TIMEOUT_MS` warning no longer echoes the raw environment value.
- Captured CLI stdout/stderr is now bounded at 1,000,000 characters per stream; excess output is dropped with a truncation marker, so a shortcut emitting unbounded output cannot exhaust memory before the timeout fires.

### Fixed
- Timeout results no longer claim the process "was terminated" when termination could not be confirmed (signal delivery failed, or the process never emitted `close` after SIGKILL): the list/run/view timeout errors now state that the process may still be running on that path, which matters because `apple_shortcuts_run` executes with the logged-in user's permissions.
- Timeout handling now settles the tool call even when signal delivery fails or the process never emits `close` after SIGKILL (previously the call could hang forever), and signal-delivery failures are logged.
- `APPLE_SHORTCUTS_TIMEOUT_MS` values that floor below 1ms now fall back to the default (they previously caused near-instant termination), and values above Node's timer range are clamped instead of overflowing to a 1ms timeout.
- Temporary-input cleanup failures are now logged instead of silently ignored (a failed unlink leaves user input at rest), and the temp-file setup happens inside the `try` so a setup failure still runs cleanup.
- The exported `create*Handler` factories now parse their input against the strict Zod schemas themselves, so embedders calling them directly (without the MCP SDK's validation) get the same fail-closed behavior and an invalid call never reaches the `shortcuts` CLI.

### Changed
- Tool registration moved behind an exported `createServer(runner?)` factory so tests (and embedders) can inject a fake `shortcuts` CLI runner; the stdio entrypoint is unchanged.

## [0.1.2] - 2026-05-14
### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.
- **registry**: cohort review fixes + Office REBEL_OFFICE_* → MCP_OFFICE_* rename + browser-automation mcpName.

### Fixed
- **workflows**: ci.yml + apple-shortcuts — add missing connectors to matrix, bump SDK (M1.4)
- **apple-shortcuts**: treat `input` as text, not a path (M3.11)
- **apple-shortcuts**: migrate tests to vitest so the Node 20 CI shard passes. `node --test __tests__/*.test.ts` relied on native TS loading, which is only available in Node 22.6+, breaking apple-shortcuts (20). Aligns with the vitest convention used by every other connector.
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.1.1] - 2026-04-29

### Fixed
- **apple-shortcuts**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.1.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

## [1.0.0] - 2026-04-24

### Added
- add apple-shortcuts connector (#11)


