# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Security
- `gamma_list_themes` and `gamma_list_folders` now return workspace-authored theme and folder names inside `<untrusted-content>` envelopes with close-tag breakout escaping (repo security invariant #6). IDs, cursors, and keywords remain raw.
- Export downloads now validate the URL before fetching: HTTPS only, no userinfo, private/loopback/reserved hosts rejected, and hosts restricted to `gamma.app` and its subdomains (mirrors napkin's `validateDownloadUrl`). A rejected URL degrades gracefully in `gamma_get_status` — the generation result is returned and the refusal is surfaced in the message.

### Fixed
- Removed a duplicated `### Changed` heading in the 0.3.3 entry.

## [0.3.3] - 2026-07-01

### Changed

- Reworked `README.md` to explain when to choose this local Gamma connector, what creation/export workflows it helps with, and the main setup and safety notes.

## [0.3.2] - 2026-05-14
### Added
- **registry**: backfill Gamma server.json and bake into _template + CI. New connectors inherit a working server.json from the template with mcpName placeholder; CI gate enforces cross-file consistency and runs mcp-publisher validate on every connector with a server.json.

### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.3.1] - 2026-04-29

### Fixed
- **gamma**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.3.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.3.0] - 2026-04-21

### Added
- **connectors**: Harden request timeouts across 4 long-running generation connectors. Follows nano-banana-v0.3.0 (139d488) — same hard-coded 30s timeout class of bug applies to polling-style generation APIs.

## [0.2.0] - 2026-04-11

### Fixed
- **bridge**: clean brand references from batch2 connectors
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys
- **ci**: standardize remaining mock API key fixtures to mcp-test-* pattern

## [0.1.0] - 2026-04-09

### Added
- **gamma**: externalize Gamma MCP connector to standalone package
