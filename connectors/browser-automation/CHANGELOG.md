# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

## [0.2.2] - 2026-08-10

### Changed

- Close the upload leaf-swap with O_NOFOLLOW + inode binding, and refuse directory overwrite atomically.

### Fixed
- `browser_upload` closes the swap window between path validation and open: the validated source is now opened once with `O_NOFOLLOW` (a post-validation leaf swap for a symlink fails instead of being followed outside the workspace) and `O_NONBLOCK` (a planted FIFO can no longer wedge the connector by blocking the open), and the opened descriptor is bound to a fresh confined resolution by device+inode, so an intermediate-directory or leaf swap after validation is refused with `UPLOAD_SOURCE_CHANGED` instead of staging a file outside the workspace.
- `browser_pdf` with `overwrite: true` on a destination that is a directory now fails with `DESTINATION_IS_DIRECTORY` instead of a raw filesystem error; the overwrite delete is a bare `unlink`, which refuses directories atomically and can never recurse into a directory tree.

## [0.2.1] - 2026-08-08

### Changed

- Enable browser_evaluate by default: the BROWSER_AUTOMATION_ALLOW_EVAL gate is removed; invocation gating is the host tool-approval layer's job.

### Removed
- `BROWSER_AUTOMATION_ALLOW_EVAL` opt-in gate: `browser_evaluate` now runs by default — it is registered unconditionally (capability-first), keeping `destructiveHint: true` so the host's tool-approval layer gates each invocation with explicit user confirmation. The env var is no longer consulted and has been dropped from `server.json` and the README. (Released as a patch; `npm run mcp:release` promotes this entry.)

## [0.2.0] - 2026-08-07

### Changed

- Browser automation connector: canonical snapshot envelopes, untrusted-content fencing, and hardening sync; expanded navigation/interaction actions.

### Added
- `browser_get_text` — clean page-text extraction (whole page or a single element) for reading and summarising workflows.
- `browser_pdf` — save the current page as a PDF. Output paths are constrained to the workspace directory (`MCP_WORKSPACE_PATH`, or the system temp directory when unset) with canonical containment that refuses `..` traversal, out-of-workspace absolutes, and symlink escapes.
- `browser_upload` — upload files to a page file input. Source paths are constrained to the same workspace sandbox as `browser_pdf`.

### Changed
- Bumped the `agent-browser` npx fallback pin from 0.26.0 to 0.33.2 (verified against the connector's full command surface).
- `browser_pdf` gains an `overwrite` parameter (default `false`): an existing file at `file_path` is now refused with `FILE_EXISTS` instead of being silently replaced, unless `overwrite: true` is passed.
- `browser_upload` and `browser_pdf` now declare `destructiveHint: true` so hosts can require user confirmation; empty `ref` / `file_path` values are rejected at the schema boundary.

### Fixed
- A `MCP_WORKSPACE_PATH` that cannot be canonicalised now fails closed (`WORKSPACE_ROOT_UNAVAILABLE`, with a stderr warning) instead of silently weakening the workspace containment checks.

### Security
- All page-authored text returned to the model — accessibility snapshots, page text, titles, URLs, tab lists, and `browser_evaluate` output — is now wrapped in `<untrusted-content source="…">` envelopes with close-tag breakout escaping (security invariant #6; FOX-3490 remediation).
- CLI-derived error text (`stderr`/`stdout`, which can carry page-authored content including forged envelope close tags) and the short-output text fallback of `browser_screenshot` are now enveloped as untrusted content instead of reaching the model raw. Timeout errors name only the subcommand rather than echoing the full argument vector, which could carry URLs with userinfo, typed values, or evaluation scripts.
- `browser_upload` sources are opened exactly once, verified via `fstat` to be regular files (directories, FIFOs, sockets, and devices are refused), and streamed through that descriptor into a fresh private staging directory (mode 0700) under the canonical workspace root; the CLI consumes only the staged copy, narrowing the check-then-use window between validation and upload to the sub-millisecond realpath-to-open race.
- `browser_pdf` output is written by the CLI into a fresh private staging directory and installed at the validated destination with exclusive-create semantics, so a file or symlink planted at the destination leaf after validation is refused instead of written through.
- `browser_pdf` install now pins the destination directory's canonical identity before the CLI runs (creating the parent up front) and re-verifies it after the CLI call and before writing: an intermediate directory swapped to a symlink during generation is refused with `PATH_OUTSIDE_WORKSPACE` instead of redirecting the write — or, with `overwrite: true`, the preceding delete — outside the workspace.

## [0.1.8] - 2026-07-01

### Changed

- Rework README to explain when to choose this connector, what browser tasks it helps with, and how the visible-by-default session model helps users follow and trust the automation.
- Reworked `README.md` to explain when to choose this connector, what browser tasks it is useful for, and how its visible-by-default session model helps users follow and trust the automation.

## [0.1.7] - 2026-05-14
### Added
- **browser-automation**: Visible by default, gated by AGENT_BROWSER_SHOW_WINDOW. Restores the trust-by-transparency UX (regressed in 0.1.5) so users see Rebel work; hosts can opt out by setting AGENT_BROWSER_SHOW_WINDOW=false.

### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.1.6] - 2026-05-04

### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.
- **registry**: cohort review fixes + Office REBEL_OFFICE_* → MCP_OFFICE_* rename + browser-automation mcpName.

### Fixed
- **browser-automation**: gate browser_evaluate + scheme deny-list (M3.12)

## [0.1.5] - 2026-04-29

### Fixed
- **browser-automation**: Drop --headless injection and fix BINARY_NOT_FOUND mislabeling. Bumps to 0.1.5; agent-browser parses the first positional as the command, so prepending --headless made every CLI call exit 1.

## [0.1.4] - 2026-04-29

### Fixed
- **browser-automation**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.1.4. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

## [0.1.3] - 2026-04-29

### Fixed
- **browser-automation**: Install graceful-fs at boot to mitigate EMFILE bursts. Long-running browser-automation sessions (notably on Windows where the FD/handle ceiling is tight) can exhaust file descriptors; gracefulify retries fs operations on EMFILE/ENFILE.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.1.2] - 2026-04-29

### Added
- **browser-automation**: Port Browser Automation MCP connector to OSS npm package.
