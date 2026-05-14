# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- **registry**: Cohort A backfill — 12 API-key OSS connectors get server.json + mcpName. fathom, humaans, kling, mixmax, nano-banana, napkin, pandadoc, freshdesk, elevenlabs, retell-ai, runway, talentlms each gain a registry-shaped server.json (validated against registry.modelcontextprotocol.io) and an mcpName field on package.json under the io.github.mindstone namespace.
- **registry**: cohort review fixes + Office REBEL_OFFICE_* → MCP_OFFICE_* rename + browser-automation mcpName.

### Fixed
- **runway**: sandbox local-file media inputs under RUNWAY_ALLOWED_ROOT (M2.2)
- **runway**: sandbox download_runway_output writes under RUNWAY_DOWNLOAD_ROOT (M2.3)
- **runway**: block SSRF-via-redirect in download_runway_output (M2.4)
- **runway**: refuse non-regular-file existing download targets (M2-fix-2)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

## [0.3.1] - 2026-04-29

### Added
- **runway**: Add RUNWAY_UPLOAD_TIMEOUT_MS for signed-URL upload leg of uploadEphemeral. Stage B follow-up to e1cf9d2 — closes the only bare fetch left in the connector after Stage A.

### Fixed
- **runway**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.3.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.3.0] - 2026-04-21

### Added
- **connectors**: Harden request timeouts across 4 long-running generation connectors. Follows nano-banana-v0.3.0 (139d488) — same hard-coded 30s timeout class of bug applies to polling-style generation APIs.

## [0.2.0] - 2026-04-11

### Fixed
- **batch3**: fix 4 blocking scrutiny issues for runway, workday, quickbooks
- **bridge**: clean brand references from batch2 connectors
- **oss**: standardize mock API key patterns in elevenlabs and runway test fixtures
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys

## [0.1.0] - 2026-04-09

### Added
- **runway**: externalize Runway MCP connector to standalone package


