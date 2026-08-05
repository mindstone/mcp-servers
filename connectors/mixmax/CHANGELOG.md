# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- `remove_mixmax_sequence_recipients` — exit specific recipients from a sequence (POST /sequences/:id/cancel); destructiveHint, explicit email list required.
- `cancel_mixmax_message` — recall a scheduled, not-yet-sent message (DELETE /messages/:id); destructiveHint.
- `get_mixmax_report` — analytics over messages, meetings, and per-sequence performance (POST /reports/data/table), with query/groupBy/pagination support.
- `scheduledAt` option on `send_mixmax_snippet` (schedule into the Mixmax Outbox instead of sending immediately) and on `add_mixmax_sequence_recipients` (delayed sequence activation).

### Changed
- External-text fields in tool responses (message subjects/bodies/recipients, snippet names/titles, sequence names and stage content, meeting type names, user name/email, report bucket strings) are now wrapped in `<untrusted-content>` envelopes per the repo's prompt-injection hardening invariant (FOX-3490).
- API responses are validated with Zod at the boundary; unexpected shapes surface a structured `INVALID_API_RESPONSE` error instead of passing garbage through.
- Tool descriptions aligned with the actual Mixmax API response shapes (message recipient/timestamp fields, meeting type `durationMin`/`link`, snippet list fields, and where open/click aggregates actually come from).

### Security
- Vendored envelope helper upgraded to the canonical strong family: every case/whitespace close-tag variant (e.g. `</UNTRUSTED-CONTENT\n>`) is defanged, and `wrapUntrustedJsonStrings` now envelopes object keys as well as values.
- Vendor HTTP error bodies and malformed-body parse diagnostics are never surfaced to the model; they map to fixed safe error messages (`API_ERROR` / `INVALID_API_RESPONSE`). Unknown exceptions return a generic `INTERNAL_ERROR` (details logged to stderr only).
- Response schemas are now strict: `.passthrough()` removed so unrecognised vendor fields are stripped instead of flowing to the model unwrapped. Pagination cursors, meeting-type links, removed-recipient emails, report `totals`/`extra`, and write results (`result`) are now enveloped; wrapped cursors are unwrapped again before being sent back to the API.
- Bridge-state file read hardened: open-once + fstat (regular files only) + read-through-fd, and the content is schema-validated — a non-integer or out-of-range `port` can no longer be interpolated into the loopback bridge URL.

### Fixed
- List/report response collections (`results`, `buckets`, `recipients`) are now required at the validation boundary: a missing collection (e.g. an error-shaped HTTP-200 body) fails closed with `INVALID_API_RESPONSE` instead of silently reporting an empty successful result.

## [0.2.2] - 2026-05-14
### Added
- **registry**: Cohort A backfill — 12 API-key OSS connectors get server.json + mcpName. fathom, humaans, kling, mixmax, nano-banana, napkin, pandadoc, freshdesk, elevenlabs, retell-ai, runway, talentlms each gain a registry-shaped server.json (validated against registry.modelcontextprotocol.io) and an mcpName field on package.json under the io.github.mindstone namespace.

### Fixed
- **mixmax**: destructiveHint:true on add_mixmax_sequence_recipients (M3.8)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.2.1] - 2026-04-29

### Fixed
- **mixmax**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.2.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.2.0] - 2026-04-11

### Added
- **batch1**: add timeout tests for fathom/humaans/mixmax, add all 6 to CI matrix

### Fixed
- **batch1**: fix 5 blocking scrutiny issues from batch-1 review
- **batch1**: bridge error propagation for Fathom/Mixmax/PandaDoc + Zod-before-outbound proof for all 6
- **bridge**: clean brand references from template and batch1 connectors

## [0.1.0] - 2026-04-09

### Added
- **mixmax**: externalize Mixmax MCP connector to standalone package


